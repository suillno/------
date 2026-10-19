import { describe, expect, it } from "vitest";
import { draftFromShare, isAllowedExternalUrl } from "./platform";

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

describe("draftFromShare", () => {
  it("Joplin 노트 ID가 제목으로 오면 본문 첫 줄을 제목으로 쓰고 본문에서 뺀다", () => {
    const d = draftFromShare({ title: "0d04a8d6787049949c4d186cc839ec42", text: "2026.10.19\n\n본인가 12월 일자는 미정\n조각투자" });
    expect(d).toEqual({ title: "2026.10.19", body: "본인가 12월 일자는 미정\n조각투자" });
  });

  it("제목이 없으면 첫 줄의 Markdown 제목 기호를 빼고 쓴다", () => {
    expect(draftFromShare({ title: null, text: "\r\n# 주간 회의\r\n내용" })).toEqual({ title: "주간 회의", body: "내용" });
  });

  it("정상 제목은 그대로 두고 본문을 바꾸지 않는다", () => {
    expect(draftFromShare({ title: " 강사님 미팅 ", text: "첫 줄\n둘째 줄" })).toEqual({ title: "강사님 미팅", body: "첫 줄\n둘째 줄" });
  });

  it("본문이 비어 있으면 제목도 비운다", () => {
    expect(draftFromShare({ title: "0D04A8D6787049949C4D186CC839EC42", text: null })).toEqual({ title: "", body: "" });
  });
});
