// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { docToMarkdown, markdownToDoc } from "./convert";
import { editorExtensions } from "./extensions";
import { applyColor, colorState, decisionsToDoc, docToDecisions } from "./RichEditor";

const RED = "#c92a2a";
const BLUE = "#1864ab";
let editor: Editor | null = null;

function make(markdown: string): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions(), content: markdownToDoc(markdown) });
  return editor;
}
// 서식 경계 옆 글자는 라이브러리가 문자 참조(&#x…;)로 적는다(서식이 정확히 다시 읽히도록). 비교할 때는 풀어서 본다.
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
const md = (e: Editor) => decode(docToMarkdown(e.getJSON()));

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("도구 모음 동작 (T01–T06)", () => {
  it("T01 선택 영역에 굵게·밑줄을 적용하고 다시 누르면 해제한다", () => {
    const e = make("가나다라");
    e.chain().setTextSelection({ from: 2, to: 4 }).toggleBold().run();
    expect(md(e)).toBe("가**나다**라");
    expect(e.isActive("bold")).toBe(true);
    e.chain().setTextSelection({ from: 2, to: 4 }).toggleUnderline().run();
    expect(md(e)).toBe("가**<u>나다</u>**라");
    e.chain().setTextSelection({ from: 2, to: 4 }).toggleBold().toggleUnderline().run();
    expect(md(e)).toBe("가나다라");
  });

  it("T02 선택 없이 설정하면 이후 입력하는 글자에 적용한다", () => {
    const e = make("앞");
    e.chain().setTextSelection(2).toggleBold().run();
    applyColor(e, null, RED);
    e.commands.insertContent("뒤");
    expect(md(e)).toBe(`앞**<span style="color:${RED}">뒤</span>**`);
  });

  it("T03 커서 위치의 굵게·밑줄 상태를 알려 준다", () => {
    const e = make("**굵게** <u>밑줄</u> 보통");
    e.commands.setTextSelection(2);
    expect([e.isActive("bold"), e.isActive("underline")]).toEqual([true, false]);
    e.commands.setTextSelection(6);
    expect([e.isActive("bold"), e.isActive("underline")]).toEqual([false, true]);
  });

  it("T04 색상 박스: 한 색, 여러 색 섞임, 선택 없을 때 이후 입력 색", () => {
    const e = make(`<span style="color:${RED}">빨강</span><span style="color:${BLUE}">파랑</span>기본`);
    e.commands.setTextSelection({ from: 1, to: 3 });
    expect(colorState(e)).toEqual({ mixed: false, color: RED });
    e.commands.setTextSelection({ from: 1, to: 5 });
    expect(colorState(e)).toEqual({ mixed: true });
    e.commands.setTextSelection({ from: 5, to: 7 });
    expect(colorState(e)).toEqual({ mixed: false, color: null });
    e.commands.setTextSelection(2);
    expect(colorState(e)).toEqual({ mixed: false, color: RED });
  });

  it("T05 ‘기본색’은 색 지정을 해제한다", () => {
    const e = make(`<span style="color:${RED}">빨강</span>`);
    applyColor(e, { from: 1, to: 3 }, null);
    expect(md(e)).toBe("빨강");
  });

  it("T06 팔레트를 여는 동안 선택이 바뀌어도 저장해 둔 원래 영역에 적용한다", () => {
    const e = make("가나다라");
    const saved = { from: 2, to: 4 };
    e.commands.setTextSelection(5); // 팔레트 조작 중 선택이 풀린 상황
    applyColor(e, saved, BLUE);
    expect(md(e)).toBe(`가<span style="color:${BLUE}">나다</span>라`);
    expect(e.state.selection.from).toBe(2);
    expect(e.state.selection.to).toBe(4);
  });
});

describe("붙여넣기 정리 (S01–S04)", () => {
  it("스크립트·이미지·이벤트 속성·javascript 링크·팔레트 밖 색은 남기지 않는다", () => {
    const e = make("");
    e.commands.insertContent(
      `<p>안전<script>alert(1)</script><img src="x" onerror="alert(2)">` +
      `<a href="javascript:alert(3)">나쁜 링크</a> <a href="https://ok.example">좋은 링크</a> ` +
      `<span style="color: rgb(201, 42, 42)">팔레트 색</span> <span style="color:#123456">다른 색</span>` +
      `<b onclick="x()">굵게</b></p><iframe srcdoc="<p>x</p>"></iframe>`,
    );
    const out = md(e);
    expect(out).not.toMatch(/script|alert|onerror|onclick|iframe|javascript|#123456|<img/i);
    expect(out).toContain("[좋은 링크](https://ok.example)");
    expect(out).toContain(`<span style="color:${RED}">팔레트 색</span>`);
    expect(out).toContain("다른 색");
    expect(out).toContain("**굵게**");
  });
});

describe("결정사항 목록 (D03)", () => {
  it("배열 ↔ 글머리 목록 왕복, 서식 유지", () => {
    const items = ["**확정**: 수수료 합산", `<span style="color:${RED}">보류</span> 항목`, "세 번째"];
    expect(docToDecisions(decisionsToDoc(items))).toEqual(items);
  });
  it("편집기에서 목록 항목을 추가하면 배열 요소가 늘어난다", () => {
    editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions(), content: decisionsToDoc(["하나"]) });
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    editor.commands.splitListItem("listItem");
    editor.commands.insertContent("둘");
    expect(docToDecisions(editor.getJSON())).toEqual(["하나", "둘"]);
  });
  it("빈 목록은 빈 배열", () => {
    expect(docToDecisions(decisionsToDoc([]))).toEqual([]);
  });
});

describe("표·목록 편집 후 저장", () => {
  it("표 셀 글자를 굵게 해도 셀 구조와 AI 텍스트가 유지된다", () => {
    const e = make("| 항목 | 값 |\n| --- | --- |\n| 수수료 | 100 |");
    let pos = -1;
    e.state.doc.descendants((n, p) => {
      if (n.isText && n.text === "수수료") pos = p;
    });
    e.chain().setTextSelection({ from: pos, to: pos + 3 }).toggleBold().run();
    expect(md(e)).toContain("| **수수료** | 100 |");
  });
});
