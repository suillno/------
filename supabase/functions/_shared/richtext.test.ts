import { describe, expect, it } from "vitest";
import {
  LIMITS,
  PALETTE,
  analysisBasis,
  analysisChanged,
  analysisText,
  checkNotes,
  codePoints,
  foldInline,
  foreignColors,
  parseMarkdown,
  stripTags,
  visibleLength,
  visibleText,
} from "./richtext.ts";
import { RICH_FIXTURES } from "./richtext.fixtures.ts";

const base = { title: "주간 회의", meeting_at: "2026-10-20T01:00:00.000Z", time_zone: "Asia/Seoul" };

describe("analysisText", () => {
  it("서식 기호를 빼고 목록·표·링크·인용은 읽을 수 있게 남긴다", () => {
    const md = [
      "# 2026.10.19",
      "",
      "**본인가** <u>12월</u> <span style=\"color:#c92a2a\">미정</span>",
      "",
      "- 조각투자",
      "  - 장외시장",
      "1. 첫째",
      "2. 둘째",
      "- [x] 완료 항목",
      "",
      "| 항목 | 금액 |",
      "|---|---|",
      "| 수수료 | 100 |",
      "",
      "> 인용문",
      "",
      "[네이버 지도](https://map.naver.com/p/search/a) 와 https://example.com",
    ].join("\n");
    expect(analysisText(md)).toBe([
      "2026.10.19",
      "본인가 12월 미정",
      "- 조각투자",
      "  - 장외시장",
      "1. 첫째",
      "2. 둘째",
      "- [x] 완료 항목",
      "항목 | 금액",
      "수수료 | 100",
      "> 인용문",
      "네이버 지도 (https://map.naver.com/p/search/a) 와 https://example.com",
    ].join("\n"));
  });

  it("허용 밖 HTML은 글자만 남기고 스크립트 내용은 버린다", () => {
    expect(analysisText("앞<script>alert(1)</script>뒤 <b onclick=\"x()\">굵게</b><br>다음 줄")).toBe("앞뒤 굵게\n다음 줄");
    expect(stripTags("<div>a &amp; b</div><p>c</p>")).toBe("a & b\nc\n");
  });
});

describe("analysisChanged (C01·C02)", () => {
  const body = "회의 내용\n\n- 결정 하나\n- 결정 둘\n\n[자료](https://a.example/x)";
  const same = (b: string) => expect(analysisChanged({ ...base, body }, { ...base, body: b })).toBe(false);
  const changed = (over: Partial<typeof base & { body: string }>) =>
    expect(analysisChanged({ ...base, body }, { ...base, body, ...over })).toBe(true);

  it("굵게·밑줄·글자색, 목록 기호, 빈 줄 수만 바뀌면 같은 분석 기준이다", () => {
    same("**회의** <u>내용</u>\n\n* 결정 <span style=\"color:#1864ab\">하나</span>\n* 결정 둘\n\n\n\n[자료](https://a.example/x)");
  });

  it("글자·링크 주소·목록 구분·제목·일시·시간대가 바뀌면 원문 변경이다", () => {
    changed({ body: body.replace("하나", "한개") });
    changed({ body: body.replace("https://a.example/x", "https://a.example/y") });
    changed({ body: body.replace("- 결정 하나\n- 결정 둘", "- 결정 하나 결정 둘") });
    changed({ title: "주간 회의 2" });
    changed({ meeting_at: "2026-10-20T02:00:00.000Z" });
    changed({ time_zone: "Asia/Tokyo" });
  });

  it("같은 순간이면 오프셋 표기가 달라도 같은 기준이다", () => {
    expect(analysisBasis({ ...base, body, meeting_at: "2026-10-20T10:00:00+09:00" })).toBe(analysisBasis({ ...base, body }));
  });

  it("표 셀 하나가 바뀌거나 셀이 합쳐지면 원문 변경이다", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(analysisChanged({ ...base, body: table }, { ...base, body: "| a | b |\n|---|---|\n| 1 | 3 |" })).toBe(true);
    expect(analysisChanged({ ...base, body: table }, { ...base, body: "| a b |\n|---|\n| 1 2 |" })).toBe(true);
  });
});

describe("고정 자료 (C03: 서버·PC가 같은 결과)", () => {
  for (const f of RICH_FIXTURES) {
    it(f.name, () => {
      expect(analysisText(f.markdown)).toBe(f.analysisText);
      expect(visibleLength(f.markdown)).toBe(f.visibleLength);
    });
  }
});

describe("foldInline", () => {
  const inline = (md: string) => {
    const p = parseMarkdown(md).children[0];
    return p && p.type === "paragraph" ? foldInline(p.children) : [];
  };
  it("밑줄·글자색 태그를 짝지어 서식 노드로 만든다", () => {
    expect(inline("a <u>b <span style=\"color:#C92A2A\">c</span></u> d")).toEqual([
      { type: "text", value: "a " },
      { type: "underline", children: [{ type: "text", value: "b " }, { type: "color", color: "#c92a2a", children: [{ type: "text", value: "c" }] }] },
      { type: "text", value: " d" },
    ]);
  });
  it("짝이 맞지 않거나 허용 밖인 태그는 버리고 글자만 남긴다", () => {
    expect(inline("<u>열림만 <span style=\"background:red\">x</span>")).toEqual([{ type: "text", value: "열림만 x" }]);
  });
});

describe("글자 수·저장 한도 (L01·L02)", () => {
  it("보이는 글자는 서식 기호·링크 주소를 세지 않는다", () => {
    expect(visibleText("**굵게** [링크](https://a.example) - 아님")).toBe("굵게 링크 - 아님");
    expect(visibleLength("**가나** <u>다</u>")).toBe(4);
    expect(codePoints("😀가")).toBe(2);
  });

  it("4000자 경계: 4000자는 통과, 4001자는 보이는 글자 초과", () => {
    const ok = "가".repeat(4000);
    expect(checkNotes(ok, [])).toEqual([]);
    expect(checkNotes(ok + "나", [])).toMatchObject([{ field: "summary", kind: "visible", length: 4001 }]);
  });

  it("서식이 많은 요약 측정: 단어마다 색·굵게를 넣어도 4000자 요약이 저장 한도 안에 든다", () => {
    // 6자 단어 + 공백 = 7자 단위, 단어마다 굵게 + 팔레트 색 (실사용에서 상당히 많은 서식)
    const word = "회의내용정리";
    const unit = (i: number) => `**<span style="color:${PALETTE[i % PALETTE.length]!.value}">${word}</span>** `;
    const units = Math.floor(LIMITS.summaryVisible / (word.length + 1));
    const heavy = Array.from({ length: units }, (_, i) => unit(i)).join("");
    expect(visibleLength(heavy)).toBeLessThanOrEqual(LIMITS.summaryVisible);
    const stored = codePoints(heavy);
    // 2026-10-20 측정(보이는 글자 약 4000자 기준): 서식 없음 3,976 / 문장 1/3 굵게+밑줄+색 6,184 / 모든 문장 색 8,946 /
    // 모든 문장 굵게+밑줄+색 10,508 / 단어마다 굵게+색 26,266 / 단어마다 굵게+밑줄+색 30,263 → 12000자로 확정.
    // 단어마다 서식을 넣는 극단적인 경우만 한도를 넘으며, 이때는 저장 전 안내 대상이다.
    expect(stored).toBeGreaterThan(LIMITS.summaryStored);
    expect(checkNotes(heavy, []).map((i) => i.kind)).toEqual(["stored"]);
  });

  it("문장 단위로 강조한 일반적인 요약(문장의 1/3에 서식)은 12000자 안에 든다", () => {
    const sentence = "다음 주 화요일까지 수수료 계산 방식을 확정한다. ";
    const marked = (i: number) => (i % 3 === 0 ? `**<u><span style="color:#c92a2a">${sentence.trim()}</span></u>** ` : sentence);
    let s = "";
    for (let i = 0; visibleLength(s + marked(i)) <= LIMITS.summaryVisible; i++) s += marked(i);
    expect(visibleLength(s)).toBeGreaterThan(3900);
    expect(codePoints(s)).toBeLessThan(LIMITS.summaryStored);
  });

  it("결정사항: 개수·항목별 보이는 글자·팔레트 밖 색을 따로 알린다", () => {
    const issues = checkNotes("", ["가".repeat(1001), "<span style=\"color:#123456\">x</span>", ...Array(49).fill("a")]);
    expect(issues).toEqual([
      { field: "decisions", kind: "count", length: 51, max: 50 },
      { field: "decisions", index: 0, kind: "visible", length: 1001, max: 1000 },
      { field: "decisions", index: 1, kind: "color", colors: ["#123456"] },
    ]);
  });
});

describe("팔레트 (S04·P01)", () => {
  it("팔레트 밖 색만 골라낸다", () => {
    expect(foreignColors("<span style=\"color:#c92a2a\">a</span><span style=\"color:#ABCDEF\">b</span>")).toEqual(["#abcdef"]);
  });

  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it("8~10색이고 밝은 화면(#ffffff·#fafafa)과 어두운 화면(#17171a·#1f1f23)에서 대비 4.5:1 이상", () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(PALETTE.length).toBeLessThanOrEqual(10);
    for (const c of PALETTE) {
      for (const bg of ["#ffffff", "#fafafa"]) expect(contrast(c.value, bg), `${c.id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["#17171a", "#1f1f23"]) expect(contrast(c.dark, bg), `${c.id} dark on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
