import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./platform";

describe("isAllowedExternalUrl", () => {
  it("Google 동의·캘린더 화면만 연다", () => {
    expect(isAllowedExternalUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
    expect(isAllowedExternalUrl("https://www.google.com/calendar/event?eid=abc")).toBe(true);
    expect(isAllowedExternalUrl("http://accounts.google.com/")).toBe(false);
    expect(isAllowedExternalUrl("https://accounts.google.com.evil.test/")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("file:///C:/Windows")).toBe(false);
  });
});
