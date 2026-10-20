import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiRequestError, type MeetingApi, type Session } from "@meeting/client-core";
import type { GoogleConnectionStatus, MeetingAnalysisState } from "@meeting/contracts";
import { errorMessage } from "./common";
import type { Platform } from "./platform";

export interface AppContextValue {
  api: MeetingApi;
  platform: Platform;
  session: Session;
  google: GoogleConnectionStatus | null;
  refreshGoogle: () => Promise<void>;
  /** 데스크톱에서 '이 PC 분석 허용'이 켜져 있으면 방금 요청한 작업을 바로 실행한다 */
  runOnThisDevice: ((jobId: string) => void) | null;
  pcAnalysisEnabled: boolean;
}

/** PC 에이전트가 작업을 처리했을 때 화면을 다시 읽게 하는 신호 */
export const ANALYSIS_UPDATED_EVENT = "meeting-assistant:analysis-updated";

/** 로그인 상태. undefined는 확인 중, null은 로그아웃 */
export function useSession(api: MeetingApi): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.getSession().then((s) => alive && setSession(s), () => alive && setSession(null));
    const off = api.onAuthChange((s) => setSession(s));
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return session;
}

/** Google 캘린더 연결 상태 */
export function useGoogleConnection(api: MeetingApi) {
  const [google, setGoogle] = useState<GoogleConnectionStatus | null>(null);
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
  return { google, refreshGoogle };
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("AppContext가 없습니다");
  return v;
}

function isBusy(s: MeetingAnalysisState | null): boolean {
  if (!s) return false;
  return s.job?.status === "queued" || s.job?.status === "running"
    || s.candidates.some((c) => c.status === "approved" || c.status === "registering");
}

/** 회의록 분석 상태. 대기·실행·등록 중일 때만 5초마다 다시 읽는다(상태 표시용 조회이며 실행을 시작하지 않는다). */
export function useMeetingAnalysis(api: MeetingApi, meetingId: string) {
  const [state, setState] = useState<MeetingAnalysisState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 삭제됐거나 다른 계정의 회의(404)
  const [missing, setMissing] = useState(false);
  const current = useRef(meetingId);
  current.current = meetingId;

  const refresh = useCallback(async () => {
    try {
      const next = await api.getAnalysisState(meetingId);
      if (current.current === meetingId) {
        setState(next);
        setError(null);
        setMissing(false);
      }
    } catch (e) {
      if (current.current === meetingId) {
        setError(errorMessage(e));
        setMissing(e instanceof ApiRequestError && e.code === "NOT_FOUND");
      }
    }
  }, [api, meetingId]);

  useEffect(() => {
    setState(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUpdate = () => void refresh();
    window.addEventListener(ANALYSIS_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(ANALYSIS_UPDATED_EVENT, onUpdate);
  }, [refresh]);

  const busy = isBusy(state);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [busy, refresh]);

  return { state, error, missing, refresh };
}
