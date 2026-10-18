import { describe, expect, it } from "vitest";
import { backoffDelay, classifyFailure, parseRetryAfter } from "./retry";

describe("backoffDelay", () => {
  it("상한 안에서 지수 증가한다", () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, { random: max })).toBeLessThan(1_000);
    expect(backoffDelay(3, { random: max })).toBeLessThan(8_000);
    expect(backoffDelay(3, { random: max })).toBeGreaterThan(7_000);
    expect(backoffDelay(50, { random: max, maxMs: 10_000 })).toBeLessThan(10_000);
  });
});

describe("parseRetryAfter", () => {
  it("초 단위와 HTTP 날짜를 해석한다", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    const now = Date.parse("2026-10-17T00:00:00Z");
    expect(parseRetryAfter("Sat, 17 Oct 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("garbage")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("classifyFailure", () => {
  const zero = { random: () => 0 };
  it("상태 코드별 조치를 구분한다", () => {
    expect(classifyFailure(null, 0, null, zero)).toEqual({ kind: "retry", delayMs: 0 });
    expect(classifyFailure(429, 0, "3", zero)).toEqual({ kind: "retry", delayMs: 3_000 });
    expect(classifyFailure(503, 0, null, zero).kind).toBe("retry");
    expect(classifyFailure(401, 0).kind).toBe("refresh_token");
    expect(classifyFailure(403, 0).kind).toBe("stop_forbidden");
    expect(classifyFailure(409, 0).kind).toBe("conflict");
    expect(classifyFailure(410, 0).kind).toBe("full_resync");
    expect(classifyFailure(400, 0).kind).toBe("fail");
  });
});
