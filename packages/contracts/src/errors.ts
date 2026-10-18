// API 오류 코드 (docs/design.md 12장). HTTP 상태와 1:1 대응하지 않으므로 code로 분기한다.
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  // 삭제(tombstone)된 엔터티를 수정하려 함. 자동 복원하지 않고 사용자 선택을 받는다 (S05)
  ENTITY_DELETED: 409,
  // 클라이언트가 생성한 ID가 이미 쓰이고 있음. 다른 사용자 소유인지 구분하지 않는다
  ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  // 회의록 원문(revision)이 바뀌어 이전 원문 기준 작업·후보를 실행·승인할 수 없음
  STALE_SOURCE: 409,
  // 화면에서 확인한 후보 내용(payload_hash)과 현재 후보가 다름. 다시 확인 후 승인해야 함
  PAYLOAD_CHANGED: 409,
  // 등록 중·등록 완료 후보는 수정·거절할 수 없음
  CANDIDATE_LOCKED: 409,
  GOOGLE_AUTH_REQUIRED: 409,
  JOB_IN_PROGRESS: 409,
  INVALID_STATE: 409,
  LEASE_EXPIRED: 409,
  CURSOR_EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    current_version?: number;
    current_revision_id?: string;
  };
}
