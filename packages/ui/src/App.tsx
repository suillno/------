import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalysisAgentLoop, type MeetingApi, type Session } from "@meeting/client-core";
import type { GoogleConnectionStatus } from "@meeting/contracts";
import { ANALYSIS_UPDATED_EVENT, AppContext, useSession, type AppContextValue } from "./context";
import { LoginForm } from "./features/auth/LoginForm";
import { CalendarPage, calendarFeature } from "./features/calendar";
import { MeetingsPage, meetingsFeature } from "./features/meetings";
import { NotesPage, notesFeature } from "./features/notes";
import { SettingsPage, settingsFeature } from "./features/settings";
import { TasksPage, tasksFeature } from "./features/tasks";
import { SETTING_DEVICE_ID, SETTING_PC_ANALYSIS, type Platform, type PlatformStatus } from "./platform";
import "./styles.css";

const FEATURES = [meetingsFeature, notesFeature, tasksFeature, calendarFeature, settingsFeature] as const;
type FeatureId = (typeof FEATURES)[number]["id"];

export function App({ platform }: { platform: Platform }) {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    platform.getStatus().then(setStatus, (e: unknown) => setStatusError(String(e)));
  }, [platform]);

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>회의 어시스턴트</h1>
        <span className="status">
          {status ? `${status.kind} · ${status.environment} · v${status.appVersion}` : (statusError ?? "상태 확인 중…")}
        </span>
      </header>
      {platform.api ? (
        <SessionGate api={platform.api} platform={platform} />
      ) : (
        <p className="error">서버 설정(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)이 없습니다. .env.example을 참고해 .env.local을 만드세요.</p>
      )}
      {status?.diagnostics && (
        <dl className="diagnostics">
          {Object.entries(status.diagnostics).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function SessionGate({ api, platform }: { api: MeetingApi; platform: Platform }) {
  const session = useSession(api);
  if (session === undefined) return <p className="muted">로그인 상태 확인 중…</p>;
  if (session === null) return <LoginForm api={api} />;
  return <MainShell key={session.userId} api={api} platform={platform} session={session} />;
}

function deviceId(platform: Platform): string {
  const existing = platform.deviceSettings.get(SETTING_DEVICE_ID);
  if (existing) return existing;
  const id = `pc-${crypto.randomUUID()}`;
  platform.deviceSettings.set(SETTING_DEVICE_ID, id);
  return id;
}

/** OAuth 콜백이 붙인 ?google=... 를 읽고 주소에서 지운다 */
function takeOAuthResult(): string | null {
  try {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google");
    if (result) {
      url.searchParams.delete("google");
      window.history.replaceState(null, "", url.toString());
    }
    return result;
  } catch {
    return null;
  }
}

function MainShell({ api, platform, session }: { api: MeetingApi; platform: Platform; session: Session }) {
  const [oauthResult] = useState(takeOAuthResult);
  const [active, setActive] = useState<FeatureId>(() =>
    oauthResult || window.location.pathname.startsWith("/settings") ? "settings" : "meetings");
  const [google, setGoogle] = useState<GoogleConnectionStatus | null>(null);
  const [pcAnalysisEnabled, setPcAnalysisEnabled] = useState(() => platform.deviceSettings.get(SETTING_PC_ANALYSIS) === "1");
  const loopRef = useRef<AnalysisAgentLoop | null>(null);
  // 캘린더 ‘원본 회의록 보기’ 링크·요약 목록에서 연 회의
  const [focusMeetingId, setFocusMeetingId] = useState<string | null>(null);
  const openMeeting = useCallback((id: string) => {
    setFocusMeetingId(id);
    setActive("meetings");
  }, []);
  const clearFocus = useCallback(() => setFocusMeetingId(null), []);

  // 로그인 전에 받은 링크는 기기에 보관돼 있다가 여기서 열린다
  useEffect(() => {
    const inbox = platform.meetingLinks;
    if (!inbox) return;
    const pending = inbox.take();
    if (pending) openMeeting(pending);
    return inbox.subscribe(() => {
      const id = inbox.take();
      if (id) openMeeting(id);
    });
  }, [platform, openMeeting]);

  const refreshGoogle = useCallback(async () => {
    try {
      setGoogle(await api.getGoogleConnection());
    } catch {
      setGoogle(null);
    }
  }, [api]);

  useEffect(() => {
    void refreshGoogle();
  }, [refreshGoogle]);

  useEffect(() => {
    const onChange = () => setPcAnalysisEnabled(platform.deviceSettings.get(SETTING_PC_ANALYSIS) === "1");
    window.addEventListener("meeting-assistant:settings", onChange);
    return () => window.removeEventListener("meeting-assistant:settings", onChange);
  }, [platform]);

  // 데스크톱 + '이 PC에서 분석 실행' 허용일 때만 사용자가 요청한 대기 작업을 처리한다.
  // 앱 시작 시에는 바로 실행하지 않고, 사용자가 이 화면에서 허용을 켠 순간에만 즉시 한 번 확인한다.
  const enabledAtStart = useRef(pcAnalysisEnabled);
  useEffect(() => {
    const runner = platform.analysisRunner;
    if (!runner || !pcAnalysisEnabled) {
      enabledAtStart.current = false;
      return;
    }
    const loop = new AnalysisAgentLoop(api, runner, {
      userId: session.userId,
      deviceId: deviceId(platform),
      // 처리 결과를 열려 있는 회의록 화면에 바로 반영한다
      onStart: () => window.dispatchEvent(new Event(ANALYSIS_UPDATED_EVENT)),
      onResult: (r) => r !== "idle" && window.dispatchEvent(new Event(ANALYSIS_UPDATED_EVENT)),
    });
    loop.start();
    loopRef.current = loop;
    if (!enabledAtStart.current) void loop.tick();
    enabledAtStart.current = false;
    return () => {
      loop.stop();
      loopRef.current = null;
    };
  }, [api, platform, session.userId, pcAnalysisEnabled]);

  const ctx: AppContextValue = useMemo(() => ({
    api,
    platform,
    session,
    google,
    refreshGoogle,
    pcAnalysisEnabled,
    runOnThisDevice: platform.analysisRunner && pcAnalysisEnabled ? (jobId: string) => void loopRef.current?.tick(jobId) : null,
  }), [api, platform, session, google, refreshGoogle, pcAnalysisEnabled]);

  return (
    <AppContext.Provider value={ctx}>
      <nav className="shell-nav">
        {FEATURES.map((f) => (
          <button key={f.id} type="button" aria-current={f.id === active ? "page" : undefined} onClick={() => setActive(f.id)}>
            {f.title}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted nav-user">{session.email}</span>
        <button type="button" onClick={() => void api.signOut()}>로그아웃</button>
      </nav>
      <main className="shell-main">
        {active === "meetings" && <MeetingsPage focusMeetingId={focusMeetingId} onFocusHandled={clearFocus} />}
        {active === "notes" && <NotesPage onOpenMeeting={openMeeting} />}
        {active === "tasks" && <TasksPage />}
        {active === "calendar" && <CalendarPage />}
        {active === "settings" && <SettingsPage oauthResult={oauthResult} />}
      </main>
    </AppContext.Provider>
  );
}
