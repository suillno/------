// Supabase RPC(PostgREST) 오류 응답을 계약 ApiError로 바꾼다.
// 서버 함수는 app_private.api_error로 code·message와 JSON 문자열 details를 보낸다
// (supabase/migrations/20261017090000_sync_foundation.sql).

import { ERROR_CODES, type ApiError, type ErrorCode } from "@meeting/contracts";

interface PostgrestErrorBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** HTTP 상태로 code를 추정한다. 서버가 계약 code를 주지 않은 경우(권한 오류 등)에 쓴다. */
function codeFromStatus(status: number): ErrorCode {
  if (status === 400) return "VALIDATION_FAILED";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 410) return "CURSOR_EXPIRED";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  return "SERVICE_UNAVAILABLE";
}

function parseDetails(details: unknown): Record<string, unknown> {
  if (typeof details !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(details);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 오류 응답 본문은 신뢰하지 않는 데이터로 다룬다. 알 수 없는 code나 잘못된 타입은 버린다.
 * Postgres 권한 오류(42501)처럼 계약 code가 아닌 응답은 HTTP 상태로 분류한다.
 */
export function toApiError(status: number, body: unknown, requestId: string): ApiError {
  const b: PostgrestErrorBody = body !== null && typeof body === "object" ? body : {};
  const code = isErrorCode(b.code) ? b.code : codeFromStatus(status);
  const message = isErrorCode(b.code) && typeof b.message === "string" ? b.message : "";
  const details = parseDetails(b.details);

  const error: ApiError["error"] = { code, message, request_id: requestId };
  if (Number.isSafeInteger(details.current_version)) {
    error.current_version = details.current_version as number;
  }
  if (typeof details.current_revision_id === "string") {
    error.current_revision_id = details.current_revision_id;
  }
  return { error };
}
