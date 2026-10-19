// Google OAuth·Calendar 호출. 네트워크는 주입한 fetch로만 한다(테스트에서 가짜 Google 사용).
// 참석자 초대·알림은 보내지 않는다(attendees 없음, sendUpdates=none). docs/design.md 10장.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** 사용자 소유 캘린더의 일정만 다루는 최소 scope. 공유 캘린더가 필요하면 calendar.events로 바꾼다(로드맵 미확정). */
export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar.events.owned"];
/** 등록한 일정이 이 앱의 승인에서 나왔는지 확인하는 비공개 속성 키 */
export const APPROVAL_PROPERTY = "meeting_assistant_approval_id";

export interface CandidatePayload {
  title: string;
  start_local: string | null;
  end_local: string | null;
  time_zone: string;
  all_day: boolean;
  evidence: string | null;
  needs_confirmation: boolean;
  description: string | null;
  /** 확인된 목적지명(schema v2). v1 후보·목적지 없는 일정은 없음/null */
  location?: string | null;
  location_uncertain?: boolean;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  fetch: typeof fetch;
  /** 요청 timeout(ms). 기본 15초 */
  timeoutMs?: number;
}

export type GoogleFailureCode = "AUTH_REQUIRED" | "NETWORK" | "GOOGLE_ERROR" | "EVENT_ID_CONFLICT" | "EVENT_DELETED_EXTERNALLY";

export type GoogleResult<T> = { ok: true; value: T } | { ok: false; code: GoogleFailureCode; message: string };

/** 승인 ID(UUID)로 Google event ID를 만든다. base32hex 문자(0-9a-v)만 허용되며 하이픈 제거 UUID는 이를 만족한다. */
export function googleEventIdForApproval(approvalId: string): string {
  const id = approvalId.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("approval_id는 UUID여야 합니다");
  return id;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

function withSeconds(local: string): string {
  return /T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
}

export interface GoogleEventBody {
  id: string;
  summary: string;
  description: string;
  /** 확인된 목적지가 있을 때만 넣는다 */
  location?: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  extendedProperties: { private: Record<string, string> };
}

/** 네이버 지도 검색 링크. 장소 선택·현재 위치 기준 길찾기는 네이버 지도에서 한다(앱은 좌표·경로를 다루지 않는다). */
export function naverMapSearchUrl(location: string): string {
  return `https://map.naver.com/p/search/${encodeURIComponent(location)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** '원본 회의록 보기' 링크. 회의 UUID만 넣는다(본문·토큰 없음). 실제 이동은 open-meeting 함수와 앱 딥링크가 한다. */
export function meetingLinkUrl(functionsBaseUrl: string, meetingId: string): string {
  if (!UUID_RE.test(meetingId)) throw new Error("meeting_id는 UUID여야 합니다");
  return `${functionsBaseUrl.replace(/\/$/, "")}/open-meeting?m=${meetingId}`;
}

export interface EventLinks {
  /** 원본 회의록 링크. 목적지와 관계없이 모든 일정에 넣는다 */
  meetingUrl?: string | null;
}

/**
 * 승인 snapshot을 Google 이벤트로 바꾼다. 서버가 승인 시 시각·목적지 확인을 검증했으므로 여기서는 형식만 변환한다.
 * 종일 일정의 end_local은 마지막 날(포함)이므로 Google의 배타적 종료일로 하루 더한다.
 * 목적지가 있을 때만 장소와 네이버 지도 링크를 넣는다(추측·기본 장소 없음).
 */
export function buildEventBody(payload: CandidatePayload, approvalId: string, links: EventLinks = {}): GoogleEventBody {
  if (!payload.start_local || !payload.end_local) throw new Error("확정되지 않은 일정은 등록할 수 없습니다");
  const location = payload.location && payload.location.trim() ? payload.location.trim() : null;
  const description = [
    payload.description,
    links.meetingUrl ? `원본 회의록 보기: ${links.meetingUrl}` : null,
    location ? `네이버 지도: ${naverMapSearchUrl(location)}` : null,
    payload.evidence ? `회의록 근거: ${payload.evidence}` : null,
    "회의 어시스턴트에서 승인한 일정입니다.",
  ]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n");
  const base = {
    id: googleEventIdForApproval(approvalId),
    summary: payload.title,
    description,
    ...(location ? { location } : {}),
    extendedProperties: { private: { [APPROVAL_PROPERTY]: approvalId } },
  };
  if (payload.all_day) {
    return { ...base, start: { date: payload.start_local }, end: { date: nextDate(payload.end_local) } };
  }
  return {
    ...base,
    start: { dateTime: withSeconds(payload.start_local), timeZone: payload.time_zone },
    end: { dateTime: withSeconds(payload.end_local), timeZone: payload.time_zone },
  };
}

export function buildAuthUrl(cfg: GoogleConfig, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function request(cfg: GoogleConfig, url: string, init: RequestInit): Promise<Response | "network"> {
  try {
    return await cfg.fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000) });
  } catch {
    return "network";
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown };
    const e = body.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  } catch {
    // 본문이 JSON이 아니면 상태 코드만 남긴다
  }
  return `HTTP ${res.status}`;
}

export interface ExchangedTokens {
  refreshToken: string | null;
  scopes: string[];
}

export async function exchangeCode(cfg: GoogleConfig, code: string, codeVerifier: string): Promise<GoogleResult<ExchangedTokens>> {
  const res = await request(cfg, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  if (res === "network") return { ok: false, code: "NETWORK", message: "Google 토큰 교환 응답이 없습니다" };
  if (!res.ok) return { ok: false, code: "GOOGLE_ERROR", message: await readError(res) };
  const body = (await res.json()) as { refresh_token?: string; scope?: string };
  return {
    ok: true,
    value: { refreshToken: body.refresh_token ?? null, scopes: (body.scope ?? "").split(" ").filter(Boolean) },
  };
}

export async function refreshAccessToken(cfg: GoogleConfig, refreshToken: string): Promise<GoogleResult<string>> {
  const res = await request(cfg, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (res === "network") return { ok: false, code: "NETWORK", message: "Google 토큰 갱신 응답이 없습니다" };
  if (!res.ok) {
    const error = await readError(res);
    // invalid_grant: 사용자가 권한을 취소했거나 토큰이 만료됨(C05). 재연결이 필요하며 재시도하지 않는다.
    if (res.status === 400 || res.status === 401) return { ok: false, code: "AUTH_REQUIRED", message: error };
    return { ok: false, code: "GOOGLE_ERROR", message: error };
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) return { ok: false, code: "GOOGLE_ERROR", message: "access_token이 없습니다" };
  return { ok: true, value: body.access_token };
}

export async function revokeToken(cfg: GoogleConfig, token: string): Promise<boolean> {
  const res = await request(cfg, GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return res !== "network" && res.ok;
}

export interface RegisteredEvent {
  googleEventId: string;
  htmlLink: string | null;
  etag: string | null;
  recovered: boolean;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  htmlLink?: string;
  etag?: string;
  extendedProperties?: { private?: Record<string, string> };
}

function eventsUrl(calendarId: string): string {
  return `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
}

async function fetchExisting(
  cfg: GoogleConfig, accessToken: string, calendarId: string, eventId: string,
): Promise<{ kind: "found"; event: GoogleEvent } | { kind: "missing" } | { kind: "error"; code: GoogleFailureCode; message: string }> {
  const res = await request(cfg, `${eventsUrl(calendarId)}/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res === "network") return { kind: "error", code: "NETWORK", message: "Google 조회 응답이 없습니다" };
  if (res.status === 404 || res.status === 410) return { kind: "missing" };
  if (res.status === 401) return { kind: "error", code: "AUTH_REQUIRED", message: await readError(res) };
  if (!res.ok) return { kind: "error", code: "GOOGLE_ERROR", message: await readError(res) };
  return { kind: "found", event: (await res.json()) as GoogleEvent };
}

function recoveredFrom(event: GoogleEvent, approvalId: string, eventId: string): GoogleResult<RegisteredEvent> {
  if (event.extendedProperties?.private?.[APPROVAL_PROPERTY] !== approvalId) {
    // 같은 ID의 이벤트가 이 승인에서 나온 것인지 확인할 수 없으면 성공으로 취급하지 않는다.
    return { ok: false, code: "EVENT_ID_CONFLICT", message: "같은 ID의 다른 일정이 있습니다" };
  }
  if (event.status === "cancelled") {
    return { ok: false, code: "EVENT_DELETED_EXTERNALLY", message: "Google에서 삭제된 일정입니다" };
  }
  return {
    ok: true,
    value: { googleEventId: eventId, htmlLink: event.htmlLink ?? null, etag: event.etag ?? null, recovered: true },
  };
}

/**
 * 결정적 event ID로 events.insert를 호출한다(C03).
 * 409(이미 있음)·timeout·5xx이면 같은 ID로 조회해 승인 ID가 같을 때만 성공으로 복구하고,
 * 없으면 같은 ID로 한 번 더 넣는다. 자동 재시도는 이 한 번뿐이며 나머지는 사용자의 '재시도'를 기다린다.
 */
export async function insertApprovedEvent(
  cfg: GoogleConfig, accessToken: string, calendarId: string, body: GoogleEventBody,
): Promise<GoogleResult<RegisteredEvent>> {
  const approvalId = body.extendedProperties.private[APPROVAL_PROPERTY]!;
  const url = `${eventsUrl(calendarId)}?sendUpdates=none`;
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(cfg, url, init);
    if (res !== "network" && res.ok) {
      const ev = (await res.json()) as GoogleEvent;
      return { ok: true, value: { googleEventId: body.id, htmlLink: ev.htmlLink ?? null, etag: ev.etag ?? null, recovered: false } };
    }
    if (res !== "network" && res.status === 401) {
      return { ok: false, code: "AUTH_REQUIRED", message: await readError(res) };
    }
    if (res !== "network" && res.status === 403) {
      const message = await readError(res);
      const scopeProblem = /insufficient|permission|scope/i.test(message);
      return { ok: false, code: scopeProblem ? "AUTH_REQUIRED" : "GOOGLE_ERROR", message };
    }
    if (res !== "network" && res.status !== 409 && res.status < 500) {
      return { ok: false, code: "GOOGLE_ERROR", message: await readError(res) };
    }

    // 409·5xx·응답 없음: 실제로 만들어졌는지 같은 ID로 확인한다.
    const existing = await fetchExisting(cfg, accessToken, calendarId, body.id);
    if (existing.kind === "found") return recoveredFrom(existing.event, approvalId, body.id);
    if (existing.kind === "error") return { ok: false, code: existing.code, message: existing.message };
    if (res !== "network" && res.status === 409) {
      return { ok: false, code: "EVENT_ID_CONFLICT", message: "Google이 ID 충돌을 보고했지만 일정을 찾을 수 없습니다" };
    }
  }
  return { ok: false, code: "NETWORK", message: "Google Calendar 응답이 없습니다. 재시도하세요" };
}
