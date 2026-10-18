// 회의록 목록·작성·상세. 저장은 회의록만 저장하며 분석을 시작하지 않는다(분석은 'AI 분석'의 버튼으로만).

import { useCallback, useEffect, useRef, useState } from "react";
import { SingleFlight, formatInZone, isValidTimeZone, localToInstant } from "@meeting/client-core";
import type { MeetingRow } from "@meeting/contracts";
import { ErrorText, errorMessage } from "../../common";
import { useApp, useMeetingAnalysis } from "../../context";
import { CandidateList } from "../calendar/CandidateList";
import { AnalysisPanel } from "./AnalysisPanel";

export const meetingsFeature = {
  id: "meetings",
  title: "회의록",
} as const;

export function MeetingsPage() {
  const { api } = useApp();
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const current = meetings?.find((m) => m.id === selected) ?? null;

  return (
    <section>
      <div className="row between">
        <h2>회의록</h2>
        <div className="row">
          <button type="button" onClick={() => void load()}>새로고침</button>
          <button type="button" className="primary" onClick={() => { setCreating(true); setSelected(null); }}>새 회의록</button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>

      <div className="split">
        <ul className="meeting-list" aria-label="회의록 목록">
          {meetings?.length === 0 && <li className="muted">회의록이 없습니다.</li>}
          {meetings?.map((m) => (
            <li key={m.id}>
              <button type="button" aria-current={m.id === selected ? "true" : undefined}
                onClick={() => { setSelected(m.id); setCreating(false); }}>
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
          {current && <MeetingDetail key={current.id} meeting={current} />}
          {!creating && !current && <p className="muted">회의록을 고르거나 새로 작성하세요.</p>}
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

export function NewMeetingForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (m: MeetingRow) => Promise<void> }) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [title, setTitle] = useState("");
  const [at, setAt] = useState(nowLocal);
  const [tz, setTz] = useState(defaultTimeZone);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!isValidTimeZone(tz)) return setError("시간대는 Asia/Seoul 같은 IANA 이름이어야 합니다.");
    const instant = localToInstant(at, tz);
    if (!instant) return setError("해당 시간대에 존재하지 않는 시각입니다. 다시 입력하세요.");
    setBusy(true);
    setError(null);
    try {
      const created = await flight.run("create", (op) => api.createMeeting(op, { title: title.trim(), body, meeting_at: instant, time_zone: tz }));
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
        <label>
          본문
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <p className="muted">저장해도 분석은 시작되지 않습니다. 저장 후 ‘분석 실행’을 눌러야 분석합니다.</p>
        <div className="row">
          <button type="submit" className="primary" disabled={!title.trim()}>{busy ? "저장 중…" : "저장"}</button>
          <button type="button" onClick={onCancel}>취소</button>
        </div>
      </fieldset>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function MeetingDetail({ meeting }: { meeting: MeetingRow }) {
  const { api } = useApp();
  const { state, error, refresh } = useMeetingAnalysis(api, meeting.id);
  return (
    <div>
      <article className="panel">
        <h3>{meeting.title}</h3>
        <p className="muted">{formatInZone(meeting.meeting_at, meeting.time_zone)} ({meeting.time_zone})</p>
        <p className="body-text">{meeting.body || "(본문 없음)"}</p>
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
