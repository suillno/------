// UI가 서버에 접근하는 유일한 인터페이스와 Supabase 구현.
// 브라우저 번들에는 공개 anon 키만 들어간다. 쓰기는 모두 RLS·버전 검사를 하는 RPC나 Edge Function을 거친다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisJob,
  AnalysisResult,
  ApiError,
  CalendarRegisterOutcome,
  CandidatePatch,
  EventCandidate,
  GoogleConnectionStatus,
  MeetingAnalysisState,
  MeetingNotes,
  MeetingRow,
} from "@meeting/contracts";
import { toApiError } from "./rpcError";

export class ApiRequestError extends Error {
  constructor(
    /** null이면 네트워크 오류(응답 없음) */
    readonly status: number | null,
    readonly apiError: ApiError,
  ) {
    super(apiError.error.message || apiError.error.code);
  }
  get code() {
    return this.apiError.error.code;
  }
}

export interface Session {
  userId: string;
  email: string | null;
}

export interface NewMeeting {
  title: string;
  body: string;
  /** 오프셋 포함 RFC 3339 */
  meeting_at: string;
  time_zone: string;
}

export interface ClaimedAnalysis {
  job: AnalysisJob;
  lease_token: string;
  input: {
    meeting_id: string;
    source_revision_id: string;
    title: string;
    body: string;
    meeting_at: string;
    meeting_local_date: string;
    time_zone: string;
  };
}

export interface AnalysisMetadata {
  engine_version: string;
  prompt_version: string;
  input_hash: string;
}

/** 확인이 필요한 일정 후보 요약 (휴대폰 ‘일정 확인’ 탭) */
export interface PendingCandidate {
  id: string;
  meeting_id: string;
  status: "needs_review" | "approved" | "failed";
  title: string;
  start_local: string | null;
  all_day: boolean;
}

/** 회의별 최신 분석 작업 요약 (휴대폰 등록 내역 배지) */
export interface JobSummary {
  id: string;
  meeting_id: string;
  source_revision_id: string;
  status: AnalysisJob["status"];
  error_code: string | null;
  lease_until: string | null;
  requested_at: string;
}

export interface MeetingApi {
  getSession(): Promise<Session | null>;
  onAuthChange(listener: (session: Session | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;

  listMeetings(): Promise<MeetingRow[]>;
  createMeeting(operationId: string, input: NewMeeting): Promise<MeetingRow>;

  getAnalysisState(meetingId: string): Promise<MeetingAnalysisState>;
  /** 검토 필요·등록 대기·등록 실패 후보 목록. 원문 변경(stale) 여부는 회의 화면에서 다시 계산한다 */
  listPendingCandidates(): Promise<PendingCandidate[]>;
  /** 회의별 최신 분석 작업 (requested_at 최신순, 회의당 1건) */
  listLatestJobs(): Promise<JobSummary[]>;
  /** '분석 실행'(initial)·'재분석'(rerun) 버튼 */
  requestAnalysis(operationId: string, meetingId: string, sourceRevisionId: string, mode: "initial" | "rerun"): Promise<AnalysisJob>;
  /** 분석 '재시도' 버튼 */
  retryAnalysis(operationId: string, jobId: string): Promise<AnalysisJob>;
  patchNotes(operationId: string, meetingId: string, baseVersion: number, patch: { summary?: string; decisions?: string[] }): Promise<MeetingNotes>;
  applyResult(operationId: string, meetingId: string, baseVersion: number, resultId: string, fields: ("summary" | "decisions")[]): Promise<MeetingNotes>;

  patchCandidate(operationId: string, candidateId: string, baseVersion: number, patch: CandidatePatch): Promise<EventCandidate>;
  rejectCandidate(operationId: string, candidateId: string, baseVersion: number): Promise<EventCandidate>;
  /** '승인하고 캘린더 등록' 버튼. 화면에 보인 version·payload_hash로 승인한다 */
  approveAndRegister(operationId: string, candidate: Pick<EventCandidate, "id" | "version" | "payload_hash">): Promise<CalendarRegisterOutcome>;
  /** 캘린더 등록 '재시도' 버튼 */
  retryCalendarJob(operationId: string, jobId: string): Promise<CalendarRegisterOutcome>;

  getGoogleConnection(): Promise<GoogleConnectionStatus>;
  /** Google 동의 화면 주소를 받는다 */
  startGoogleConnect(returnPath: string): Promise<string>;
  disconnectGoogle(): Promise<void>;

  // PC 분석 에이전트(데스크톱)용
  claimAnalysis(deviceId: string, jobId?: string): Promise<ClaimedAnalysis | null>;
  heartbeatAnalysis(jobId: string, leaseToken: string): Promise<void>;
  submitAnalysisResult(jobId: string, leaseToken: string, sourceRevisionId: string, payload: AnalysisResult, metadata: AnalysisMetadata): Promise<{ result_id: string; stale: boolean }>;
  submitAnalysisFailure(jobId: string, leaseToken: string, errorCode: string): Promise<void>;
}

function networkError(requestId: string, message: string): ApiRequestError {
  return new ApiRequestError(null, { error: { code: "SERVICE_UNAVAILABLE", message, request_id: requestId } });
}

export interface SupabaseApiOptions {
  url: string;
  anonKey: string;
  /** 세션 저장소. 기본은 supabase-js 기본값(브라우저 localStorage) — 저장 방식은 로드맵 미확정 */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

export function createSupabaseMeetingApi(opts: SupabaseApiOptions): MeetingApi {
  const client: SupabaseClient = createClient(opts.url, opts.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storage: opts.storage },
  });

  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const requestId = crypto.randomUUID();
    let res;
    try {
      res = await client.rpc(fn, args);
    } catch (e) {
      throw networkError(requestId, String(e));
    }
    if (res.error) {
      // supabase-js는 응답이 없으면 status 0을 준다
      if (!res.status) throw networkError(requestId, res.error.message);
      throw new ApiRequestError(res.status, toApiError(res.status, res.error, requestId));
    }
    return res.data as T;
  }

  async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    const requestId = crypto.randomUUID();
    const { data, error } = await client.functions.invoke(fn, { body });
    if (!error) return data as T;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      let parsed: unknown = null;
      try {
        parsed = await context.json();
      } catch {
        parsed = null;
      }
      throw new ApiRequestError(context.status, toApiError(context.status, parsed, requestId));
    }
    throw networkError(requestId, error.message);
  }

  const toSession = (s: { user: { id: string; email?: string | null } } | null): Session | null =>
    s ? { userId: s.user.id, email: s.user.email ?? null } : null;

  return {
    async getSession() {
      const { data } = await client.auth.getSession();
      return toSession(data.session);
    },
    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => listener(toSession(session)));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new ApiRequestError(error.status ?? 400, toApiError(error.status ?? 400, { message: error.message }, crypto.randomUUID()));
    },
    async signUp(email, password) {
      const { error } = await client.auth.signUp({ email, password });
      if (error) throw new ApiRequestError(error.status ?? 400, toApiError(error.status ?? 400, { message: error.message }, crypto.randomUUID()));
    },
    async signOut() {
      await client.auth.signOut();
    },

    async listMeetings() {
      const requestId = crypto.randomUUID();
      const { data, error, status } = await client.from("meetings").select("*")
        .is("deleted_at", null).order("meeting_at", { ascending: false }).order("id", { ascending: false }).limit(100);
      if (error) {
        if (!status) throw networkError(requestId, error.message);
        throw new ApiRequestError(status, toApiError(status, error, requestId));
      }
      return data as MeetingRow[];
    },
    createMeeting(operationId, input) {
      return call("meeting_create", {
        p_operation_id: operationId, p_id: crypto.randomUUID(), p_title: input.title, p_body: input.body,
        p_meeting_at: input.meeting_at, p_time_zone: input.time_zone,
      });
    },

    getAnalysisState(meetingId) {
      return call("meeting_analysis_state", { p_meeting_id: meetingId });
    },
    async listLatestJobs() {
      const requestId = crypto.randomUUID();
      const { data, error, status } = await client.from("analysis_jobs")
        .select("id, meeting_id, source_revision_id, status, error_code, lease_until, requested_at")
        .order("requested_at", { ascending: false }).limit(500);
      if (error) {
        if (!status) throw networkError(requestId, error.message);
        throw new ApiRequestError(status, toApiError(status, error, requestId));
      }
      const seen = new Set<string>();
      return (data as JobSummary[]).filter((j) => !seen.has(j.meeting_id) && seen.add(j.meeting_id));
    },
    async listPendingCandidates() {
      const requestId = crypto.randomUUID();
      const { data, error, status } = await client.from("event_candidates")
        .select("id, meeting_id, status, payload")
        .in("status", ["needs_review", "approved", "failed"]).is("deleted_at", null)
        .order("created_at", { ascending: false }).limit(200);
      if (error) {
        if (!status) throw networkError(requestId, error.message);
        throw new ApiRequestError(status, toApiError(status, error, requestId));
      }
      return (data as { id: string; meeting_id: string; status: PendingCandidate["status"]; payload: { title?: unknown; start_local?: unknown; all_day?: unknown } }[])
        .map((r) => ({
          id: r.id,
          meeting_id: r.meeting_id,
          status: r.status,
          title: typeof r.payload.title === "string" ? r.payload.title : "",
          start_local: typeof r.payload.start_local === "string" ? r.payload.start_local : null,
          all_day: r.payload.all_day === true,
        }));
    },
    requestAnalysis(operationId, meetingId, sourceRevisionId, mode) {
      return call("analysis_request", { p_operation_id: operationId, p_meeting_id: meetingId, p_source_revision_id: sourceRevisionId, p_mode: mode });
    },
    retryAnalysis(operationId, jobId) {
      return call("analysis_retry", { p_operation_id: operationId, p_job_id: jobId });
    },
    patchNotes(operationId, meetingId, baseVersion, patch) {
      return call("meeting_notes_patch", { p_operation_id: operationId, p_meeting_id: meetingId, p_base_version: baseVersion, p_patch: patch });
    },
    applyResult(operationId, meetingId, baseVersion, resultId, fields) {
      return call("meeting_notes_apply_result", {
        p_operation_id: operationId, p_meeting_id: meetingId, p_base_version: baseVersion, p_result_id: resultId, p_fields: fields,
      });
    },

    patchCandidate(operationId, candidateId, baseVersion, patch) {
      return call("candidate_patch", { p_operation_id: operationId, p_id: candidateId, p_base_version: baseVersion, p_patch: patch });
    },
    rejectCandidate(operationId, candidateId, baseVersion) {
      return call("candidate_reject", { p_operation_id: operationId, p_id: candidateId, p_base_version: baseVersion });
    },
    approveAndRegister(operationId, candidate) {
      return invoke("calendar-register", {
        operation_id: operationId, candidate_id: candidate.id, base_version: candidate.version, payload_hash: candidate.payload_hash,
      });
    },
    retryCalendarJob(operationId, jobId) {
      return invoke("calendar-retry", { operation_id: operationId, job_id: jobId });
    },

    getGoogleConnection() {
      return call("google_connection_status", {});
    },
    async startGoogleConnect(returnPath) {
      const res = await invoke<{ url: string }>("google-oauth-start", { return_path: returnPath });
      return res.url;
    },
    async disconnectGoogle() {
      await invoke("google-disconnect", {});
    },

    claimAnalysis(deviceId, jobId) {
      return call("analysis_claim", { p_device_id: deviceId, p_job_id: jobId ?? null });
    },
    async heartbeatAnalysis(jobId, leaseToken) {
      await call("analysis_heartbeat", { p_job_id: jobId, p_lease_token: leaseToken });
    },
    submitAnalysisResult(jobId, leaseToken, sourceRevisionId, payload, metadata) {
      return call("analysis_submit_result", {
        p_job_id: jobId, p_lease_token: leaseToken, p_source_revision_id: sourceRevisionId, p_payload: payload, p_metadata: metadata,
      });
    },
    async submitAnalysisFailure(jobId, leaseToken, errorCode) {
      await call("analysis_submit_failure", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: errorCode });
    },
  };
}
