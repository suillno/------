// 회의 본문 보기·수정 (PC·휴대폰 공통). docs/plans/2026-10-20-rich-text.md 5·7장.
// 저장은 meeting-save가 AI에 전달되는 텍스트가 바뀌었는지 판정한다. 서식만 바꾸면 기존 분석 결과·일정 후보를 유지한다.
// 편집 중에는 서버 갱신이 편집 내용을 덮어쓰지 않는다. 충돌하면 입력을 보존하고 나란히 비교한다.

import { useRef, useState } from "react";
import { ApiRequestError, SingleFlight } from "@meeting/client-core";
import type { MeetingRow } from "@meeting/contracts";
import { ErrorText, errorMessage } from "../../common";
import { useApp } from "../../context";
import { ConflictCompare } from "../../rich/Conflict";
import { RichEditor, type RichEditorHandle } from "../../rich/RichEditor";
import { RichView } from "../../rich/RichView";
import { useUnsavedChanges } from "../../unsaved";

const MAX_BODY_BYTES = 1_000_000;

export function MeetingBody({ meeting, onSaved }: { meeting: MeetingRow; onSaved: () => Promise<void> }) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const editorRef = useRef<RichEditorHandle>(null);
  // base: 편집을 시작한 서버 버전. 저장·충돌 판정은 이 값 기준이다.
  const [base, setBase] = useState<{ version: number; body: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);

  const editing = base !== null;
  useUnsavedChanges(editing && dirty);

  const start = () => {
    setBase({ version: meeting.version, body: meeting.body });
    setDirty(false);
    setError(null);
    setNotice(null);
    setConflict(null);
    setEditorKey((k) => k + 1);
  };

  const stop = () => {
    setBase(null);
    setDirty(false);
    setConflict(null);
  };

  async function save(version: number) {
    const body = editorRef.current?.getMarkdown() ?? meeting.body;
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      setError("본문이 너무 큽니다(1MB 초과). 내용을 줄여 주세요. 입력한 내용은 그대로 두었습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await flight.run(`body:${meeting.id}`, (op) => api.patchMeeting(op, meeting.id, version, { body }));
      setNotice(saved.analysis_changed
        ? "저장했습니다. 내용이 바뀌어 기존 분석 결과·일정 후보는 ‘원문 변경’이 됩니다. 필요하면 다시 분석하세요."
        : "저장했습니다. 서식만 바뀌어 기존 분석 결과와 일정 후보는 그대로 유지됩니다.");
      stop();
      await onSaved();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "VERSION_CONFLICT") {
        // 입력은 그대로 두고 서버 최신 내용을 받아 나란히 보여 준다
        setConflict(body);
        await onSaved();
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="meeting-body">
        <RichView source={meeting.body} />
        <div className="row">
          <button type="button" onClick={start}>본문 수정</button>
        </div>
        {notice && <p className="ok" role="status">{notice}</p>}
      </div>
    );
  }

  const newerOnServer = meeting.version !== base.version;
  return (
    <div className="meeting-body">
      <RichEditor key={editorKey} ref={editorRef} label="본문" initial={base.body} disabled={busy} onDirtyChange={setDirty} minHeight={200} />
      <p className="muted">
        굵게·밑줄·글자색만 바꾸면 기존 분석 결과와 일정 후보가 그대로 유지됩니다. 글자·링크·표·목록 내용이 바뀌면 ‘원문 변경’이 됩니다.
        저장해도 분석은 시작되지 않습니다.
      </p>
      {newerOnServer && !conflict && <p className="muted" role="status">다른 기기에서 바뀐 최신 내용이 있습니다. 저장하면 비교 화면이 나옵니다.</p>}
      {conflict !== null ? (
        <ConflictCompare
          busy={busy}
          mine={<RichView source={conflict} />}
          theirs={<RichView source={meeting.body} />}
          onUseLatest={() => {
            setBase({ version: meeting.version, body: meeting.body });
            setConflict(null);
            setDirty(false);
            setEditorKey((k) => k + 1);
          }}
          onSaveMine={() => {
            setConflict(null);
            void save(meeting.version);
          }}
        />
      ) : (
        <div className="row">
          <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save(base.version)}>
            {busy ? "저장 중…" : "저장"}
          </button>
          <button type="button" disabled={busy} onClick={() => {
            if (!dirty || window.confirm("저장하지 않은 편집을 버릴까요?")) stop();
          }}>취소</button>
          {dirty && <span className="muted">저장하지 않은 편집이 있습니다</span>}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
