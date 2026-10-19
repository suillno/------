// 회의록 영구 삭제 버튼과 확인창 (docs/plans/2026-10-19-meeting-features.md 1장).
// 확인창에서 '영구 삭제'를 눌러야만 지운다. 휴지통·복원은 없다. Google에 등록된 일정은 남는다.

import { useRef, useState } from "react";
import { SingleFlight } from "@meeting/client-core";
import type { MeetingRow } from "@meeting/contracts";
import { ConfirmBox, ErrorText, errorMessage } from "../../common";
import { useApp } from "../../context";

export function DeleteMeetingButton({ meeting, onDeleted, compact }: {
  meeting: Pick<MeetingRow, "id" | "title" | "version">;
  onDeleted: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [confirming, setConfirming] = useState(false);
  const [registered, setRegistered] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setError(null);
    setConfirming(true);
    setRegistered(null);
    try {
      const state = await api.getAnalysisState(meeting.id);
      setRegistered(state.candidates.filter((c) => c.status === "registered").length);
    } catch {
      setRegistered(null);
    }
  }

  async function purge() {
    setBusy(true);
    setError(null);
    try {
      await flight.run(`purge:${meeting.id}`, (op) => api.purgeMeeting(op, meeting.id, meeting.version));
      setConfirming(false);
      await onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className={compact ? "danger-link" : "danger"} onClick={(e) => { e.stopPropagation(); void open(); }}
        aria-label={`${meeting.title} 삭제`}>
        삭제
      </button>
    );
  }
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <ConfirmBox title="회의록 영구 삭제" confirmLabel="영구 삭제" busy={busy} onConfirm={() => void purge()} onCancel={() => setConfirming(false)}>
        <p><strong>{meeting.title}</strong></p>
        <p>회의록과 분석 결과·요약 편집본·일정 후보가 모두 지워지며 되돌릴 수 없습니다.</p>
        {registered === null ? (
          <p className="muted">등록된 일정 확인 중…</p>
        ) : registered > 0 ? (
          <p>Google 캘린더에 등록된 일정 <strong>{registered}건</strong>은 그대로 남습니다. 필요하면 캘린더에서 직접 지우세요.</p>
        ) : (
          <p className="muted">Google 캘린더에 등록된 일정은 없습니다.</p>
        )}
      </ConfirmBox>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
