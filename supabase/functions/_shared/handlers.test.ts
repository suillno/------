import { describe, expect, it } from "vitest";
import { encryptSecret, importTokenKey, sha256Hex } from "./crypto.ts";
import { APPROVAL_PROPERTY } from "./google.ts";
import {
  functionsBaseUrlFrom,
  handleCalendarRegister,
  handleOAuthCallback,
  handleOAuthStart,
  handleOpenMeeting,
  loadServerEnv,
  processCalendarJob,
  type ServerEnv,
} from "./handlers.ts";
import { fakeFetch, jsonResponse, type RecordedCall, type Route } from "./testing.ts";

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB = "bbbbbbbb-0000-4000-8000-000000000002";
const APPROVAL = "cccccccc-0000-4000-8000-000000000003";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const payload = {
  title: "디자인 리뷰", start_local: "2026-10-20T15:00", end_local: "2026-10-20T16:00", time_zone: "Asia/Seoul",
  all_day: false, evidence: "근거", needs_confirmation: false, description: null,
};

function env(routes: Route[], overrides: Record<string, string | undefined> = {}) {
  const f = fakeFetch(routes);
  const vars: Record<string, string | undefined> = {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-test",
    SUPABASE_SERVICE_ROLE_KEY: "service-test",
    GOOGLE_OAUTH_CLIENT_ID: "cid",
    GOOGLE_OAUTH_CLIENT_SECRET: "csecret-test",
    GOOGLE_OAUTH_REDIRECT_URI: "http://supabase.test/functions/v1/google-oauth-callback",
    TOKEN_ENCRYPTION_KEY: KEY,
    APP_WEB_ORIGIN: "http://localhost:5173",
    APP_ALLOWED_ORIGINS: "http://127.0.0.1:1420",
    ...overrides,
  };
  return { env: loadServerEnv((k) => vars[k], f.fetch), calls: f.calls };
}

const rpcRoute = (fn: string, handler: (args: Record<string, unknown>, call: RecordedCall) => Response): Route =>
  (call) => (call.url === `http://supabase.test/rest/v1/rpc/${fn}` ? handler(JSON.parse(call.body ?? "{}"), call) : undefined);
const userRoute: Route = (call) =>
  call.url === "http://supabase.test/auth/v1/user"
    ? call.headers.authorization === "Bearer user-jwt" ? jsonResponse(200, { id: USER }) : jsonResponse(401, {})
    : undefined;

async function claimOk() {
  return {
    ok: true, job_id: JOB, lease_token: "lease", approval_id: APPROVAL, meeting_id: "dddddddd-0000-4000-8000-000000000009",
    calendar_id: "primary", payload,
    refresh_token_ciphertext: await encryptSecret(await importTokenKey(KEY), "refresh-1"),
  };
}

describe("processCalendarJob", () => {
  it("재검사 → 토큰 갱신 → 등록 → 완료 기록 순서로 처리한다", async () => {
    const claim = await claimOk();
    const { env: e, calls } = env([
      rpcRoute("svc_calendar_job_claim", (a) => {
        expect(a).toEqual({ p_user_id: USER, p_job_id: JOB });
        return jsonResponse(200, claim);
      }),
      (c) => (c.url === "https://oauth2.googleapis.com/token" ? jsonResponse(200, { access_token: "at-1" }) : undefined),
      (c) => (c.method === "POST" && c.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        ? jsonResponse(200, { id: "x", htmlLink: "https://cal/e", etag: "e" }) : undefined),
      rpcRoute("svc_calendar_job_complete", () => jsonResponse(200, { status: "succeeded" })),
    ]);
    expect(await processCalendarJob(e, USER, JOB)).toEqual({ status: "succeeded", html_link: "https://cal/e" });
    expect(calls.map((c) => c.url.split("?")[0])).toEqual([
      "http://supabase.test/rest/v1/rpc/svc_calendar_job_claim",
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "http://supabase.test/rest/v1/rpc/svc_calendar_job_complete",
    ]);
    // 서버 비밀은 Supabase 서비스 호출에만 쓰이고 Google 요청에는 refresh token만 간다
    expect(calls[1]!.body).toContain("refresh_token=refresh-1");
    const inserted = JSON.parse(calls[2]!.body!);
    expect(inserted.extendedProperties.private[APPROVAL_PROPERTY]).toBe(APPROVAL);
    // 원본 회의록 링크: 공개 함수 주소 + 회의 UUID (목적지 없는 일정에도 넣는다)
    expect(inserted.description).toContain("원본 회의록 보기: http://supabase.test/functions/v1/open-meeting?m=dddddddd-0000-4000-8000-000000000009");
    expect(inserted).not.toHaveProperty("location");
  });

  it("재검사에서 막히면 Google을 호출하지 않는다", async () => {
    const { env: e, calls } = env([rpcRoute("svc_calendar_job_claim", () => jsonResponse(200, { ok: false, error_code: "CANDIDATE_CHANGED" }))]);
    expect(await processCalendarJob(e, USER, JOB)).toEqual({ status: "failed", error_code: "CANDIDATE_CHANGED" });
    expect(calls).toHaveLength(1);
  });

  it("진행 중인 작업은 중복 실행하지 않는다", async () => {
    const { env: e, calls } = env([rpcRoute("svc_calendar_job_claim", () => jsonResponse(200, { ok: false, error_code: "JOB_IN_PROGRESS" }))]);
    expect(await processCalendarJob(e, USER, JOB)).toEqual({ status: "running" });
    expect(calls).toHaveLength(1);
  });

  it("C05 토큰이 폐기됐으면 실패(AUTH_REQUIRED)로 기록하고 등록하지 않는다", async () => {
    const claim = await claimOk();
    let failed: Record<string, unknown> | null = null;
    const { env: e, calls } = env([
      rpcRoute("svc_calendar_job_claim", () => jsonResponse(200, claim)),
      (c) => (c.url === "https://oauth2.googleapis.com/token" ? jsonResponse(400, { error: "invalid_grant" }) : undefined),
      rpcRoute("svc_calendar_job_fail", (a) => ((failed = a), jsonResponse(200, { status: "failed" }))),
    ]);
    expect(await processCalendarJob(e, USER, JOB)).toEqual({ status: "failed", error_code: "AUTH_REQUIRED" });
    expect(failed).toMatchObject({ p_job_id: JOB, p_lease_token: "lease", p_error_code: "AUTH_REQUIRED" });
    expect(calls.some((c) => c.url.includes("calendar/v3"))).toBe(false);
  });
});

describe("handleCalendarRegister", () => {
  const req = (body: unknown, auth = "Bearer user-jwt", origin = "http://localhost:5173") =>
    new Request("http://fn.test/calendar-register", {
      method: "POST", headers: { Authorization: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  const valid = { operation_id: "dddddddd-0000-4000-8000-000000000004", candidate_id: "eeeeeeee-0000-4000-8000-000000000005", base_version: 2, payload_hash: "h" };

  it("로그인하지 않은 요청은 거절한다", async () => {
    const { env: e } = env([userRoute]);
    expect((await handleCalendarRegister(req(valid, "Bearer wrong"), e)).status).toBe(401);
  });

  it("승인 RPC를 사용자 JWT로 호출하고 서버 키를 쓰지 않는다", async () => {
    let approveCall: RecordedCall | null = null;
    const { env: e } = env([
      userRoute,
      rpcRoute("candidate_approve", (a, call) => {
        approveCall = call;
        expect(a).toEqual({ p_operation_id: valid.operation_id, p_id: valid.candidate_id, p_base_version: 2, p_payload_hash: "h" });
        return jsonResponse(409, { code: "PAYLOAD_CHANGED", message: "다름", details: null, hint: null });
      }),
    ]);
    const res = await handleCalendarRegister(req(valid), e);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PAYLOAD_CHANGED");
    expect(approveCall!.headers.authorization).toBe("Bearer user-jwt");
    expect(approveCall!.headers.apikey).toBe("anon-test");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("허용하지 않은 origin에는 CORS 헤더를 주지 않는다", async () => {
    const { env: e } = env([userRoute]);
    const res = await handleCalendarRegister(req({}, "Bearer user-jwt", "https://evil.test"), e);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Google 비밀이 없으면 503으로 알리고 승인하지 않는다", async () => {
    const { env: e, calls } = env([userRoute], { GOOGLE_OAUTH_CLIENT_SECRET: undefined });
    expect((await handleCalendarRegister(req(valid), e)).status).toBe(503);
    expect(calls.some((c) => c.url.includes("candidate_approve"))).toBe(false);
  });
});

describe("OAuth", () => {
  it("연결 시작은 state 해시와 PKCE verifier만 저장하고 Google 주소를 준다", async () => {
    let saved: Record<string, unknown> | null = null;
    const { env: e } = env([userRoute, rpcRoute("svc_oauth_state_create", (a) => ((saved = a), jsonResponse(200, null)))]);
    const res = await handleOAuthStart(new Request("http://fn.test/start", {
      method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ return_path: "/settings" }),
    }), e);
    const url = new URL(((await res.json()) as { url: string }).url);
    const state = url.searchParams.get("state")!;
    expect(saved).toMatchObject({ p_user_id: USER, p_state_hash: await sha256Hex(state), p_return_path: "/settings" });
    expect(JSON.stringify(saved)).not.toContain(state);
  });

  it("외부 주소로 돌아가는 return_path는 거절한다", async () => {
    const { env: e } = env([userRoute]);
    for (const p of ["//evil.test", "https://evil.test", "/a?x=1"]) {
      const res = await handleOAuthStart(new Request("http://fn.test/start", {
        method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ return_path: p }),
      }), e);
      expect(res.status).toBe(400);
    }
  });

  it("C04 재사용·변조된 state는 연결하지 않는다", async () => {
    const { env: e, calls } = env([rpcRoute("svc_oauth_state_consume", () => jsonResponse(200, null))]);
    const res = await handleOAuthCallback(new Request("http://fn.test/cb?state=forged&code=c"), e);
    expect(res.headers.get("Location")).toBe("http://localhost:5173/?google=invalid_state");
    expect(calls.some((c) => c.url.includes("oauth2.googleapis.com"))).toBe(false);
  });

  it("캘린더 권한을 빼고 동의하면 토큰을 폐기하고 저장하지 않는다", async () => {
    const { env: e, calls } = env([
      rpcRoute("svc_oauth_state_consume", () => jsonResponse(200, { user_id: USER, code_verifier: "v", return_path: "/settings" })),
      (c) => (c.url === "https://oauth2.googleapis.com/token" ? jsonResponse(200, { refresh_token: "rt", scope: "openid" }) : undefined),
      (c) => (c.url === "https://oauth2.googleapis.com/revoke" ? jsonResponse(200, {}) : undefined),
    ]);
    const res = await handleOAuthCallback(new Request("http://fn.test/cb?state=s&code=c"), e);
    expect(res.headers.get("Location")).toBe("http://localhost:5173/settings?google=scope_denied");
    expect(calls.some((c) => c.url.includes("svc_oauth_connection_save"))).toBe(false);
  });

  it("refresh token은 암호화해서만 저장한다", async () => {
    let saved: Record<string, unknown> | null = null;
    const { env: e } = env([
      rpcRoute("svc_oauth_state_consume", () => jsonResponse(200, { user_id: USER, code_verifier: "v", return_path: "/settings" })),
      (c) => (c.url === "https://oauth2.googleapis.com/token"
        ? jsonResponse(200, { refresh_token: "plain-refresh", scope: "https://www.googleapis.com/auth/calendar.events.owned" }) : undefined),
      rpcRoute("svc_oauth_connection_save", (a) => ((saved = a), jsonResponse(200, null))),
    ]);
    const res = await handleOAuthCallback(new Request("http://fn.test/cb?state=s&code=c"), e);
    expect(res.headers.get("Location")).toBe("http://localhost:5173/settings?google=connected");
    expect(JSON.stringify(saved)).not.toContain("plain-refresh");
    expect(String(saved!.p_ciphertext)).toMatch(/^v1\./);
  });
});

describe("OAuth 완료 안내 (웹 호스팅 없음)", () => {
  it("APP_WEB_ORIGIN이 없으면 리디렉션 대신 안내 문구를 응답하고 요청 값을 넣지 않는다", async () => {
    const { env: e } = env([rpcRoute("svc_oauth_state_consume", () => jsonResponse(200, null))], { APP_WEB_ORIGIN: undefined });
    const res = await handleOAuthCallback(new Request("http://fn.test/cb?state=%3Cscript%3E&code=x"), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("만료");
    expect(text).not.toContain("script");
  });

  it("연결 성공도 안내 문구로 알린다", async () => {
    const { env: e } = env([
      rpcRoute("svc_oauth_state_consume", () => jsonResponse(200, { user_id: USER, code_verifier: "v", return_path: "/settings" })),
      (c) => (c.url === "https://oauth2.googleapis.com/token"
        ? jsonResponse(200, { refresh_token: "rt", scope: "https://www.googleapis.com/auth/calendar.events.owned" }) : undefined),
      rpcRoute("svc_oauth_connection_save", () => jsonResponse(200, null)),
    ], { APP_WEB_ORIGIN: undefined });
    const res = await handleOAuthCallback(new Request("http://fn.test/cb?state=s&code=c"), e);
    expect(await res.text()).toContain("연결이 완료되었습니다");
  });

  it("허용 origin은 APP_ALLOWED_ORIGINS만 쓴다", () => {
    const e = env([], { APP_WEB_ORIGIN: undefined }).env;
    expect(e.appWebOrigin).toBeNull();
    expect(e.allowedOrigins).toEqual(["http://127.0.0.1:1420"]);
  });
});

describe("loadServerEnv", () => {
  it("필수 값이 없으면 시작하지 않는다", () => {
    expect(() => loadServerEnv(() => undefined)).toThrow();
  });
  it("Google 비밀이 없으면 연동을 끈 상태로 시작한다", () => {
    const e: ServerEnv = env([], { GOOGLE_OAUTH_CLIENT_ID: undefined }).env;
    expect(e.google).toBeNull();
  });
});

describe("open-meeting (원본 회의록 링크)", () => {
  const meeting = "cccccccc-0000-4000-8000-000000000001";
  const base = "https://example.supabase.co/functions/v1";
  const req = (q: string, ua = "Mozilla/5.0 (Windows NT 10.0)") =>
    new Request(`http://internal/open-meeting${q}`, { headers: { "User-Agent": ua } });

  it("O PC는 meetingassistant:// 스킴으로 넘긴다", () => {
    const res = handleOpenMeeting(req(`?m=${meeting}`), base);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`meetingassistant://meeting/${meeting}`);
  });

  it("O 안드로이드는 앱 패키지를 지정한 intent로 넘기고 앱이 없으면 안내 주소로 간다", () => {
    const res = handleOpenMeeting(req(`?m=${meeting}`, "Mozilla/5.0 (Linux; Android 15)"), base);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith(`intent://meeting/${meeting}#Intent;scheme=meetingassistant;package=app.meetingassistant.mobile;`)).toBe(true);
    expect(decodeURIComponent(loc)).toContain(`${base}/open-meeting?m=${meeting}&fallback=1`);
  });

  it("O04 UUID가 아니면 거절하고 입력값을 응답에 넣지 않는다", async () => {
    const res = handleOpenMeeting(req("?m=%3Cscript%3E"), base);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("script");
  });

  it("앱이 없을 때 안내 문구", async () => {
    const res = handleOpenMeeting(req(`?m=${meeting}&fallback=1`), base);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain("앱이 열리지 않으면");
  });

  it("공개 함수 주소는 OAuth 콜백 주소에서 만든다", () => {
    expect(functionsBaseUrlFrom(`${base}/google-oauth-callback`)).toBe(base);
    expect(functionsBaseUrlFrom("https://evil.test/callback")).toBeNull();
    expect(functionsBaseUrlFrom(undefined)).toBeNull();
  });
});
