import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlainText, RichView } from "./RichView";

const html = (source: string) => renderToStaticMarkup(<RichView source={source} />);

describe("RichView (R01·R02)", () => {
  it("R01 기존 Markdown(제목·목록·표·강조·인용·링크)을 서식으로 보여 주고 기호는 보이지 않는다", () => {
    const out = html("# 회의\n\n- **결정**: 진행\n- [ ] 할 일\n\n> 인용\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<h1>회의</h1>");
    expect(out).toContain("<strong>결정</strong>");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<table>");
    expect(out).toContain('type="checkbox"');
    expect(out).not.toMatch(/\*\*|^#|\|---/m);
  });

  it("밑줄·팔레트 글자색을 보여 주고 팔레트 밖 색은 색 없이 글자만", () => {
    const out = html('<u>밑줄</u> <span style="color:#c92a2a">빨강</span> <span style="color:#123456">다른</span>');
    expect(out).toContain("<u>밑줄</u>");
    expect(out).toContain('data-rt-color="#c92a2a"');
    expect(out).not.toContain("#123456");
    expect(out).toContain("다른");
    expect(out).not.toContain("&lt;span");
  });

  it("R02 HTML 원문·스크립트·이벤트 속성을 렌더링하지 않는다", () => {
    const out = html('본문 <script>alert(1)</script> <img src=x onerror="alert(2)"> <iframe srcdoc="x"></iframe>\n\n<div onclick="x()">블록</div>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("onclick");
    expect(out).toContain("블록");
  });

  it("링크는 이동하지 않는 텍스트로 보이고 javascript: 주소는 버린다", () => {
    const out = html("[누르기](javascript:alert(1)) [지도](https://map.naver.com/p/search/a)");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("(https://map.naver.com/p/search/a)");
  });

  it("이미지는 불러오지 않는다", () => {
    const out = html("![사진](https://example.test/a.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("[이미지: 사진]");
  });

  it("표는 가로 스크롤 상자 안에 둔다", () => {
    expect(html("| a |\n|---|\n| 1 |")).toContain('<div class="rich-table">');
  });
});

describe("PlainText (AI 원본)", () => {
  it("기호를 서식으로 해석하지 않는다", () => {
    const out = renderToStaticMarkup(<PlainText text={"**굵게 아님** <u>태그</u>"} />);
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("<u>");
    expect(out).toContain("**굵게 아님**");
  });
});
