// 안드로이드 휴대폰 앱 화면 (docs/plans/mobile-android.md 3장).
// 회의 등록 / 등록 내역 / 내역 상세(분석 요청·재시도) / 일정 확인만 둔다. 분석 결과 편집 화면은 PC 앱에 있다.
// 휴대폰은 분석을 실행하지 않는다. 분석 요청만 서버에 남기고 PC가 처리한다.
// 캘린더 등록은 사용자가 ‘승인하고 캘린더 등록’을 눌러 승인한 후보만 한다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SingleFlight,
  analysisView,
  formatInZone,
  jobBadge,
  type JobSummary,
  type MeetingApi,
  type PendingCandidate,
  type Session,
} from "@meeting/client-core";
import type { MeetingAnalysisState, MeetingRow } from "@meeting/contracts";
import { Badge, ConfirmBox, ErrorText, errorMessage } from "../../common";
import { AppContext, useApp, useGoogleConnection, useMeetingAnalysis, useSession, type AppContextValue } from "../../context";
import type { Platform } from "../../platform";
import { LoginForm } from "../auth/LoginForm";
import { CandidateList } from "../calendar/CandidateList";
import { NewMeetingForm } from "../meetings";
import "../../styles.css";
import "./mobile.css";

type Screen = { name: "list" } | { name: "new" } | { name: "meeting"; id: string } | { name: "schedule" };

export function MobileApp({ platform }: { platform: Platform }) {
  if (!platform.api) {
    return (
      <div className="m-shell">
        <p className="error m-pad">서버 설정(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)이 없습니다.</p>
      </div>
    );
  }
  return <MobileSession api={platform.api} platform={platform} />;
}

function MobileSession({ api, platform }: { api: MeetingApi; platform: Platform }) {
  const session = useSession(api);
  if (session === undefined) return <div className="m-shell"><p className="muted m-pad">로그인 상태 확인 중…</p></div>;
  if (session === null) {
    return (
      <div className="m-shell">
        <header className="m-header"><h1>회의 어시스턴트</h1></header>
        <main className="m-main"><LoginForm api={api} /></main>
      </div>
    );
  }
  return <MobileShell key={session.userId} api={api} platform={platform} session={session} />;
}

function MobileShell({ api, platform, session }: { api: MeetingApi; platform: Platform; session: Session }) {
  const { google, refreshGoogle } = useGoogleConnection(api);
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobSummary>>(new Map());
  const [pending, setPending] = useState<PendingCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, j, p] = await Promise.all([api.listMeetings(), api.listLatestJobs(), api.listPendingCandidates()]);
      setMeetings(m);
      setJobs(new Map(j.map((x) => [x.meeting_id, x])));
      setPending(p);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ctx: AppContextValue = useMemo(
    () => ({ api, platform, session, google, refreshGoogle, runOnThisDevice: null, pcAnalysisEnabled: false }),
    [api, platform, session, google, refreshGoogle],
  );

  const open = (s: Screen) => {
    setScreen(s);
    window.scrollTo(0, 0);
  };
  const back = () => {
    open({ name: "list" });
    void reload();
  };
  const meeting = screen.name === "meeting" ? meetings?.find((m) => m.id === screen.id) ?? null : null;
  const reviewCount = pending.filter((c) => c.status === "needs_review" || c.status === "failed").length;

  return (
    <AppContext.Provider value={ctx}>
      <div className="m-shell">
        <header className="m-header">
          {screen.name === "meeting" || screen.name === "new" ? (
            <button type="button" className="m-back" onClick={back} aria-label="뒤로">‹</button>
          ) : null}
          <h1>
            {screen.name === "list" ? "등록 내역" : screen.name === "new" ? "회의 등록" : screen.name === "schedule" ? "일정 확인" : "회의 내역"}
          </h1>
          {screen.name === "list" && (
            <button type="button" className="m-link" onClick={() => void api.signOut()}>로그아웃</button>
          )}
        </header>

        <main className="m-main">
          <ErrorText>{error}</ErrorText>
          {screen.name === "list" && (
            <MeetingListScreen meetings={meetings} jobs={jobs} onOpen={(id) => open({ name: "meeting", id })} onRefresh={reload} />
          )}
          {screen.name === "new" && (
            <NewMeetingForm
              onCancel={back}
              onCreated={async (m) => {
                await reload();
                open({ name: "meeting", id: m.id });
              }}
            />
          )}
          {screen.name === "meeting" && meeting && <MeetingScreen key={meeting.id} meeting={meeting} onChanged={reload} />}
          {screen.name === "meeting" && !meeting && <p className="muted">회의록을 찾을 수 없습니다.</p>}
          {screen.name === "schedule" && (
            <ScheduleScreen meetings={meetings} pending={pending} onOpen={(id) => open({ name: "meeting", id })} onRefresh={reload} />
          )}
        </main>

        <nav className="m-tabs" aria-label="메뉴">
          <button type="button" aria-current={screen.name === "list" || screen.name === "meeting" ? "page" : undefined}
            onClick={() => { open({ name: "list" }); void reload(); }}>
            등록 내역
          </button>
          <button type="button" aria-current={screen.name === "new" ? "page" : undefined} onClick={() => open({ name: "new" })}>
            회의 등록
          </button>
          <button type="button" aria-current={screen.name === "schedule" ? "page" : undefined}
            onClick={() => { open({ name: "schedule" }); void reload(); }}>
            일정 확인{reviewCount > 0 && <span className="m-count">{reviewCount}</span>}
          </button>
        </nav>
      </div>
    </AppContext.Provider>
  );
}

function MeetingListScreen(props: {
  meetings: MeetingRow[] | null;
  jobs: Map<string, JobSummary>;
  onOpen: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  if (!props.meetings) return <p className="muted">불러오는 중…</p>;
  return (
    <>
      <div className="row between">
        <span className="muted">{props.meetings.length}건</span>
        <button type="button" onClick={() => void props.onRefresh()}>새로고침</button>
      </div>
      {props.meetings.length === 0 && <p className="muted">등록한 회의가 없습니다. 아래 ‘회의 등록’을 누르세요.</p>}
      <ul className="m-list">
        {props.meetings.map((m) => {
          const badge = jobBadge(props.jobs.get(m.id), m.revision_id);
          return (
            <li key={m.id}>
              <button type="button" onClick={() => props.onOpen(m.id)}>
                <span className="m-list-main">
                  <span className="title">{m.title}</span>
                  <span className="muted">{formatInZone(m.meeting_at, m.time_zone)}</span>
                </span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const MOBILE_LABELS: Record<string, string> = { run: "분석 요청", rerun: "재분석 요청", retry: "재시도" };

function MeetingScreen({ meeting, onChanged }: { meeting: MeetingRow; onChanged: () => Promise<void> }) {
  const { api } = useApp();
  const { state, error, refresh } = useMeetingAnalysis(api, meeting.id);
  return (
    <>
      <article className="panel">
        <h3>{meeting.title}</h3>
        <p className="muted">{formatInZone(meeting.meeting_at, meeting.time_zone)} ({meeting.time_zone})</p>
        <p className="body-text">{meeting.body || "(본문 없음)"}</p>
      </article>
      <ErrorText>{error}</ErrorText>
      {state && <AnalysisRequest state={state} refresh={async () => { await refresh(); await onChanged(); }} />}
      {state && state.job?.status === "completed" && state.candidates.length === 0 && (
        <p className="muted m-pad">분석 결과에 일정 후보가 없습니다.</p>
      )}
      {state && <CandidateList state={state} refresh={async () => { await refresh(); await onChanged(); }} />}
    </>
  );
}

/** 분석 요청·재시도 버튼과 상태. 요약 편집 화면은 PC 앱에만 있다. */
function AnalysisRequest({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<"run" | "rerun" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = analysisView(state, pending);

  async function execute(kind: "run" | "rerun" | "retry") {
    setPending(true);
    setError(null);
    try {
      await flight.run(`analysis:${state.meeting.id}`, (op) =>
        kind === "retry" && state.job
          ? api.retryAnalysis(op, state.job.id)
          : api.requestAnalysis(op, state.meeting.id, state.meeting.revision_id, kind === "rerun" ? "rerun" : "initial"));
      setConfirming(null);
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(null);
    } finally {
      setPending(false);
      await refresh();
    }
  }

  return (
    <section className="panel" aria-label="분석">
      <div className="row between">
        <h3>분석</h3>
        <Badge tone={view.tone}>{pending ? "요청 중…" : view.statusLabel}</Badge>
      </div>
      {state.job?.status === "queued" && <p className="muted">PC 앱이 켜져 있으면 곧 분석합니다. 이 화면은 자동으로 새로 고쳐집니다.</p>}
      {state.job?.status === "running" && <p className="muted">PC에서 분석하고 있습니다.</p>}
      {view.tone === "error" && view.message && <p className="error">{view.message}</p>}
      {state.job?.status === "completed" && <p className="muted">분석이 끝났습니다. 아래 일정을 확인하세요. 요약·결정사항은 PC 앱에서 볼 수 있습니다.</p>}

      {confirming ? (
        <ConfirmBox
          title={confirming === "rerun" ? "재분석 요청" : "분석 요청"}
          confirmLabel="요청"
          busy={pending}
          onConfirm={() => void execute(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>이 회의 원문을 PC의 Claude Code로 분석하도록 요청합니다. 원문은 Anthropic 서비스로 전송됩니다. PC 앱이 켜져 있어야 분석이 진행됩니다.</p>
        </ConfirmBox>
      ) : (
        <div className="row">
          {view.buttons.filter((b) => b.enabled || !(state.job?.status === "queued" || state.job?.status === "running")).map((b) => (
            <button key={b.kind} type="button" className="primary" disabled={!b.enabled} title={b.reason}
              onClick={() => (b.kind === "retry" ? void execute("retry") : setConfirming(b.kind))}>
              {MOBILE_LABELS[b.kind] ?? b.label}
            </button>
          ))}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

function ScheduleScreen(props: {
  meetings: MeetingRow[] | null;
  pending: PendingCandidate[];
  onOpen: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { google } = useApp();
  const byMeeting = useMemo(() => {
    const map = new Map<string, PendingCandidate[]>();
    for (const c of props.pending) map.set(c.meeting_id, [...(map.get(c.meeting_id) ?? []), c]);
    return map;
  }, [props.pending]);
  const title = (id: string) => props.meetings?.find((m) => m.id === id)?.title ?? "회의";
  const label: Record<PendingCandidate["status"], string> = { needs_review: "확인 필요", approved: "등록 대기", failed: "등록 실패" };

  return (
    <>
      {google && !google.connected && (
        <p className="error">Google 캘린더가 연결되어 있지 않습니다. PC 앱의 설정에서 연결한 뒤 등록할 수 있습니다.</p>
      )}
      <div className="row between">
        <span className="muted">확인할 일정 {props.pending.length}건</span>
        <button type="button" onClick={() => void props.onRefresh()}>새로고침</button>
      </div>
      {props.pending.length === 0 && <p className="muted">확인할 일정이 없습니다.</p>}
      {[...byMeeting.entries()].map(([meetingId, items]) => (
        <section key={meetingId} className="panel">
          <h3>{title(meetingId)}</h3>
          <ul className="m-list">
            {items.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => props.onOpen(meetingId)}>
                  <span className="m-list-main">
                    <span className="title">{c.title}</span>
                    <span className="muted">{c.start_local ? c.start_local.replace("T", " ").slice(0, 16) + (c.all_day ? " (종일)" : "") : "날짜 미정"}</span>
                  </span>
                  <Badge tone={c.status === "failed" ? "error" : c.status === "approved" ? "busy" : "idle"}>{label[c.status]}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
