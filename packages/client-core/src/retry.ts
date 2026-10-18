// 동기화 요청 실패 분류와 재시도 지연 (docs/design.md 6장 "트리거와 순서").

export type FailureAction =
  | { kind: "retry"; delayMs: number }
  | { kind: "refresh_token" }
  | { kind: "stop_forbidden" }
  | { kind: "conflict" }
  | { kind: "full_resync" }
  | { kind: "fail" };

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/** 지수 백오프 + full jitter. attempt는 0부터 시작한다. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 5 * 60_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/** Retry-After 헤더(초 또는 HTTP 날짜)를 ms로 변환한다. 해석 불가하면 null. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value == null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** status가 null이면 네트워크 오류로 본다. */
export function classifyFailure(
  status: number | null,
  attempt: number,
  retryAfter: string | null = null,
  opts: BackoffOptions = {},
): FailureAction {
  if (status === null || status === 429 || status >= 500) {
    const hinted = parseRetryAfter(retryAfter);
    const delayMs = Math.max(hinted ?? 0, backoffDelay(attempt, opts));
    return { kind: "retry", delayMs };
  }
  if (status === 401) return { kind: "refresh_token" };
  if (status === 403) return { kind: "stop_forbidden" };
  if (status === 409) return { kind: "conflict" };
  if (status === 410) return { kind: "full_resync" };
  return { kind: "fail" };
}
