import { describe, expect, it } from "vitest";
import { analysisText, visibleLength } from "@meeting/client-core";
import { RICH_FIXTURES } from "../../../../supabase/functions/_shared/richtext.fixtures.ts";
import { PRESERVED_BLOCK, PRESERVED_INLINE, docToMarkdown, markdownToDoc } from "./convert";

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

const SAMPLES: Record<string, string> = {
  joplin: "2026.10.19\n\n본인가 12월 일자는 미정 실사는 본인가 전에 오픈예정은 1월 일자는 미정\n\n조각투자는 장외시장 기준 거래는 지정가매매 세율관련은 회계부에서 확정해줘야함",
  headings: "# 제목 1\n\n## 제목 2\n\n### 제목 3\n\n본문",
  lists: "- 하나\n- 둘\n  - 둘의 하위\n  - 또 하위\n- 셋\n\n1. 첫째\n2. 둘째\n\n5. 다섯부터\n6. 여섯",
  tasks: "- [ ] 할 일\n- [x] 끝난 일",
  table: "| 구분 | 금액 | 비고 |\n| --- | ---: | :---: |\n| 단건 | 1,000 | **확정** |\n| 합산 | 2,000 |  |",
  quote: "> 인용 첫 줄\n> 인용 둘째 줄\n\n본문",
  links: "[네이버 지도](https://map.naver.com/p/search/%EA%B0%95%EB%82%A8) 그리고 https://example.com/a?b=1 끝",
  code: "```ts\nconst a = 1 * 2;\n```\n\n`인라인 *코드*`",
  breaks: "첫 줄\\\n둘째 줄  \n셋째 줄",
  marks: "**굵게** *기울임* ~~취소~~ <u>밑줄</u> <span style=\"color:#c92a2a\">빨강</span> **<u><span style=\"color:#1864ab\">모두</span></u>**",
  korean: "**본인가**12월 **\"인용\"**다음 <u>가</u>나 *강조*된 글",
  special: "1 * 2 = 2, a_b_c, <중괄호> \\*별표\\* | 파이프 | #해시",
  rule: "위\n\n---\n\n아래",
};

describe("D01 Markdown → 편집기 → Markdown: AI 입력 텍스트·보이는 글자 수가 같다", () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(name, () => {
      const out = roundTrip(md);
      expect(analysisText(out)).toBe(analysisText(md));
      expect(visibleLength(out)).toBe(visibleLength(md));
      // 두 번째 왕복부터는 문자열이 바뀌지 않는다(정규화가 한 번에 끝남)
      expect(roundTrip(out)).toBe(out);
    });
  }
  for (const f of RICH_FIXTURES) {
    it(`고정 자료: ${f.name}`, () => {
      expect(analysisText(roundTrip(f.markdown))).toBe(f.analysisText);
    });
  }
});

describe("서식 보존", () => {
  it("굵게·밑줄·글자색이 왕복 후에도 같은 문서가 된다", () => {
    const doc = markdownToDoc(SAMPLES.marks!);
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
    const para = doc.content![0]!.content!;
    const all = para.find((n) => n.text === "모두")!;
    expect(all.marks).toEqual([{ type: "bold" }, { type: "underline" }, { type: "textStyle", attrs: { color: "#1864ab" } }]);
  });

  it("같은 서식이 이어진 글자는 한 번만 감싼다", () => {
    const md = docToMarkdown({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "가", marks: [{ type: "bold" }] },
      { type: "text", text: "나", marks: [{ type: "bold" }, { type: "underline" }] },
      { type: "text", text: "다", marks: [{ type: "bold" }] },
    ] }] });
    expect(md).toBe("**가<u>나</u>다**");
  });

  it("글자에 들어간 기호·태그 모양 글자는 서식으로 바뀌지 않는다(이스케이프)", () => {
    const md = docToMarkdown({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<u>태그 아님</u> *별* #샵" }] }] });
    const back = markdownToDoc(md).content![0]!.content!;
    expect(back).toEqual([{ type: "text", text: "<u>태그 아님</u> *별* #샵" }]);
  });

  it("팔레트 밖 색·허용 안 된 링크는 저장하지 않는다(S04)", () => {
    const md = docToMarkdown({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "a", marks: [{ type: "textStyle", attrs: { color: "#123456" } }] },
      { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
    ] }] });
    expect(md).toBe("ab");
  });
});

describe("D04 편집기가 다루지 못하는 요소는 원래 Markdown 그대로 보존", () => {
  it("HTML 블록·각주·이미지", () => {
    const md = "<div align=\"center\">가운데</div>\n\n본문[^1] ![그림](https://img.example/a.png)\n\n[^1]: 각주 내용";
    const doc = markdownToDoc(md);
    expect(doc.content!.some((n) => n.type === PRESERVED_BLOCK)).toBe(true);
    expect(JSON.stringify(doc)).toContain(PRESERVED_INLINE);
    const out = docToMarkdown(doc);
    expect(out).toContain("<div align=\"center\">가운데</div>");
    expect(out).toContain("![그림](https://img.example/a.png)");
    expect(out).toContain("[^1]: 각주 내용");
    expect(analysisText(out)).toBe(analysisText(md));
  });
});

describe("D02 빈 문서", () => {
  it("빈 본문은 빈 문단 하나, 다시 빈 문자열", () => {
    expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(docToMarkdown(markdownToDoc(""))).toBe("");
  });
});
