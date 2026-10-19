import { describe, expect, it } from "vitest";
import {
  APPROVAL_PROPERTY,
  buildAuthUrl,
  buildEventBody,
  googleEventIdForApproval,
  insertApprovedEvent,
  meetingLinkUrl,
  naverMapSearchUrl,
  refreshAccessToken,
  type CandidatePayload,
  type GoogleConfig,
} from "./google.ts";
import { fakeFetch, jsonResponse, type Route } from "./testing.ts";

const APPROVAL = "3F2B8C1E-9D4A-4B7E-8F1A-2C3D4E5F6A7B".toLowerCase();
const EVENT_ID = "3f2b8c1e9d4a4b7e8f1a2c3d4e5f6a7b";

const timed: CandidatePayload = {
  title: "디자인 리뷰",
  start_local: "2026-10-20T15:00",
  end_local: "2026-10-20T16:00:00",
  time_zone: "Asia/Seoul",
  all_day: false,
  evidence: "다음 주 화요일 3시",
  needs_confirmation: false,
  description: null,
};

function cfg(routes: Route[]): { cfg: GoogleConfig; calls: ReturnType<typeof fakeFetch>["calls"] } {
  const f = fakeFetch(routes);
  return {
    cfg: { clientId: "cid", clientSecret: "test-secret", redirectUri: "https://example.test/cb", scopes: ["s1"], fetch: f.fetch, timeoutMs: 1000 },
    calls: f.calls,
  };
}

describe("googleEventIdForApproval", () => {
  it("같은 승인은 항상 같은 ID를 만든다", () => {
    expect(googleEventIdForApproval(APPROVAL.toUpperCase())).toBe(EVENT_ID);
    expect(() => googleEventIdForApproval("not-a-uuid")).toThrow();
  });
});

describe("buildEventBody", () => {
  it("시간 지정 일정은 현지 시각과 timeZone을 보낸다", () => {
    const body = buildEventBody(timed, APPROVAL);
    expect(body.id).toBe(EVENT_ID);
    expect(body.start).toEqual({ dateTime: "2026-10-20T15:00:00", timeZone: "Asia/Seoul" });
    expect(body.end).toEqual({ dateTime: "2026-10-20T16:00:00", timeZone: "Asia/Seoul" });
    expect(body.extendedProperties.private[APPROVAL_PROPERTY]).toBe(APPROVAL);
    expect(body).not.toHaveProperty("attendees");
  });

  it("C06 종일 일정은 배타적 종료일(다음 날)을 쓴다, 월말 경계 포함", () => {
    const body = buildEventBody({ ...timed, all_day: true, start_local: "2026-10-31", end_local: "2026-10-31" }, APPROVAL);
    expect(body.start).toEqual({ date: "2026-10-31" });
    expect(body.end).toEqual({ date: "2026-11-01" });
  });

  it("L01 목적지가 없으면 장소·지도 링크를 넣지 않는다", () => {
    const body = buildEventBody({ ...timed, location: null }, APPROVAL);
    expect(body).not.toHaveProperty("location");
    expect(body.description).not.toContain("map.naver.com");
    const blank = buildEventBody({ ...timed, location: "   " }, APPROVAL);
    expect(blank).not.toHaveProperty("location");
  });

  it("L02 확인된 목적지는 장소와 네이버 지도 검색 링크로 넣는다", () => {
    const body = buildEventBody({ ...timed, location: "교대역 2번 출구" }, APPROVAL);
    expect(body.location).toBe("교대역 2번 출구");
    expect(body.description).toContain(`네이버 지도: ${naverMapSearchUrl("교대역 2번 출구")}`);
    expect(naverMapSearchUrl("교대역 2번 출구")).toBe("https://map.naver.com/p/search/%EA%B5%90%EB%8C%80%EC%97%AD%202%EB%B2%88%20%EC%B6%9C%EA%B5%AC");
  });

  it("O 원본 회의록 링크는 목적지와 관계없이 넣고 회의 UUID만 담는다", () => {
    const meeting = "cccccccc-0000-4000-8000-000000000001";
    const url = meetingLinkUrl("https://example.supabase.co/functions/v1/", meeting);
    expect(url).toBe(`https://example.supabase.co/functions/v1/open-meeting?m=${meeting}`);
    const body = buildEventBody({ ...timed, location: null }, APPROVAL, { meetingUrl: url });
    expect(body.description).toContain(`원본 회의록 보기: ${url}`);
    expect(() => meetingLinkUrl("https://x", "../../etc")).toThrow();
  });

  it("확정되지 않은 일정은 만들지 않는다", () => {
    expect(() => buildEventBody({ ...timed, end_local: null }, APPROVAL)).toThrow();
  });
});

describe("buildAuthUrl", () => {
  it("offline 접근, PKCE, state를 포함한다", () => {
    const url = new URL(buildAuthUrl(cfg([]).cfg, "st", "ch"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toBe("s1");
  });
});

describe("refreshAccessToken", () => {
  it("C05 invalid_grant는 재연결 필요로 분류한다", async () => {
    const { cfg: c } = cfg([() => jsonResponse(400, { error: "invalid_grant" })]);
    expect(await refreshAccessToken(c, "rt")).toEqual({ ok: false, code: "AUTH_REQUIRED", message: "invalid_grant" });
  });
});

describe("insertApprovedEvent", () => {
  const body = buildEventBody(timed, APPROVAL);
  const insert = (res: Response | "network"): Route => (c) => (c.method === "POST" && c.url.includes("/events?") ? res : undefined);
  const get = (res: Response): Route => (c) => (c.method === "GET" && c.url.endsWith(`/events/${EVENT_ID}`) ? res : undefined);
  const mine = { id: EVENT_ID, htmlLink: "https://cal/e", etag: "e1", extendedProperties: { private: { [APPROVAL_PROPERTY]: APPROVAL } } };

  it("초대 메일 없이 등록한다", async () => {
    const { cfg: c, calls } = cfg([insert(jsonResponse(200, mine))]);
    const r = await insertApprovedEvent(c, "at", "primary", body);
    expect(r).toEqual({ ok: true, value: { googleEventId: EVENT_ID, htmlLink: "https://cal/e", etag: "e1", recovered: false } });
    expect(calls[0]!.url).toContain("sendUpdates=none");
    expect(calls).toHaveLength(1);
  });

  it("C03 응답 timeout 후 같은 ID로 조회해 중복 없이 복구한다", async () => {
    const { cfg: c, calls } = cfg([insert("network"), get(jsonResponse(200, mine))]);
    const r = await insertApprovedEvent(c, "at", "primary", body);
    expect(r.ok && r.value.recovered).toBe(true);
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("C03 조회 결과가 없으면 같은 ID로 한 번 더 넣는다", async () => {
    let posts = 0;
    const { cfg: c } = cfg([
      (call) => (call.method === "POST" ? (++posts === 1 ? "network" : jsonResponse(200, mine)) : undefined),
      get(jsonResponse(404, { error: { message: "Not Found" } })),
    ]);
    const r = await insertApprovedEvent(c, "at", "primary", body);
    expect(r.ok).toBe(true);
    expect(posts).toBe(2);
  });

  it("409에서 승인 ID가 같으면 이미 등록된 것으로 복구한다", async () => {
    const { cfg: c } = cfg([insert(jsonResponse(409, { error: { message: "duplicate" } })), get(jsonResponse(200, mine))]);
    expect((await insertApprovedEvent(c, "at", "primary", body)).ok).toBe(true);
  });

  it("409에서 승인 ID가 다르면 성공으로 취급하지 않는다", async () => {
    const other = { ...mine, extendedProperties: { private: { [APPROVAL_PROPERTY]: "someone-else" } } };
    const { cfg: c } = cfg([insert(jsonResponse(409, {})), get(jsonResponse(200, other))]);
    expect(await insertApprovedEvent(c, "at", "primary", body)).toMatchObject({ ok: false, code: "EVENT_ID_CONFLICT" });
  });

  it("C07 Google에서 삭제된 같은 일정은 다시 만들지 않는다", async () => {
    const { cfg: c } = cfg([insert(jsonResponse(409, {})), get(jsonResponse(200, { ...mine, status: "cancelled" }))]);
    expect(await insertApprovedEvent(c, "at", "primary", body)).toMatchObject({ ok: false, code: "EVENT_DELETED_EXTERNALLY" });
  });

  it("401·권한 부족은 재연결 필요로 분류하고 재시도하지 않는다", async () => {
    const a = cfg([insert(jsonResponse(401, { error: { message: "Invalid Credentials" } }))]);
    expect(await insertApprovedEvent(a.cfg, "at", "primary", body)).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(a.calls).toHaveLength(1);
    const b = cfg([insert(jsonResponse(403, { error: { message: "Request had insufficient authentication scopes." } }))]);
    expect(await insertApprovedEvent(b.cfg, "at", "primary", body)).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("계속 응답이 없으면 실패로 끝내고 사용자 재시도를 기다린다", async () => {
    const { cfg: c, calls } = cfg([() => "network"]);
    expect(await insertApprovedEvent(c, "at", "primary", body)).toMatchObject({ ok: false, code: "NETWORK" });
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});
