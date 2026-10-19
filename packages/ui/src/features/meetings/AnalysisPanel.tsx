// '분석 실행'·'재분석'·'재시도' 버튼과 분석 상태·편집본.
// 분석은 이 버튼을 누르고 확인했을 때만 요청한다. 화면을 열거나 저장할 때 자동으로 요청하지 않는다.

import { useMemo, useRef, useState } from "react";
import { SingleFlight, analysisView } from "@meeting/client-core";
import type { MeetingAnalysisState } from "@meeting/contracts";
import { Badge, ConfirmBox, ErrorText, errorMessage, needsRefresh } from "../../common";
import { useApp } from "../../context";
import { InstructionsField, initialInstructions, instructionsIgnored } from "./Instructions";

type Pending = "run" | "rerun" | "retry" | null;

export function AnalysisPanel({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api, runOnThisDevice, pcAnalysisEnabled, platform } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [pending, setPending] = useState<Pending>(null);
  const [confirming, setConfirmingState] = useState<"run" | "rerun" | null>(null);
  const [instructions, setInstructions] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setConfirming = (kind: "run" | "rerun" | null) => {
    if (kind) setInstructions(initialInstructions(state, kind));
    setConfirmingState(kind);
  };
  const view = analysisView(state, pending !== null);
  const key = `analysis:${state.meeting.id}`;

  async function execute(kind: "run" | "rerun" | "retry") {
    setError(null);
    setNotice(null);
    setPending(kind);
    try {
      const job = await flight.run(key, (op) =>
        kind === "retry" && state.job
          ? api.retryAnalysis(op, state.job.id)
          : api.requestAnalysis(op, state.meeting.id, state.meeting.revision_id, kind === "rerun" ? "rerun" : "initial", instructions),
      );
      if (kind !== "retry" && instructionsIgnored(job, instructions)) {
        setNotice("이미 요청된 분석이 있어 새 요청사항은 적용되지 않았습니다. 분석이 끝난 뒤 재분석에서 다시 입력하세요.");
      }
      setConfirming(null);
      if (job.status === "queued") runOnThisDevice?.(job.id);
    } catch (e) {
      setError(errorMessage(e));
      if (needsRefresh(e)) setConfirming(null);
    } finally {
      setPending(null);
      await refresh();
    }
  }

  const isDesktop = Boolean(platform.analysisRunner);
  return (
    <section className="panel" aria-label="AI 분석">
      <div className="row between">
        <h3>AI 분석</h3>
        <Badge tone={view.tone}>{pending ? "요청 중…" : view.statusLabel}</Badge>
      </div>
      {view.message && <p className={view.tone === "error" ? "error" : "muted"}>{view.message}</p>}
      {state.job?.status === "queued" && !isDesktop && (
        <p className="muted">웹에서는 분석을 실행하지 않습니다. 이 요청은 데스크톱 앱(로그인 + 설정의 ‘이 PC에서 분석 실행’ 켜짐)이 처리합니다.</p>
      )}
      {state.job?.status === "queued" && isDesktop && pcAnalysisEnabled && (
        <p className="muted">이 PC가 30초 안에 가져가 분석합니다.</p>
      )}
      {view.tone === "busy" && isDesktop && !pcAnalysisEnabled && (
        <p className="muted">이 PC에서 분석이 꺼져 있습니다. 설정에서 ‘이 PC에서 분석 실행’을 켜거나 다른 PC 앱에서 처리됩니다.</p>
      )}

      {confirming ? (
        <ConfirmBox
          title={confirming === "rerun" ? "재분석" : "분석 실행"}
          confirmLabel={confirming === "rerun" ? "재분석 실행" : "분석 실행"}
          busy={pending !== null}
          onConfirm={() => void execute(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>현재 회의록 원문(제목·본문·회의 날짜)을 PC의 Claude Code로 보내 분석합니다. 원문은 Anthropic 서비스로 전송됩니다.</p>
          {confirming === "rerun" && <p>재분석 결과는 새 결과로만 저장되며, 지금의 요약·결정사항 편집본과 할 일 상태는 바뀌지 않습니다.</p>}
          <InstructionsField value={instructions} onChange={setInstructions} disabled={pending !== null} />
        </ConfirmBox>
      ) : (
        <div className="row">
          {view.buttons.map((b) => (
            <button
              key={b.kind}
              type="button"
              className={b.kind === "retry" ? "primary" : undefined}
              disabled={!b.enabled}
              title={b.reason}
              onClick={() => (b.kind === "retry" ? void execute("retry") : setConfirming(b.kind))}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      {state.job?.user_instructions && !confirming && (
        <p className="muted">요청사항: {state.job.user_instructions}</p>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      <NotesEditor state={state} refresh={refresh} />
    </section>
  );
}

function NotesEditor({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const notes = state.notes;
  const latest = state.latest_result;
  // base: 입력값을 불러온 서버 편집본. 저장 안 한 수정 여부는 base와 비교한다.
  const loaded = { version: notes?.version ?? 0, summary: notes?.summary ?? "", decisions: (notes?.decisions ?? []).join("\n") };
  const [base, setBase] = useState(loaded);
  const [summary, setSummary] = useState(loaded.summary);
  const [decisions, setDecisions] = useState(loaded.decisions);
  const [forceSync, setForceSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<{ summary: boolean; decisions: boolean }>({ summary: true, decisions: true });

  const dirty = summary !== base.summary || decisions !== base.decisions;
  // 서버 편집본이 바뀌면(다른 기기·결과 적용) 저장 안 한 수정이 없을 때만 화면 값을 바꾼다.
  // 저장 안 한 수정이 있으면 덮어쓰지 않고, 저장 시 버전 충돌(409)로 알린다.
  if (loaded.version !== base.version && (!dirty || forceSync)) {
    setBase(loaded);
    setSummary(loaded.summary);
    setDecisions(loaded.decisions);
    setForceSync(false);
  }

  const hasNewResult = useMemo(
    () => Boolean(latest && !latest.stale && latest.id !== notes?.source_result_id),
    [latest, notes?.source_result_id],
  );

  async function save() {
    if (!notes) return;
    setBusy(true);
    setError(null);
    try {
      await flight.run("notes", (op) => api.patchNotes(op, state.meeting.id, base.version, {
        summary, decisions: decisions.split("\n").map((s) => s.trim()).filter(Boolean),
      }));
      setForceSync(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function applyResult() {
    if (!latest) return;
    const selected = (Object.keys(fields) as ("summary" | "decisions")[]).filter((f) => fields[f]);
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await flight.run("apply", (op) => api.applyResult(op, state.meeting.id, base.version, latest.id, selected));
      setForceSync(true); // 적용 결과로 화면 값을 다시 채운다
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!notes && !latest) return null;

  return (
    <div className="notes">
      <div className="row between">
        <h4>요약·결정사항 (편집본)</h4>
        {notes && notes.based_on_current_revision === false && <Badge tone="idle">이전 원문 기준</Badge>}
      </div>
      {notes ? (
        <>
          <label>
            요약
            <textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} disabled={busy} maxLength={4000} />
          </label>
          <label>
            결정사항 (한 줄에 하나)
            <textarea rows={3} value={decisions} onChange={(e) => setDecisions(e.target.value)} disabled={busy} />
          </label>
          <div className="row">
            <button type="button" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "저장 중…" : "편집본 저장"}
            </button>
            {dirty && <span className="muted">저장하지 않은 수정이 있습니다</span>}
          </div>
        </>
      ) : (
        <p className="muted">아직 편집본이 없습니다.</p>
      )}

      {hasNewResult && latest && (
        <div className="new-result">
          <strong>새 AI 결과가 있습니다</strong>
          <p className="muted">편집본은 자동으로 바뀌지 않습니다. 적용할 항목을 골라 ‘새 결과 적용’을 누르세요.</p>
          <p className="ai-text">{latest.payload.summary}</p>
          {latest.payload.decisions.length > 0 && (
            <ul>
              {latest.payload.decisions.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
          <div className="row">
            <label className="inline">
              <input type="checkbox" checked={fields.summary} onChange={(e) => setFields({ ...fields, summary: e.target.checked })} /> 요약
            </label>
            <label className="inline">
              <input type="checkbox" checked={fields.decisions} onChange={(e) => setFields({ ...fields, decisions: e.target.checked })} /> 결정사항
            </label>
            <button type="button" disabled={busy || dirty || (!fields.summary && !fields.decisions)} title={dirty ? "편집본을 먼저 저장하세요" : undefined}
              onClick={() => void applyResult()}>
              새 결과 적용
            </button>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
