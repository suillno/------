import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown";

const html = (source: string) => renderToStaticMarkup(<MarkdownView source={source} />);

describe("MarkdownView (J03)", () => {
  it("Markdown을 서식으로 보여준다", () => {
    const out = html("# 회의\n\n- **결정**: 진행\n- [ ] 할 일");
    expect(out).toContain("<h1>회의</h1>");
    expect(out).toContain("<strong>결정</strong>");
  });

  it("HTML 원문·스크립트·이벤트 속성을 렌더링하지 않는다", () => {
    const out = html('본문 <script>alert(1)</script> <img src=x onerror="alert(2)"> <iframe src="https://evil.test"></iframe>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<iframe");
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
});
