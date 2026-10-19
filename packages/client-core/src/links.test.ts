import { describe, expect, it } from "vitest";
import { parseMeetingLink } from "./links";

describe("parseMeetingLink (O04)", () => {
  const id = "cccccccc-0000-4000-8000-000000000001";
  it("회의 UUID만 꺼낸다", () => {
    expect(parseMeetingLink(`meetingassistant://meeting/${id}`)).toBe(id);
    expect(parseMeetingLink(`meetingassistant://meeting/${id.toUpperCase()}/`)).toBe(id);
  });
  it("다른 형식·경로 조작·다른 스킴은 거절한다", () => {
    expect(parseMeetingLink(`meetingassistant://meeting/../../etc`)).toBeNull();
    expect(parseMeetingLink(`https://evil.test/meeting/${id}`)).toBeNull();
    expect(parseMeetingLink(`meetingassistant://settings/${id}`)).toBeNull();
    expect(parseMeetingLink(`meetingassistant://meeting/not-a-uuid`)).toBeNull();
  });
});
