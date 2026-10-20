// 회의록 목록·작성·상세. 저장은 회의록만 저장하며 분석을 시작하지 않는다(분석은 'AI 분석'의 버튼으로만).

import { useCallback, useEffect, useRef, useState } from "react";
import { SingleFlight, formatInZone, isValidTimeZone, localToInstant } from "@meeting/client-core";
import type { MeetingRow } from "@meeting/contracts";
import { ErrorText, errorMessage } from "../../common";
import { useApp, useMeetingAnalysis } from "../../context";
import { RichEditor, type RichEditorHandle } from "../../rich/RichEditor";
import { confirmLeave, useUnsavedChanges } from "../../unsaved";
import { CandidateList } from "../calendar/CandidateList";
import { AnalysisPanel } from "./AnalysisPanel";
import { DeleteMeetingButton } from "./DeleteMeeting";
import { MeetingBody } from "./MeetingBody";

export const meetingsFeature = {
  id: "meetings",
  title: "회의록",
} as const;

/** focusMeetingId: 캘린더 '원본 회의록 보기' 링크(딥링크)로 받은 회의. 목록에 없으면 안내한다 */
export function MeetingsPage({ focusMeetingId, onFocusHandled, onOpenSummary }: {
  focusMeetingId?: string | null;
  onFocusHandled?: () => void;
  /** 요약·결정사항 탭에서 이 회의를 연다 */
  onOpenSummary?: (meetingId: string) => void;
} = {}) {
  const { api } = useApp();
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setMeetings(await api.listMeetings());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // 딥링크로 받은 회의: 목록을 읽은 뒤 열고, 없으면(삭제·권한 없음) 안내 화면을 보인다
  useEffect(() => {
    if (!focusMeetingId || !meetings) return;
    const found = meetings.some((m) => m.id === focusMeetingId);
    setCreating(false);
    setSelected(found ? focusMeetingId : null);
    setMissing(!found);
    onFocusHandled?.();
  }, [focusMeetingId, meetings, onFocusHandled]);

  const current = meetings?.find((m) => m.id === selected) ?? null;

  return (
    <section>
      <div className="row between">
        <h2>회의록</h2>
        <div className="row">
          <button type="button" onClick={() => void load()}>새로고침</button>
          <button type="button" className="primary" onClick={() => { if (confirmLeave()) { setCreating(true); setSelected(null); } }}>새 회의록</button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>

      <div className="split">
        <ul className="meeting-list" aria-label="회의록 목록">
          {meetings?.length === 0 && <li className="muted">회의록이 없습니다.</li>}
          {meetings?.map((m) => (
            <li key={m.id}>
              <button type="button" aria-current={m.id === selected ? "true" : undefined}
                onClick={() => { if (m.id !== selected && confirmLeave()) { setSelected(m.id); setCreating(false); setMissing(false); } }}>
                <span className="title">{m.title}</span>
                <span className="muted">{formatInZone(m.meeting_at, m.time_zone)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="detail">
          {creating && (
            <NewMeetingForm
              onCancel={() => setCreating(false)}
              onCreated={async (m) => {
                setCreating(false);
                await load();
                setSelected(m.id);
              }}
            />
          )}
          {missing && !creating && !current && <MissingMeeting />}
          {current && (
            <MeetingDetail key={current.id} meeting={current} onChanged={load} onOpenSummary={onOpenSummary} onDeleted={async () => { setSelected(null); await load(); }} />
          )}
          {!creating && !current && !missing && <p className="muted">회의록을 고르거나 새로 작성하세요.</p>}
        </div>
      </div>
    </section>
  );
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
  } catch {
    return "Asia/Seoul";
  }
}

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** 회의록 → 요약·결정사항 탭의 이 회의. 분석 결과·편집본이 있을 때만 보인다 */
export function OpenSummaryButton({ meetingId, hasSummary, onOpen }: { meetingId: string; hasSummary: boolean; onOpen?: (id: string) => void }) {
  if (!onOpen || !hasSummary) return null;
  return <button type="button" onClick={() => confirmLeave() && onOpen(meetingId)}>요약 보기</button>;
}

/** 회의 링크가 가리키는 회의가 없을 때(삭제됐거나 다른 계정의 회의) */
export function MissingMeeting() {
  return (
    <div className="panel">
      <h3>회의록을 열 수 없습니다</h3>
      <p>삭제됐거나 지금 로그인한 계정으로는 볼 수 없는 회의록입니다.</p>
    </div>
  );
}

export interface MeetingDraft {
  title?: string;
  body?: string;
  /** 어디서 가져왔는지 안내(예: Joplin 공유) */
  source?: string;
}

/**
 * initial: 공유 등으로 미리 채울 값. onDraftChange: 입력이 바뀔 때마다 기기에 초안을 보관(앱 종료·로그인 전에도 유지).
 * 저장은 사용자가 '저장'을 눌렀을 때만 한다(자동 저장·자동 분석 없음).
 */
export function NewMeetingForm({ onCancel, onCreated, initial, onDraftChange }: {
  onCancel: () => void;
  onCreated: (m: MeetingRow) => Promise<void>;
  initial?: MeetingDraft | null;
  onDraftChange?: (draft: MeetingDraft) => void;
}) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [title, setTitleState] = useState(initial?.title ?? "");
  const [at, setAt] = useState(nowLocal);
  const [tz, setTz] = useState(defaultTimeZone);
  const [body, setBodyState] = useState(initial?.body ?? "");
  const bodyRef = useRef<RichEditorHandle>(null);
  const setTitle = (v: string) => { setTitleState(v); onDraftChange?.({ ...initial, title: v, body }); };
  const setBody = (v: string) => { setBodyState(v); onDraftChange?.({ ...initial, title, body: v }); };
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty || title !== (initial?.title ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!isValidTimeZone(tz)) return setError("시간대는 Asia/Seoul 같은 IANA 이름이어야 합니다.");
    const instant = localToInstant(at, tz);
    if (!instant) return setError("해당 시간대에 존재하지 않는 시각입니다. 다시 입력하세요.");
    setBusy(true);
    setError(null);
    try {
      const text = bodyRef.current?.getMarkdown() ?? body;
      const created = await flight.run("create", (op) => api.createMeeting(op, { title: title.trim(), body: text, meeting_at: instant, time_zone: tz }));
      setDirty(false);
      setTitleState(initial?.title ?? "");
      await onCreated(created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>새 회의록</h3>
      {initial?.source && <p className="muted">{initial.source}에서 가져온 내용입니다. 확인·수정한 뒤 저장하세요.</p>}
      <fieldset disabled={busy}>
        <label>
          제목
          <input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row">
          <label>
            회의 일시
            <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          <label>
            시간대
            <input value={tz} onChange={(e) => setTz(e.target.value)} />
          </label>
        </div>
        <RichEditor ref={bodyRef} label="본문" initial={initial?.body ?? ""} disabled={busy} onDirtyChange={setDirty} onValue={setBody} minHeight={200} />
        <p className="muted">저장해도 분석은 시작되지 않습니다. 저장 후 ‘분석 실행’을 눌러야 분석합니다.</p>
        <div className="row">
          <button type="submit" className="primary" disabled={!title.trim()}>{busy ? "저장 중…" : "저장"}</button>
          <button type="button" onClick={() => { if (confirmLeave()) { setDirty(false); setTitleState(initial?.title ?? ""); onCancel(); } }}>취소</button>
        </div>
      </fieldset>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function MeetingDetail({ meeting, onChanged, onDeleted, onOpenSummary }: {
  meeting: MeetingRow;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onOpenSummary?: (meetingId: string) => void;
}) {
  const { api } = useApp();
  const { state, error, refresh } = useMeetingAnalysis(api, meeting.id);
  return (
    <div>
      <article className="panel">
        <div className="row between">
          <h3>{meeting.title}</h3>
          <div className="row">
            <OpenSummaryButton meetingId={meeting.id} hasSummary={Boolean(state?.latest_result || state?.notes)} onOpen={onOpenSummary} />
            <DeleteMeetingButton meeting={meeting} onDeleted={onDeleted} />
          </div>
        </div>
        <p className="muted">{formatInZone(meeting.meeting_at, meeting.time_zone)} ({meeting.time_zone})</p>
        <MeetingBody meeting={meeting} onSaved={async () => { await onChanged(); await refresh(); }} />
      </article>
      <ErrorText>{error}</ErrorText>
      {state && state.meeting.revision_id !== meeting.revision_id && (
        <p className="muted">서버의 회의록이 더 최신입니다. 목록을 새로고침하세요.</p>
      )}
      {state && (
        <>
          <AnalysisPanel state={state} refresh={refresh} />
          <CandidateList state={state} refresh={refresh} />
        </>
      )}
    </div>
  );
}
