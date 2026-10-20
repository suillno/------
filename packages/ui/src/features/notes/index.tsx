// ‘요약·결정사항’ 탭: 회의별 최신 AI 요약 목록 (docs/plans/2026-10-19-meeting-features.md 6장). PC·휴대폰 공통.
// 탭을 열 때, 화면에 다시 돌아올 때, PC 분석 완료 신호를 받을 때 다시 읽는다(가져오기 버튼 없음).
// 상세에는 편집본만 보여 준다(AI 원본은 편집본의 출발점이며 따로 보이지 않는다). 편집본은 PC·휴대폰 모두 여기서 고친다.
// 회의록 화면의 ‘요약 보기’로 들어오면 그 회의의 상세를 바로 연다(focusMeetingId).

import { useCallback, useEffect, useState } from "react";
import { formatInZone } from "@meeting/client-core";
import type { MeetingSummaryItem } from "@meeting/contracts";
import { Badge, ErrorText, errorMessage } from "../../common";
import { ANALYSIS_UPDATED_EVENT, useApp, useMeetingAnalysis } from "../../context";
import { confirmLeave } from "../../unsaved";
import { MissingMeeting } from "../meetings";
import { NotesEditor } from "./NotesEditor";

export const notesFeature = {
  id: "notes",
  title: "요약·결정사항",
} as const;

interface SummariesProps {
  onOpenMeeting?: (meetingId: string) => void;
  /** 이 회의의 상세를 바로 연다(회의록 화면의 ‘요약 보기’) */
  focusMeetingId?: string | null;
  onFocusHandled?: () => void;
}

export function NotesPage(props: SummariesProps = {}) {
  return (
    <section>
      <h2>요약·결정사항</h2>
      <SummariesView {...props} />
    </section>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function SummariesView({ onOpenMeeting, focusMeetingId, onFocusHandled }: SummariesProps) {
  const { api } = useApp();
  const [items, setItems] = useState<MeetingSummaryItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(focusMeetingId ?? null);

  useEffect(() => {
    if (!focusMeetingId) return;
    setSelected(focusMeetingId);
    onFocusHandled?.();
  }, [focusMeetingId, onFocusHandled]);
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
  return (
    <div>
      <div className="row between">
        <button type="button" onClick={onBack}>‹ 목록</button>
        {onOpenMeeting && <button type="button" onClick={() => confirmLeave() && onOpenMeeting(item.meeting_id)}>회의록 열기</button>}
      </div>
      <h3>{item.title}</h3>
      <p className="muted">회의 {formatInZone(item.meeting_at, item.time_zone)} · 분석 {formatTime(item.analyzed_at)}</p>
      {missing ? <MissingMeeting /> : <ErrorText>{error}</ErrorText>}
      {state && (
        <section className="panel" aria-label="사용자 편집본">
          <NotesEditor state={state} refresh={refresh} />
        </section>
      )}
    </div>
  );
}
