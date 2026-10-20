// 편집기 구성 (Tiptap 3.31.3). 스키마에 있는 구조만 남으므로 붙여넣은 스크립트·iframe·이미지·이벤트 속성은 사라진다.
import { Extension, Node } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { visibleText } from "@meeting/client-core";
import { PRESERVED_BLOCK, PRESERVED_INLINE } from "./convert";
import { toPaletteColor } from "./palette";

/** textStyle의 color 속성. 팔레트 색만 받고(붙여넣기 포함), 어두운 화면용 표시 속성을 붙인다. */
const PaletteColor = Extension.create({
  name: "paletteColor",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        color: {
          default: null,
          parseHTML: (el: HTMLElement) => toPaletteColor(el.style.color),
          renderHTML: (attrs: Record<string, unknown>) => {
            const c = typeof attrs.color === "string" ? toPaletteColor(attrs.color) : null;
            return c ? { style: `color: ${c}`, "data-rt-color": c } : {};
          },
        },
      },
    }];
  },
});

/** 편집기가 다루지 못하는 블록(HTML 블록·각주 등). 원래 Markdown을 그대로 보존하고 고칠 수 없다. 붙여넣기로는 만들 수 없다. */
const PreservedBlock = Node.create({
  name: PRESERVED_BLOCK,
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { markdown: { default: "", rendered: false } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    const text = visibleText(String(node.attrs.markdown ?? "")) || "(표시할 수 없는 내용)";
    return ["div", { class: "rt-preserved", "data-preserved": "block", contenteditable: "false", title: "이 부분은 편집할 수 없어 원래 내용 그대로 보존합니다" }, text];
  },
});

const PreservedInline = Node.create({
  name: PRESERVED_INLINE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { markdown: { default: "", rendered: false }, label: { default: "", rendered: false } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    return ["span", { class: "rt-preserved-inline", contenteditable: "false" }, String(node.attrs.label || node.attrs.markdown)];
  },
});

export function editorExtensions() {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        isAllowedUri: (url: string) => /^https?:\/\//i.test(url),
      },
    }),
    TextStyle,
    PaletteColor,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    PreservedBlock,
    PreservedInline,
  ];
}
