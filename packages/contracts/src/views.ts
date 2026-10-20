// 서버 RPC 응답 형태. 정의: supabase/migrations/20261018090000_analysis_calendar.sql
// 서버 응답은 신뢰하지 않는 데이터이므로 화면은 문자열을 텍스트로만 렌더링한다.

import type { AnalysisResult } from "./analysis";
import type { AnalysisJobStatus, CalendarJobStatus, EventCandidateStatus } from "./status";

export interface MeetingRow {
  id: string;
  title: string;
  body: string;
  meeting_at: string;
  meeting_local_date: string;
  time_zone: string;
  version: number;
  revision_id: string;
  /** 분석 기준 revision. 서식만 바꾸면 그대로다(ADR 0005). 원문 변경 판정은 이 값과 비교한다 */
  analysis_revision_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AnalysisJob {
  id: string;
  meeting_id: string;
  source_revision_id: string;
  run_no: number;
  status: AnalysisJobStatus;
  version: number;
  device_id: string | null;
  lease_until: string | null;
  attempt: number;
  error_code: string | null;
  /** 사용자가 분석 요청 때 입력한 추가 요청사항(없으면 null). 작업 = 분석 이력 단위로 보관 */
  user_instructions: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** analysis_request·analysis_retry 응답에만 있다. 이미 있던 작업을 돌려줬으면 true */
  deduplicated?: boolean;
}

export interface MeetingNotes {
  id: string;
  meeting_id: string;
  summary: string;
  decisions: string[];
  source_result_id: string | null;
  source_revision_id: string | null;
  version: number;
  revision_id: string;
  updated_at: string;
  /** meeting_analysis_state에만 있다. false면 '이전 원문 기준' 표시 */
  based_on_current_revision?: boolean;
}

export interface CandidatePayload {
  title: string;
  start_local: string | null;
  end_local: string | null;
  time_zone: string;
  all_day: boolean;
  evidence: string | null;
  needs_confirmation: boolean;
  description: string | null;
  /** 목적지명(schema v2). v1 후보에는 없다(= null) */
  location?: string | null;
  /** 목적지가 불명확해 승인 전 확인이 필요함 */
  location_uncertain?: boolean;
}

export type CandidatePatch = Partial<Pick<CandidatePayload, "title" | "start_local" | "end_local" | "time_zone" | "all_day" | "description" | "location">>;

/** ‘요약·결정사항’ 탭 목록 항목 (meeting_summaries RPC) */
export interface MeetingSummaryItem {
  meeting_id: string;
  title: string;
  meeting_at: string;
  time_zone: string;
  result_id: string;
  summary_preview: string;
  /** 편집본 요약(없으면 최신 AI 요약) 전체. 화면이 서식을 뺀 글자로 미리보기를 만든다. 이전 서버에는 없다 */
  summary?: string;
  analyzed_at: string;
  /** 분석 뒤 회의록이 바뀌어 이전 원문 기준인 결과 */
  stale: boolean;
  has_user_notes: boolean;
}

export interface CalendarJob {
  id: string;
  approval_id: string;
  candidate_id: string;
  status: CalendarJobStatus;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
}

export interface EventCandidate {
  id: string;
  meeting_id: string;
  result_id: string;
  item_index: number;
  source_revision_id: string;
  version: number;
  content_version: number;
  payload: CandidatePayload;
  payload_hash: string;
  status: EventCandidateStatus;
  last_error_code: string | null;
  /** 원문이 바뀌어 승인할 수 없음 */
  stale: boolean;
  approval_id: string | null;
  calendar_job: CalendarJob | null;
  link: { html_link: string | null; google_event_id: string } | null;
}

export interface LatestResult {
  id: string;
  job_id: string;
  source_revision_id: string;
  stale: boolean;
  created_at: string;
  payload: AnalysisResult;
}

export interface MeetingAnalysisState {
  meeting: { id: string; version: number; revision_id: string; analysis_revision_id: string; deleted: boolean };
  job: AnalysisJob | null;
  latest_result: LatestResult | null;
  notes: MeetingNotes | null;
  candidates: EventCandidate[];
}

export interface GoogleConnectionStatus {
  connected: boolean;
  status: "none" | "active" | "auth_required" | "revoked";
  account_email?: string | null;
  scopes?: string[];
  connected_at?: string;
}

export interface CalendarRegisterOutcome {
  approval_id?: string;
  calendar_job_id: string;
  status: "succeeded" | "running" | "failed";
  error_code?: string;
  html_link?: string | null;
}

/** 작업 실패 사유(analysis_jobs.error_code, calendar_jobs.last_error_code) 표시 문구 */
export const JOB_ERROR_MESSAGES: Record<string, string> = {
  CLI_NOT_FOUND: "이 PC에서 Claude Code CLI를 찾을 수 없습니다.",
  CLI_UNSUPPORTED: "설치된 Claude Code 버전이 안전 실행 옵션을 지원하지 않습니다.",
  AUTH_REQUIRED: "로그인(인증)이 필요합니다. 다시 연결한 뒤 재시도하세요.",
  RATE_LIMITED: "사용 한도에 도달했습니다. 잠시 후 재시도하세요.",
  TIMEOUT: "분석 시간이 초과되었습니다.",
  INVALID_OUTPUT: "AI 출력이 형식 검사를 통과하지 못했습니다.",
  CLI_ERROR: "Claude Code 실행 중 오류가 발생했습니다.",
  LEASE_EXPIRED: "분석하던 PC와 연결이 끊겼습니다.",
  SOURCE_CHANGED: "분석 전에 회의록이 바뀌었습니다. 다시 실행하세요.",
  CANCELLED_BY_DEVICE: "PC에서 분석을 중단했습니다.",
  NETWORK: "Google 응답이 없습니다.",
  GOOGLE_ERROR: "Google Calendar 오류가 발생했습니다.",
  EVENT_ID_CONFLICT: "같은 ID의 다른 일정이 있어 등록하지 않았습니다.",
  EVENT_DELETED_EXTERNALLY: "Google에서 삭제된 일정입니다.",
  CANDIDATE_CHANGED: "후보가 바뀌었습니다. 다시 승인하세요.",
  STALE_SOURCE: "회의록이 바뀌어 등록하지 않았습니다.",
  SERVER_NOT_CONFIGURED: "서버에 Google 연동 설정이 없습니다.",
};

export function jobErrorMessage(code: string | null | undefined): string {
  if (!code) return "알 수 없는 오류가 발생했습니다.";
  return JOB_ERROR_MESSAGES[code] ?? `오류가 발생했습니다 (${code}).`;
}
