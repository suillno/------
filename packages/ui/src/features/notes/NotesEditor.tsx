// 요약·결정사항 편집본 (PC·휴대폰 공통). docs/plans/2026-10-20-rich-text.md 6·7장.
// - AI 원본은 읽기 전용(PlainText). 편집본만 서식 편집기로 고친다.
// - 편집 중에는 자동 갱신·재분석 결과가 편집 내용을 바꾸지 않는다. 새 결과 적용은 사용자가 고를 때만, 버전 검사와 함께.
// - 보이는 글자 4000자(요약)·1000자(결정 항목), 서식 포함 저장 한도를 화면에서 먼저 알리고 자르지 않는다. 서버도 같은 규칙으로 검사한다.

import { useMemo, useRef, useState } from "react";
import { ApiRequestError, LIMITS, SingleFlight, checkNotes, notesIssueMessage, visibleLength } from "@meeting/client-core";
import type { MeetingAnalysisState } from "@meeting/contracts";
import { Badge, ErrorText, errorMessage } from "../../common";
import { useApp } from "../../context";
import { ConflictCompare } from "../../rich/Conflict";
import { DecisionsEditor, RichEditor, type DecisionsEditorHandle, type RichEditorHandle } from "../../rich/RichEditor";
import { PlainText, RichView } from "../../rich/RichView";
import { useUnsavedChanges } from "../../unsaved";

export function DecisionsView({ items, empty = "결정사항이 없습니다." }: { items: readonly string[]; empty?: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return <ul className="rich-decisions">{items.map((d, i) => <li key={i}><RichView source={d} /></li>)}</ul>;
}

/** AI 출력 결정사항(일반 텍스트) */
export function PlainDecisions({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <p className="muted">결정사항이 없습니다.</p>;
  return <ul>{items.map((d, i) => <li key={i} className="ai-text">{d}</li>)}</ul>;
}

export function NotesEditor({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const summaryRef = useRef<RichEditorHandle>(null);
  const decisionsRef = useRef<DecisionsEditorHandle>(null);
  const notes = state.notes;
  const latest = state.latest_result;

  // base: 편집을 시작한 서버 편집본. null이면 보기 상태.
  const [base, setBase] = useState<{ version: number; summary: string; decisions: string[] } | null>(null);
  const [dirty, setDirty] = useState({ summary: false, decisions: false });
  const [draft, setDraft] = useState<{ summary: string; decisions: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ summary: string; decisions: string[] } | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [fields, setFields] = useState<{ summary: boolean; decisions: boolean }>({ summary: true, decisions: true });

  const editing = base !== null;
  const isDirty = dirty.summary || dirty.decisions;
  useUnsavedChanges(editing && isDirty);

  const hasNewResult = useMemo(
    () => Boolean(latest && !latest.stale && latest.id !== notes?.source_result_id),
    [latest, notes?.source_result_id],
  );

  const current = draft ?? (base ? { summary: base.summary, decisions: base.decisions } : null);
  const issues = current ? checkNotes(current.summary, current.decisions) : [];

  const startEdit = (from = notes) => {
    if (!from) return;
    setBase({ version: from.version, summary: from.summary, decisions: [...from.decisions] });
    setDraft(null);
    setDirty({ summary: false, decisions: false });
    setConflict(null);
    setError(null);
    setNotice(null);
    setEditorKey((k) => k + 1);
  };
  const stopEdit = () => {
    setBase(null);
    setDraft(null);
    setDirty({ summary: false, decisions: false });
    setConflict(null);
  };

  const readEditors = () => ({
    summary: summaryRef.current?.getMarkdown() ?? base?.summary ?? "",
    decisions: decisionsRef.current?.getItems() ?? base?.decisions ?? [],
  });

  async function save(version: number) {
    const value = readEditors();
    const found = checkNotes(value.summary, value.decisions);
    if (found.length) {
      setError(found.map(notesIssueMessage).join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch: { summary?: string; decisions?: string[] } = {};
      if (dirty.summary) patch.summary = value.summary;
      if (dirty.decisions) patch.decisions = value.decisions;
      await flight.run(`notes:${state.meeting.id}`, (op) => api.patchNotes(op, state.meeting.id, version, patch));
      setNotice("편집본을 저장했습니다. 재분석해도 이 편집본은 바뀌지 않습니다.");
      stopEdit();
      await refresh();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "VERSION_CONFLICT") {
        setConflict(value);
        await refresh();
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyResult() {
    if (!latest) return;
    const selected = (Object.keys(fields) as ("summary" | "decisions")[]).filter((f) => fields[f]);
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await flight.run("apply", (op) => api.applyResult(op, state.meeting.id, notes?.version ?? 0, latest.id, selected));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!notes && !latest) return null;

  const summaryLen = current ? visibleLength(current.summary) : 0;
  const newerOnServer = editing && notes && notes.version !== base.version;

  return (
    <div className="notes">
      <div className="row between">
        <h4>요약·결정사항 (편집본)</h4>
        {notes && notes.based_on_current_revision === false && <Badge tone="idle">이전 원문 기준</Badge>}
      </div>

      {!notes && <p className="muted">아직 편집본이 없습니다.</p>}

      {notes && !editing && (
        <>
          <RichView source={notes.summary} empty="(요약 없음)" />
          <h5>결정사항</h5>
          <DecisionsView items={notes.decisions} />
          <div className="row">
            <button type="button" onClick={() => startEdit()}>편집</button>
          </div>
        </>
      )}

      {notes && editing && (
        <>
          <RichEditor key={`s${editorKey}`} ref={summaryRef} label="요약" initial={base.summary} disabled={busy}
            onDirtyChange={(d) => setDirty((x) => ({ ...x, summary: d }))}
            onValue={(v) => setDraft((x) => ({ summary: v, decisions: x?.decisions ?? base.decisions }))} />
          <p className={summaryLen > LIMITS.summaryVisible ? "error" : "muted"}>
            보이는 글자 {summaryLen.toLocaleString()} / {LIMITS.summaryVisible.toLocaleString()}자
          </p>
          <DecisionsEditor key={`d${editorKey}`} ref={decisionsRef} label="결정사항 (항목마다 한 줄, Enter로 새 항목)" initial={base.decisions}
            disabled={busy} onDirtyChange={(d) => setDirty((x) => ({ ...x, decisions: d }))}
            onItems={(items) => setDraft((x) => ({ summary: x?.summary ?? base.summary, decisions: items }))} />
          {issues.length > 0 && (
            <ul className="error" role="alert">{issues.map((i, k) => <li key={k}>{notesIssueMessage(i)}</li>)}</ul>
          )}
          {newerOnServer && !conflict && (
            <p className="muted" role="status">다른 기기·새 결과 적용으로 바뀐 최신 편집본이 있습니다. 저장하면 비교 화면이 나옵니다.</p>
          )}
          {conflict ? (
            <ConflictCompare
              busy={busy}
              mine={<><RichView source={conflict.summary} empty="(요약 없음)" /><DecisionsView items={conflict.decisions} /></>}
              theirs={<><RichView source={notes.summary} empty="(요약 없음)" /><DecisionsView items={notes.decisions} /></>}
              onUseLatest={() => startEdit(notes)}
              onSaveMine={() => {
                setConflict(null);
                void save(notes.version);
              }}
            />
          ) : (
            <div className="row">
              <button type="button" className="primary" disabled={!isDirty || busy || issues.length > 0} onClick={() => void save(base.version)}>
                {busy ? "저장 중…" : "편집본 저장"}
              </button>
              <button type="button" disabled={busy} onClick={() => {
                if (!isDirty || window.confirm("저장하지 않은 편집을 버릴까요?")) stopEdit();
              }}>취소</button>
              {isDirty && <span className="muted">저장하지 않은 편집이 있습니다</span>}
            </div>
          )}
        </>
      )}
      {notice && <p className="ok" role="status">{notice}</p>}

      {hasNewResult && latest && (
        <div className="new-result">
          <strong>새 AI 결과가 있습니다</strong>
          <p className="muted">편집본은 자동으로 바뀌지 않습니다. 적용할 항목을 골라 ‘새 결과 적용’을 누르세요.</p>
          <PlainText text={latest.payload.summary} />
          <PlainDecisions items={latest.payload.decisions} />
          <div className="row">
            <label className="inline">
              <input type="checkbox" checked={fields.summary} onChange={(e) => setFields({ ...fields, summary: e.target.checked })} /> 요약
            </label>
            <label className="inline">
              <input type="checkbox" checked={fields.decisions} onChange={(e) => setFields({ ...fields, decisions: e.target.checked })} /> 결정사항
            </label>
            <button type="button" disabled={busy || editing || (!fields.summary && !fields.decisions)}
              title={editing ? "편집을 먼저 저장하거나 취소하세요" : undefined} onClick={() => void applyResult()}>
              새 결과 적용
            </button>
          </div>
          {editing && <p className="muted">편집 중에는 새 결과를 적용할 수 없습니다. 먼저 저장하거나 취소하세요.</p>}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
