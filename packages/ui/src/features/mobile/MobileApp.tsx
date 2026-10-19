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
import { MarkdownBody } from "../../markdown";
import { SHARE_EVENT, draftFromShare, type DeviceSettings, type Platform } from "../../platform";
import { LoginForm } from "../auth/LoginForm";
import { CandidateList } from "../calendar/CandidateList";
import { MissingMeeting, NewMeetingForm, type MeetingDraft } from "../meetings";
import { DeleteMeetingButton } from "../meetings/DeleteMeeting";
import { InstructionsField, initialInstructions, instructionsIgnored } from "../meetings/Instructions";
import { SummariesView } from "../notes";
import "../../styles.css";
import "./mobile.css";

type Screen =
  | { name: "list" }
  | { name: "new" }
  | { name: "meeting"; id: string }
  | { name: "schedule" }
  | { name: "summaries" };

// ───────── 공유받은 텍스트 → 작성 중 초안 (docs/plans/2026-10-19-meeting-features.md 5장) ─────────
// 앱 종료·로그인 전에 공유받아도 이 기기에 보관해 두었다가 로그인 후 새 회의 작성 화면에 채운다.
// 저장하거나 취소하면 지운다. 자동 저장·자동 분석은 하지 않는다.

const SETTING_SHARE_DRAFT = "meeting-assistant.share-draft";

function readDraft(settings: DeviceSettings): MeetingDraft | null {
  try {
    const raw = settings.get(SETTING_SHARE_DRAFT);
    if (!raw) return null;
    const d = JSON.parse(raw) as MeetingDraft;
    return typeof d === "object" && d ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(settings: DeviceSettings, draft: MeetingDraft | null) {
  settings.set(SETTING_SHARE_DRAFT, draft ? JSON.stringify(draft) : "");
}

/** 공유 수신함에서 꺼내 초안으로 옮긴다. 새 공유가 있으면 true */
async function collectShare(platform: Platform): Promise<{ added: boolean; notice: string | null }> {
  if (!platform.takeSharedText) return { added: false, notice: null };
  const shared = await platform.takeSharedText().catch(() => null);
  if (!shared) return { added: false, notice: null };
  if (!shared.text && shared.unsupported) return { added: false, notice: shared.unsupported };
  if (!shared.text && !shared.title) return { added: false, notice: null };
  writeDraft(platform.deviceSettings, { ...draftFromShare(shared), source: "공유" });
  return { added: true, notice: shared.unsupported ?? null };
}

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
  const [hasDraft, setHasDraft] = useState(() => readDraft(platform.deviceSettings) !== null);

  // 로그인 전에도 공유를 받아 초안으로 보관한다
  useEffect(() => {
    const take = () => void collectShare(platform).then((r) => r.added && setHasDraft(true));
    take();
    window.addEventListener(SHARE_EVENT, take);
    return () => window.removeEventListener(SHARE_EVENT, take);
  }, [platform]);

  if (session === undefined) return <div className="m-shell"><p className="muted m-pad">로그인 상태 확인 중…</p></div>;
  if (session === null) {
    return (
      <div className="m-shell">
        <header className="m-header"><h1>회의 어시스턴트</h1></header>
        <main className="m-main">
          {hasDraft && <p className="muted">공유받은 메모가 보관되어 있습니다. 로그인하면 새 회의 작성 화면에 채워집니다.</p>}
          <LoginForm api={api} />
        </main>
      </div>
    );
  }
  return <MobileShell key={session.userId} api={api} platform={platform} session={session} />;
}

function MobileShell({ api, platform, session }: { api: MeetingApi; platform: Platform; session: Session }) {
  const { google, refreshGoogle } = useGoogleConnection(api);
  const [draft, setDraft] = useState<MeetingDraft | null>(() => readDraft(platform.deviceSettings));
  const [screen, setScreen] = useState<Screen>(() => (draft ? { name: "new" } : { name: "list" }));
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobSummary>>(new Map());
  const [pending, setPending] = useState<PendingCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 새 공유가 들어오면 작성 화면을 새 내용으로 다시 그린다
  const [draftKey, setDraftKey] = useState(0);

  useEffect(() => {
    const take = () => void collectShare(platform).then((r) => {
      if (r.notice) setNotice(r.notice);
      if (!r.added) return;
      setDraft(readDraft(platform.deviceSettings));
      setDraftKey((k) => k + 1);
      setScreen({ name: "new" });
    });
    window.addEventListener(SHARE_EVENT, take);
    return () => window.removeEventListener(SHARE_EVENT, take);
  }, [platform]);

  // 캘린더 ‘원본 회의록 보기’ 링크: 로그인 전에 받은 것도 여기서 연다
  useEffect(() => {
    const inbox = platform.meetingLinks;
    if (!inbox) return;
    const pendingLink = inbox.take();
    if (pendingLink) setScreen({ name: "meeting", id: pendingLink });
    return inbox.subscribe(() => {
      const id = inbox.take();
      if (id) setScreen({ name: "meeting", id });
    });
  }, [platform]);

  const clearDraft = () => {
    writeDraft(platform.deviceSettings, null);
    setDraft(null);
  };

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
            {screen.name === "list" ? "등록 내역" : screen.name === "new" ? "회의 등록" : screen.name === "schedule" ? "일정 확인"
              : screen.name === "summaries" ? "요약·결정사항" : "회의 내역"}
          </h1>
          {screen.name === "list" && (
            <button type="button" className="m-link" onClick={() => void api.signOut()}>로그아웃</button>
          )}
        </header>

        <main className="m-main">
          <ErrorText>{error}</ErrorText>
          {notice && <p className="muted" role="status">{notice}</p>}
          {screen.name === "list" && (
            <MeetingListScreen meetings={meetings} jobs={jobs} onOpen={(id) => open({ name: "meeting", id })} onRefresh={reload} />
          )}
          {screen.name === "new" && (
            <NewMeetingForm
              key={draftKey}
              initial={draft}
              onDraftChange={(d) => writeDraft(platform.deviceSettings, d)}
              onCancel={() => {
                clearDraft();
                back();
              }}
              onCreated={async (m) => {
                clearDraft();
                await reload();
                open({ name: "meeting", id: m.id });
              }}
            />
          )}
          {screen.name === "meeting" && meeting && (
            <MeetingScreen key={meeting.id} meeting={meeting} onChanged={reload} onDeleted={back} />
          )}
          {screen.name === "meeting" && !meeting && meetings && <MissingMeeting />}
          {screen.name === "meeting" && !meetings && <p className="muted">불러오는 중…</p>}
          {screen.name === "schedule" && (
            <ScheduleScreen meetings={meetings} pending={pending} onOpen={(id) => open({ name: "meeting", id })} onRefresh={reload} />
          )}
          {screen.name === "summaries" && <SummariesView onOpenMeeting={(id) => open({ name: "meeting", id })} />}
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
          <button type="button" aria-current={screen.name === "summaries" ? "page" : undefined} onClick={() => open({ name: "summaries" })}>
            요약
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

function MeetingScreen({ meeting, onChanged, onDeleted }: { meeting: MeetingRow; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const { api } = useApp();
  const { state, error, refresh } = useMeetingAnalysis(api, meeting.id);
  return (
    <>
      <article className="panel">
        <div className="row between">
          <h3>{meeting.title}</h3>
          <DeleteMeetingButton meeting={meeting} onDeleted={onDeleted} />
        </div>
        <p className="muted">{formatInZone(meeting.meeting_at, meeting.time_zone)} ({meeting.time_zone})</p>
        <MarkdownBody source={meeting.body} />
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
  const [confirming, setConfirmingState] = useState<"run" | "rerun" | null>(null);
  // 요청사항 입력란은 버튼 위에 항상 보인다. 이전 분석이 있으면 그때의 요청사항을 불러와 고칠 수 있다.
  const [instructions, setInstructions] = useState(() => initialInstructions(state, "rerun"));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = analysisView(state, pending);
  const jobId = state.job?.id;
  const lastInstructions = state.job?.user_instructions ?? "";
  useEffect(() => {
    setInstructions(lastInstructions);
  }, [jobId, lastInstructions]);
  const setConfirming = setConfirmingState;
  const canRequest = view.buttons.some((b) => (b.kind === "run" || b.kind === "rerun") && b.enabled);

  async function execute(kind: "run" | "rerun" | "retry") {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const job = await flight.run(`analysis:${state.meeting.id}`, (op) =>
        kind === "retry" && state.job
          ? api.retryAnalysis(op, state.job.id)
          : api.requestAnalysis(op, state.meeting.id, state.meeting.revision_id, kind === "rerun" ? "rerun" : "initial", instructions));
      if (kind !== "retry" && instructionsIgnored(job, instructions)) {
        setNotice("이미 요청된 분석이 있어 새 요청사항은 적용되지 않았습니다.");
      }
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
      {state.job?.status === "completed" && <p className="muted">분석이 끝났습니다. 아래 일정을 확인하세요. 요약·결정사항은 ‘요약’ 탭에서 볼 수 있습니다.</p>}
      {state.job?.user_instructions && !confirming && !canRequest && <p className="muted">요청사항: {state.job.user_instructions}</p>}

      {confirming ? (
        <ConfirmBox
          title={confirming === "rerun" ? "재분석 요청" : "분석 요청"}
          confirmLabel="요청"
          busy={pending}
          onConfirm={() => void execute(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>이 회의 원문을 PC의 Claude Code로 분석하도록 요청합니다. 원문은 Anthropic 서비스로 전송됩니다. PC 앱이 켜져 있어야 분석이 진행됩니다.</p>
          <p className="muted">추가 요청사항: {instructions.trim() ? instructions.trim() : "없음 (기존 방식으로 분석)"}</p>
        </ConfirmBox>
      ) : (
        <>
        {canRequest && <InstructionsField value={instructions} onChange={setInstructions} disabled={pending} />}
        <div className="row">
          {view.buttons.filter((b) => b.enabled || !(state.job?.status === "queued" || state.job?.status === "running")).map((b) => (
            <button key={b.kind} type="button" className="primary" disabled={!b.enabled} title={b.reason}
              onClick={() => (b.kind === "retry" ? void execute("retry") : setConfirming(b.kind))}>
              {MOBILE_LABELS[b.kind] ?? b.label}
            </button>
          ))}
        </div>
        </>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
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
