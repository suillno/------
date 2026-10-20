// ‘요약·결정사항’ 탭: 회의별 최신 AI 요약 목록 (docs/plans/2026-10-19-meeting-features.md 6장). PC·휴대폰 공통.
// 탭을 열 때, 화면에 다시 돌아올 때, PC 분석 완료 신호를 받을 때 다시 읽는다(가져오기 버튼 없음).
// AI 원본(읽기 전용)과 사용자 편집본을 나눠 보여 주고, 편집본은 PC·휴대폰 모두 이 화면에서 고칠 수 있다.

import { useCallback, useEffect, useState } from "react";
import { formatInZone } from "@meeting/client-core";
import type { MeetingSummaryItem } from "@meeting/contracts";
import { Badge, ErrorText, errorMessage } from "../../common";
import { ANALYSIS_UPDATED_EVENT, useApp, useMeetingAnalysis } from "../../context";
import { PlainText } from "../../rich/RichView";
import { confirmLeave } from "../../unsaved";
import { MissingMeeting } from "../meetings";
import { NotesEditor, PlainDecisions } from "./NotesEditor";

export const notesFeature = {
  id: "notes",
  title: "요약·결정사항",
} as const;

export function NotesPage({ onOpenMeeting }: { onOpenMeeting?: (meetingId: string) => void } = {}) {
  return (
    <section>
      <h2>요약·결정사항</h2>
      <SummariesView onOpenMeeting={onOpenMeeting} />
    </section>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function SummariesView({ onOpenMeeting }: { onOpenMeeting?: (meetingId: string) => void }) {
  const { api } = useApp();
  const [items, setItems] = useState<MeetingSummaryItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.listSummaries());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const onUpdate = () => void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    window.addEventListener(ANALYSIS_UPDATED_EVENT, onUpdate);
    window.addEventListener("focus", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(ANALYSIS_UPDATED_EVENT, onUpdate);
      window.removeEventListener("focus", onUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // 삭제된 회의는 목록 갱신 때 사라지므로 선택도 풀린다
  const current = items?.find((i) => i.meeting_id === selected) ?? null;

  if (selected && current) {
    return <SummaryDetail item={current} onBack={() => confirmLeave() && setSelected(null)} onOpenMeeting={onOpenMeeting} />;
  }
  return (
    <div>
      <ErrorText>{error}</ErrorText>
      {items === null && <p className="muted">불러오는 중…</p>}
      {items?.length === 0 && <p className="muted">분석이 끝난 회의가 없습니다. 회의록에서 ‘분석 실행’을 누르면 여기에 요약이 나타납니다.</p>}
      <ul className="summary-list">
        {items?.map((i) => (
          <li key={i.meeting_id}>
            <button type="button" onClick={() => setSelected(i.meeting_id)}>
              <span className="row between">
                <span className="title">{i.title}</span>
                {i.stale && <Badge tone="idle">이전 원문 기준</Badge>}
              </span>
              <span className="muted">회의 {formatInZone(i.meeting_at, i.time_zone)} · 분석 {formatTime(i.analyzed_at)}</span>
              <span className="summary-preview">{i.summary_preview || "(요약 없음)"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryDetail({ item, onBack, onOpenMeeting }: {
  item: MeetingSummaryItem;
  onBack: () => void;
  onOpenMeeting?: (meetingId: string) => void;
}) {
  const { api } = useApp();
  const { state, error, missing, refresh } = useMeetingAnalysis(api, item.meeting_id);
  const result = state?.latest_result ?? null;

  return (
    <div>
      <div className="row between">
        <button type="button" onClick={onBack}>‹ 목록</button>
        {onOpenMeeting && <button type="button" onClick={() => confirmLeave() && onOpenMeeting(item.meeting_id)}>회의록 열기</button>}
      </div>
      <h3>{item.title}</h3>
      <p className="muted">회의 {formatInZone(item.meeting_at, item.time_zone)} · 분석 {formatTime(item.analyzed_at)}</p>
      {missing ? <MissingMeeting /> : <ErrorText>{error}</ErrorText>}
      {result && (
        <section className="panel" aria-label="AI 요약">
          <div className="row between">
            <h4>AI 요약 (원본)</h4>
            {result.stale && <Badge tone="idle">이전 원문 기준</Badge>}
          </div>
          {state?.job?.user_instructions && state.job.id === result.job_id && (
            <p className="muted">요청사항: {state.job.user_instructions}</p>
          )}
          <PlainText text={result.payload.summary} />
          <h4>결정사항</h4>
          <PlainDecisions items={result.payload.decisions} />
          <p className="muted">AI 원본은 고칠 수 없습니다. 아래 편집본을 고치세요.</p>
        </section>
      )}
      {state && (
        <section className="panel" aria-label="사용자 편집본">
          <NotesEditor state={state} refresh={refresh} />
        </section>
      )}
    </div>
  );
}
