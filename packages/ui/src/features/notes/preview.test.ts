import { describe, expect, it } from "vitest";
import { summaryPreview } from "./index";

describe("요약 목록 미리보기", () => {
  it("Markdown 기호 없이 보이는 글자만, 줄바꿈은 한 칸으로", () => {
    expect(summaryPreview({ summary: "조각투자 회의. **[일정]**\n- **본인가는 12월** <u>예정</u>", summary_preview: "" }))
      .toBe("조각투자 회의. [일정] 본인가는 12월 예정");
  });
  it("160자를 넘으면 줄임표", () => {
    expect(summaryPreview({ summary: "가".repeat(200), summary_preview: "" })).toBe(`${"가".repeat(160)}…`);
  });
  it("이전 서버(summary 없음)는 summary_preview를 쓴다", () => {
    expect(summaryPreview({ summary_preview: "**굵게** 앞부분" })).toBe("굵게 앞부분");
  });
});
