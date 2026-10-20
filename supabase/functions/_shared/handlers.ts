// Edge Function 요청 처리. 각 함수의 index.ts는 환경변수를 읽어 여기로 넘기기만 한다.
// 비밀값(service role, Google client secret, 토큰 암호화 키)은 이 서버 코드에서만 쓰고
// 응답·로그에 넣지 않는다. 사용자 요청의 소유권은 사용자 JWT로 호출하는 RPC가 검사한다.

import { decryptSecret, encryptSecret, importTokenKey, pkceChallenge, randomBase64Url, sha256Hex } from "./crypto.ts";
import {
  DEFAULT_SCOPES,
  buildAuthUrl,
  buildEventBody,
  meetingLinkUrl,
  exchangeCode,
  insertApprovedEvent,
  refreshAccessToken,
  revokeToken,
  type CandidatePayload,
  type GoogleConfig,
} from "./google.ts";
import { RpcError, getUserId, rpc, type SupabaseEndpoint } from "./postgrest.ts";

export interface ServerEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Google OAuth 비밀이 설정되지 않았으면 null. 이때 연결·등록은 503 */
  google: Omit<GoogleConfig, "fetch"> | null;
  tokenEncryptionKey: string | undefined;
  /**
   * OAuth 완료 후 돌아갈 웹 앱 origin (예: 로컬 웹 개발 http://localhost:5173).
   * null이면 웹 호스팅 없이 콜백이 완료 안내 문구를 직접 응답한다(docs/plans/mobile-android.md 6.1).
   */
  appWebOrigin: string | null;
  allowedOrigins: string[];
  /**
   * 이용자가 여는 Edge Function 기본 주소(https://<project>.supabase.co/functions/v1).
   * 일정 설명의 '원본 회의록 보기' 링크에 쓴다. 새 비밀 없이 GOOGLE_OAUTH_REDIRECT_URI에서 만든다.
   */
  functionsBaseUrl: string | null;
  fetch: typeof fetch;
}

/** OAuth 콜백 주소(…/functions/v1/google-oauth-callback)에서 공개 함수 기본 주소를 만든다. 형식이 다르면 null */
export function functionsBaseUrlFrom(redirectUri: string | undefined): string | null {
  return redirectUri && /\/functions\/v1\/[^/]+$/.test(redirectUri) ? redirectUri.replace(/\/[^/]+$/, "") : null;
}

export function loadServerEnv(get: (name: string) => string | undefined, fetchImpl: typeof fetch = fetch): ServerEnv {
  const required = (name: string) => {
    const v = get(name);
    if (!v) throw new Error(`${name} 환경변수가 없습니다`);
    return v;
  };
  const clientId = get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = get("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = get("GOOGLE_OAUTH_REDIRECT_URI");
  const scopes = (get("GOOGLE_OAUTH_SCOPES") ?? "").split(/\s+/).filter(Boolean);
  const webOrigin = get("APP_WEB_ORIGIN");
  const appWebOrigin = webOrigin ? new URL(webOrigin).origin : null;
  return {
    supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
    anonKey: required("SUPABASE_ANON_KEY"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    google: clientId && clientSecret && redirectUri
      ? { clientId, clientSecret, redirectUri, scopes: scopes.length ? scopes : DEFAULT_SCOPES }
      : null,
    tokenEncryptionKey: get("TOKEN_ENCRYPTION_KEY"),
    functionsBaseUrl: functionsBaseUrlFrom(redirectUri),
    appWebOrigin,
    allowedOrigins: [
      ...(appWebOrigin ? [appWebOrigin] : []),
      ...(get("APP_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ],
    fetch: fetchImpl,
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function corsHeaders(req: Request, env: ServerEnv): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !env.allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(req: Request, env: ServerEnv, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, env) },
  });
}

export function apiError(req: Request, env: ServerEnv, status: number, code: string, message: string): Response {
  return json(req, env, status, { code, message, details: null, hint: null });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization");
  return h && h.startsWith("Bearer ") ? h.slice(7) : null;
}

export function userEndpoint(env: ServerEnv, token: string): SupabaseEndpoint {
  return { url: env.supabaseUrl, apiKey: env.anonKey, bearer: token, fetch: env.fetch };
}

export function serviceEndpoint(env: ServerEnv): SupabaseEndpoint {
  return { url: env.supabaseUrl, apiKey: env.serviceRoleKey, bearer: env.serviceRoleKey, fetch: env.fetch };
}

function googleConfig(env: ServerEnv): GoogleConfig | null {
  return env.google ? { ...env.google, fetch: env.fetch } : null;
}

/** POST + 사용자 인증 공통 처리. 실패하면 Response, 성공하면 사용자 정보와 본문 */
export async function authenticatedPost(
  req: Request, env: ServerEnv,
): Promise<Response | { token: string; userId: string; body: Record<string, unknown> }> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  if (req.method !== "POST") return apiError(req, env, 405, "VALIDATION_FAILED", "POST만 허용합니다.");
  const token = bearer(req);
  if (!token) return apiError(req, env, 401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  const userId = await getUserId(userEndpoint(env, token));
  if (!userId) return apiError(req, env, 401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(req, env, 400, "VALIDATION_FAILED", "JSON 본문이 필요합니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "JSON 객체가 필요합니다.");
  }
  return { token, userId, body: body as Record<string, unknown> };
}

export function rpcFailure(req: Request, env: ServerEnv, e: unknown): Response {
  if (e instanceof RpcError) return json(req, env, e.status, e.body);
  return apiError(req, env, 503, "SERVICE_UNAVAILABLE", "서버 처리 중 오류가 발생했습니다.");
}

// ───────────────────────── 캘린더 등록 ─────────────────────────

export interface CalendarJobOutcome {
  status: "succeeded" | "running" | "failed";
  error_code?: string;
  html_link?: string | null;
}

type ClaimResult =
  | { ok: false; error_code: string; html_link?: string | null }
  | {
      ok: true;
      job_id: string;
      lease_token: string;
      approval_id: string;
      meeting_id: string;
      calendar_id: string;
      payload: CandidatePayload;
      refresh_token_ciphertext: string;
    };

/**
 * 승인된 등록 작업 하나를 처리한다. 사용자가 '승인하고 캘린더 등록'·'재시도'를 누른 요청 안에서만 호출한다.
 * DB가 직전에 승인·후보 version·원문 revision·연결 상태를 다시 검사한다(svc_calendar_job_claim).
 */
export async function processCalendarJob(env: ServerEnv, userId: string, jobId: string): Promise<CalendarJobOutcome> {
  const svc = serviceEndpoint(env);
  const claim = await rpc<ClaimResult>(svc, "svc_calendar_job_claim", { p_user_id: userId, p_job_id: jobId });
  if (!claim.ok) {
    if (claim.error_code === "ALREADY_SUCCEEDED") return { status: "succeeded", html_link: claim.html_link ?? null };
    if (claim.error_code === "JOB_IN_PROGRESS") return { status: "running" };
    return { status: "failed", error_code: claim.error_code };
  }

  const fail = async (code: string, message: string): Promise<CalendarJobOutcome> => {
    await rpc(svc, "svc_calendar_job_fail", {
      p_job_id: claim.job_id, p_lease_token: claim.lease_token, p_error_code: code, p_message: message,
    });
    return { status: "failed", error_code: code };
  };

  const cfg = googleConfig(env);
  if (!cfg || !env.tokenEncryptionKey) return fail("SERVER_NOT_CONFIGURED", "Google 연동 서버 설정이 없습니다");

  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(await importTokenKey(env.tokenEncryptionKey), claim.refresh_token_ciphertext);
  } catch {
    return fail("AUTH_REQUIRED", "저장된 Google 토큰을 읽을 수 없습니다. 다시 연결하세요");
  }

  const access = await refreshAccessToken(cfg, refreshToken);
  if (!access.ok) return fail(access.code, access.message);

  const result = await insertApprovedEvent(cfg, access.value, claim.calendar_id, buildEventBody(claim.payload, claim.approval_id, {
    meetingUrl: env.functionsBaseUrl ? meetingLinkUrl(env.functionsBaseUrl, claim.meeting_id) : null,
  }));
  if (!result.ok) return fail(result.code, result.message);

  await rpc(svc, "svc_calendar_job_complete", {
    p_job_id: claim.job_id,
    p_lease_token: claim.lease_token,
    p_google_event_id: result.value.googleEventId,
    p_html_link: result.value.htmlLink,
    p_etag: result.value.etag,
  });
  return { status: "succeeded", html_link: result.value.htmlLink };
}

/** POST calendar-register: { operation_id, candidate_id, base_version, payload_hash } */
export async function handleCalendarRegister(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const { operation_id, candidate_id, base_version, payload_hash } = auth.body;
  if (typeof operation_id !== "string" || !UUID.test(operation_id) || typeof candidate_id !== "string" || !UUID.test(candidate_id)
      || !Number.isSafeInteger(base_version) || typeof payload_hash !== "string") {
    return apiError(req, env, 400, "VALIDATION_FAILED", "operation_id, candidate_id, base_version, payload_hash가 필요합니다.");
  }
  if (!env.google || !env.tokenEncryptionKey) {
    return apiError(req, env, 503, "SERVICE_UNAVAILABLE", "Google 연동 서버 설정이 없습니다.");
  }
  try {
    const approved = await rpc<{ approval_id: string; calendar_job: { id: string; status: string } }>(
      userEndpoint(env, auth.token), "candidate_approve",
      { p_operation_id: operation_id, p_id: candidate_id, p_base_version: base_version, p_payload_hash: payload_hash },
    );
    const outcome = approved.calendar_job.status === "succeeded"
      ? { status: "succeeded" as const }
      : approved.calendar_job.status === "failed"
        ? { status: "failed" as const, error_code: "RETRY_REQUIRED" }
        : await processCalendarJob(env, auth.userId, approved.calendar_job.id);
    return json(req, env, 200, { approval_id: approved.approval_id, calendar_job_id: approved.calendar_job.id, ...outcome });
  } catch (e) {
    return rpcFailure(req, env, e);
  }
}

/** POST calendar-retry: { operation_id, job_id } */
export async function handleCalendarRetry(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const { operation_id, job_id } = auth.body;
  if (typeof operation_id !== "string" || !UUID.test(operation_id) || typeof job_id !== "string" || !UUID.test(job_id)) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "operation_id, job_id가 필요합니다.");
  }
  if (!env.google || !env.tokenEncryptionKey) {
    return apiError(req, env, 503, "SERVICE_UNAVAILABLE", "Google 연동 서버 설정이 없습니다.");
  }
  try {
    const job = await rpc<{ id: string; status: string }>(userEndpoint(env, auth.token), "calendar_job_request_retry",
      { p_operation_id: operation_id, p_job_id: job_id });
    const outcome = job.status === "succeeded" ? { status: "succeeded" as const } : await processCalendarJob(env, auth.userId, job.id);
    return json(req, env, 200, { calendar_job_id: job.id, ...outcome });
  } catch (e) {
    return rpcFailure(req, env, e);
  }
}

// ───────────────────────── Google OAuth 연결 ─────────────────────────

const RETURN_PATH = /^\/[A-Za-z0-9/_-]{0,100}$/;

/** POST google-oauth-start: { return_path? } → { url } 사용자가 '연결' 버튼을 눌렀을 때 */
export async function handleOAuthStart(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const cfg = googleConfig(env);
  if (!cfg) return apiError(req, env, 503, "SERVICE_UNAVAILABLE", "Google OAuth가 설정되지 않았습니다.");
  const returnPath = typeof auth.body.return_path === "string" ? auth.body.return_path : "/";
  if (!RETURN_PATH.test(returnPath) || returnPath.startsWith("//")) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "return_path가 올바르지 않습니다.");
  }
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  try {
    await rpc(serviceEndpoint(env), "svc_oauth_state_create", {
      p_user_id: auth.userId, p_state_hash: await sha256Hex(state), p_code_verifier: verifier, p_return_path: returnPath,
    });
  } catch (e) {
    return rpcFailure(req, env, e);
  }
  return json(req, env, 200, { url: buildAuthUrl(cfg, state, await pkceChallenge(verifier)) });
}

/** 연결 결과 안내 문구. 고정 문구만 쓰고 요청 값을 응답에 넣지 않는다. */
export const OAUTH_RESULT_TEXT: Record<string, string> = {
  connected: "Google 캘린더 연결이 완료되었습니다.\n이 창을 닫고 회의 어시스턴트 앱으로 돌아가 설정에서 '상태 새로고침'을 누르세요.",
  denied: "Google 연결을 취소했습니다.\n이 창을 닫고 앱에서 다시 연결하세요.",
  scope_denied: "캘린더 권한을 허용하지 않아 연결하지 않았습니다.\n이 창을 닫고 앱에서 다시 연결할 때 캘린더 권한을 허용하세요.",
  invalid_state: "연결 요청이 만료되었거나 올바르지 않습니다.\n이 창을 닫고 앱에서 다시 연결하세요.",
  error: "Google 연결 중 오류가 발생했습니다.\n이 창을 닫고 앱에서 다시 시도하세요.",
};

/**
 * APP_WEB_ORIGIN이 있으면 웹 앱으로 돌려보낸다(로컬 웹 개발).
 * 없으면 웹 호스팅 없이 안내 문구를 응답한다. Supabase 기본 도메인은 Edge Function의 HTML을 허용하지 않으므로 텍스트로 보낸다.
 */
function redirect(env: ServerEnv, path: string, result: string): Response {
  if (!env.appWebOrigin) {
    return new Response(`${OAUTH_RESULT_TEXT[result] ?? OAUTH_RESULT_TEXT.error}\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  const target = new URL(path, env.appWebOrigin);
  target.searchParams.set("google", result);
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

/** GET google-oauth-callback?code&state — Google이 돌려보내는 주소. JWT 없이 state로 사용자를 찾는다(C04). */
export async function handleOAuthCallback(req: Request, env: ServerEnv): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405 });
  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  const cfg = googleConfig(env);
  if (!state || !cfg) return redirect(env, "/", "invalid_state");

  const svc = serviceEndpoint(env);
  const consumed = await rpc<{ user_id: string; code_verifier: string; return_path: string } | null>(
    svc, "svc_oauth_state_consume", { p_state_hash: await sha256Hex(state) });
  if (!consumed) return redirect(env, "/", "invalid_state");
  const back = RETURN_PATH.test(consumed.return_path) ? consumed.return_path : "/";

  const code = params.get("code");
  if (params.get("error") || !code) return redirect(env, back, "denied");

  const exchanged = await exchangeCode(cfg, code, consumed.code_verifier);
  if (!exchanged.ok) return redirect(env, back, "error");
  if (!cfg.scopes.every((s) => exchanged.value.scopes.includes(s))) {
    // 사용자가 동의 화면에서 캘린더 권한을 해제한 경우
    if (exchanged.value.refreshToken) await revokeToken(cfg, exchanged.value.refreshToken);
    return redirect(env, back, "scope_denied");
  }
  if (!exchanged.value.refreshToken || !env.tokenEncryptionKey) return redirect(env, back, "error");

  const ciphertext = await encryptSecret(await importTokenKey(env.tokenEncryptionKey), exchanged.value.refreshToken);
  await rpc(svc, "svc_oauth_connection_save", {
    p_user_id: consumed.user_id, p_account_email: null, p_scopes: exchanged.value.scopes, p_ciphertext: ciphertext,
  });
  return redirect(env, back, "connected");
}

/** POST google-disconnect: {} — 토큰을 Google에서 폐기하고 연결을 해제한다. 이미 만든 일정은 지우지 않는다. */
export async function handleDisconnect(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const svc = serviceEndpoint(env);
  try {
    const conn = await rpc<{ status: string; refresh_token_ciphertext: string | null } | null>(
      svc, "svc_oauth_connection_get", { p_user_id: auth.userId });
    let googleRevoked = false;
    const cfg = googleConfig(env);
    if (conn?.refresh_token_ciphertext && cfg && env.tokenEncryptionKey) {
      try {
        const token = await decryptSecret(await importTokenKey(env.tokenEncryptionKey), conn.refresh_token_ciphertext);
        googleRevoked = await revokeToken(cfg, token);
      } catch {
        googleRevoked = false;
      }
    }
    if (conn) await rpc(svc, "svc_oauth_connection_set_status", { p_user_id: auth.userId, p_status: "revoked" });
    return json(req, env, 200, { status: "revoked", google_revoked: googleRevoked });
  } catch (e) {
    return rpcFailure(req, env, e);
  }
}

// ───────────────────────── 원본 회의록 열기 ─────────────────────────

const OPEN_MEETING_TEXT = [
  "회의 어시스턴트에서 이 일정을 만든 회의록을 엽니다.",
  "",
  "앱이 열리지 않으면:",
  "- 휴대폰: 회의 어시스턴트 앱을 설치했는지 확인하세요.",
  "- PC: 회의 어시스턴트를 한 번 실행한 뒤 링크를 다시 누르세요.",
  "",
  "로그인 전이면 로그인한 뒤 해당 회의로 이동합니다. 삭제됐거나 볼 수 없는 회의록이면 앱이 안내합니다.",
].join("\n");

const ANDROID_PACKAGE = "app.meetingassistant.mobile";

/**
 * GET open-meeting?m=<회의 UUID> — Google 캘린더 일정 설명의 '원본 회의록 보기' 링크.
 * JWT 없이 동작하며 DB를 조회하지 않는다(회의 존재 여부를 드러내지 않는다). 권한 검사는 앱이 로그인 사용자로 한다.
 * 안드로이드는 intent URL로, PC는 meetingassistant:// 스킴으로 앱에 넘긴다. 앱이 없으면 안내 문구를 보인다.
 */
/** functionsBaseUrl: 공개 함수 주소(대체 안내 페이지용). 모르면 null(대체 주소 없이 앱으로만 넘긴다) */
export function handleOpenMeeting(req: Request, functionsBaseUrl: string | null): Response {
  const text = (body: string, status = 200) =>
    new Response(`${body}\n`, {
      status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  if (req.method !== "GET") return new Response(null, { status: 405 });
  const url = new URL(req.url);
  const id = url.searchParams.get("m") ?? "";
  if (!UUID.test(id)) return text("잘못된 회의록 링크입니다.", 400);
  if (url.searchParams.has("fallback")) return text(OPEN_MEETING_TEXT);

  const deepLink = `meetingassistant://meeting/${id}`;
  const ua = req.headers.get("User-Agent") ?? "";
  if (/Android/i.test(ua)) {
    // 앱이 없으면 안드로이드가 대체 주소(같은 함수의 안내 문구)를 연다
    const fallback = functionsBaseUrl
      ? `S.browser_fallback_url=${encodeURIComponent(`${functionsBaseUrl}/open-meeting?m=${id}&fallback=1`)};`
      : "";
    const intent = `intent://meeting/${id}#Intent;scheme=meetingassistant;package=${ANDROID_PACKAGE};${fallback}end`;
    return new Response(null, { status: 302, headers: { Location: intent, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return new Response(null, { status: 302, headers: { Location: deepLink, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
