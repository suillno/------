// ‘요약·결정사항’ 탭: 회의별 최신 AI 요약 목록 (docs/plans/2026-10-19-meeting-features.md 6장). PC·휴대폰 공통.
// 탭을 열 때, 화면에 다시 돌아올 때, PC 분석 완료 신호를 받을 때 다시 읽는다(가져오기 버튼 없음).
// AI 원본과 사용자 편집본을 나눠 보여 준다. 편집은 PC 회의 상세의 편집 화면에서만 한다.

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, formatInZone } from "@meeting/client-core";
import type { MeetingAnalysisState, MeetingSummaryItem } from "@meeting/contracts";
import { Badge, ErrorText, errorMessage } from "../../common";
import { ANALYSIS_UPDATED_EVENT, useApp } from "../../context";
import { MissingMeeting } from "../meetings";

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
    return <SummaryDetail item={current} onBack={() => setSelected(null)} onOpenMeeting={onOpenMeeting} />;
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
  const [state, setState] = useState<MeetingAnalysisState | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getAnalysisState(item.meeting_id).then(
      (s) => alive && setState(s),
      (e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiRequestError && e.code === "NOT_FOUND") setMissing(true);
        else setError(errorMessage(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, item.meeting_id]);

  const result = state?.latest_result ?? null;
  const notes = state?.notes ?? null;
  const userEdited = notes && result && (notes.summary !== result.payload.summary
    || JSON.stringify(notes.decisions) !== JSON.stringify(result.payload.decisions) || notes.source_result_id !== result.id);

  return (
    <div>
      <div className="row between">
        <button type="button" onClick={onBack}>‹ 목록</button>
        {onOpenMeeting && <button type="button" onClick={() => onOpenMeeting(item.meeting_id)}>회의록 열기</button>}
      </div>
      <h3>{item.title}</h3>
      <p className="muted">회의 {formatInZone(item.meeting_at, item.time_zone)} · 분석 {formatTime(item.analyzed_at)}</p>
      {missing && <MissingMeeting />}
      <ErrorText>{error}</ErrorText>
      {result && (
        <section className="panel" aria-label="AI 요약">
          <div className="row between">
            <h4>AI 요약 (원본)</h4>
            {result.stale && <Badge tone="idle">이전 원문 기준</Badge>}
          </div>
          {state?.job?.user_instructions && state.job.id === result.job_id && (
            <p className="muted">요청사항: {state.job.user_instructions}</p>
          )}
          <p className="ai-text">{result.payload.summary || "(요약 없음)"}</p>
          <h4>결정사항</h4>
          {result.payload.decisions.length ? (
            <ul>{result.payload.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
          ) : (
            <p className="muted">결정사항이 없습니다.</p>
          )}
        </section>
      )}
      {notes && (
        <section className="panel" aria-label="사용자 편집본">
          <div className="row between">
            <h4>내 편집본</h4>
            {notes.based_on_current_revision === false && <Badge tone="idle">이전 원문 기준</Badge>}
          </div>
          {!userEdited ? (
            <p className="muted">AI 요약을 그대로 쓰고 있습니다. 편집은 PC의 회의록 화면에서 할 수 있습니다.</p>
          ) : (
            <>
              <p className="ai-text">{notes.summary || "(요약 없음)"}</p>
              {notes.decisions.length > 0 && <ul>{notes.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>}
              <p className="muted">재분석해도 이 편집본은 바뀌지 않습니다.</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
