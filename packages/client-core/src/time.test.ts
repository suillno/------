import { describe, expect, it } from "vitest";
import { formatInZone, isValidTimeZone, localToInstant } from "./time";

describe("localToInstant", () => {
  it("서울 현지 시각을 UTC로 바꾼다", () => {
    expect(localToInstant("2026-10-17T08:30", "Asia/Seoul")).toBe("2026-10-16T23:30:00.000Z");
  });
  it("C06 일광 절약 시간 전후를 구분한다", () => {
    expect(localToInstant("2026-03-08T01:30", "America/New_York")).toBe("2026-03-08T06:30:00.000Z");
    expect(localToInstant("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(localToInstant("2026-03-08T02:30", "America/New_York")).toBeNull();
  });
  it("형식이 틀리면 null", () => {
    expect(localToInstant("2026-10-17 08:30", "Asia/Seoul")).toBeNull();
  });
});

describe("formatInZone", () => {
  it("저장된 instant를 회의 시간대로 표시한다(자정 경계)", () => {
    expect(formatInZone("2026-10-16T23:30:00+00:00", "Asia/Seoul")).toBe("2026-10-17 08:30");
  });
});

describe("isValidTimeZone", () => {
  it("IANA 이름만 허용한다", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
