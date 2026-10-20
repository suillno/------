// 서식 편집기. 화면에 보이는 내용을 바로 고친다(편집/미리보기 전환·원문 편집 없음).
// 도구 모음: 굵게(B) · 밑줄(가) · 글자색(색상 박스 + 팔레트). docs/plans/2026-10-20-rich-text.md 4장.
//
// 한글 조합 보호: 비제어 편집기다(입력마다 내용을 다시 넣지 않음). 조합 중 도구를 누르면 조합이 끝난 뒤 적용한다.
// 저장 형식 변환은 바뀐 여부 확인(잠시 멈춘 뒤)과 ‘저장’ 때만 한다.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { PALETTE } from "@meeting/client-core";
import { docToMarkdown, markdownToDoc } from "./convert";
import { editorExtensions } from "./extensions";
import { ensurePaletteStyle } from "./palette";

export interface RichEditorHandle {
  /** 현재 내용(저장 형식). 바뀐 것이 없으면 처음 받은 문자열을 그대로 돌려준다 */
  getMarkdown(): string;
  /** 처음 받은 값으로 되돌린다(취소) */
  reset(markdown?: string): void;
}

interface Props {
  label: string;
  initial: string;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** 내용이 바뀔 때(잠시 멈춘 뒤) 저장 형식 문자열. 글자 수 안내 등에 쓴다 */
  onValue?: (markdown: string) => void;
  minHeight?: number;
}

/** Markdown 문자열 편집 */
export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(props, ref) {
  return <EditorCore {...props} toDoc={markdownToDoc} fromDoc={docToMarkdown} ref={ref} />;
});

export interface DecisionsEditorHandle {
  getItems(): string[];
  reset(items?: string[]): void;
}

/** 결정사항: 편집기에서는 글머리 목록 하나, 저장은 목록 항목 1개 = 배열 요소 1개 */
export function decisionsToDoc(items: readonly string[]): JSONContent {
  if (items.length === 0) return { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }] };
  return {
    type: "doc",
    content: [{
      type: "bulletList",
      content: items.map((d) => {
        const blocks = markdownToDoc(d).content ?? [];
        return { type: "listItem", content: blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph" }, ...blocks] };
      }),
    }],
  };
}

export function docToDecisions(doc: JSONContent): string[] {
  const out: string[] = [];
  for (const block of doc.content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      for (const item of block.content ?? []) out.push(docToMarkdown({ type: "doc", content: item.content ?? [] }));
    } else {
      out.push(docToMarkdown({ type: "doc", content: [block] }));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const ITEMS_SEP = "\u0000";

export const DecisionsEditor = forwardRef<DecisionsEditorHandle, Omit<Props, "initial" | "onValue"> & {
  initial: readonly string[];
  onItems?: (items: string[]) => void;
}>(function DecisionsEditor({ initial, onItems, ...rest }, ref) {
  const inner = useRef<RichEditorHandle>(null);
  useImperativeHandle(ref, () => ({
    getItems: () => split(inner.current?.getMarkdown() ?? initial.join(ITEMS_SEP)),
    reset: (items) => inner.current?.reset(items?.join(ITEMS_SEP)),
  }), [initial]);
  return (
    <EditorCore
      {...rest}
      ref={inner}
      initial={initial.join(ITEMS_SEP)}
      toDoc={(s) => decisionsToDoc(split(s))}
      fromDoc={(d) => docToDecisions(d).join(ITEMS_SEP)}
      onValue={onItems ? (s) => onItems(split(s)) : undefined}
    />
  );
});

function split(s: string): string[] {
  return s ? s.split(ITEMS_SEP) : [];
}

const EditorCore = forwardRef<RichEditorHandle, Props & {
  toDoc: (value: string) => JSONContent;
  fromDoc: (doc: JSONContent) => string;
}>(function EditorCore({ label, initial, disabled, onDirtyChange, onValue, minHeight, toDoc, fromDoc }, ref) {
  useEffect(ensurePaletteStyle, []);
  // 처음 값의 정규화 결과. 같으면 바뀐 것이 없다(열어 보기만 하면 원래 문자열을 그대로 둔다)
  const baseline = useRef({ raw: initial, normalized: fromDoc(toDoc(initial)) });
  const dirtyRef = useRef(false);
  const callbacks = useRef({ onDirtyChange, onValue, fromDoc });
  callbacks.current = { onDirtyChange, onValue, fromDoc };

  const editor = useEditor({
    extensions: editorExtensions(),
    content: toDoc(initial),
    editable: !disabled,
    editorProps: {
      attributes: { class: "rt-content", "aria-label": label, role: "textbox", "aria-multiline": "true" },
    },
  });

  // 바뀐 여부: 입력이 잠시 멈춘 뒤 한 번 계산한다(조합 중에는 계산하지 않음)
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (editor.view.composing) return;
      const value = callbacks.current.fromDoc(editor.getJSON());
      const dirty = value !== baseline.current.normalized;
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty;
        callbacks.current.onDirtyChange?.(dirty);
      }
      callbacks.current.onValue?.(dirty ? value : baseline.current.raw);
    };
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 250);
    };
    const onCompositionEnd = () => onUpdate();
    editor.on("update", onUpdate);
    editor.view.dom.addEventListener("compositionend", onCompositionEnd);
    return () => {
      clearTimeout(timer);
      editor.off("update", onUpdate);
      editor.view.dom.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useImperativeHandle(ref, () => ({
    getMarkdown() {
      if (!editor) return baseline.current.raw;
      const value = fromDoc(editor.getJSON());
      return value === baseline.current.normalized ? baseline.current.raw : value;
    },
    reset(markdown) {
      const next = markdown ?? baseline.current.raw;
      baseline.current = { raw: next, normalized: fromDoc(toDoc(next)) };
      editor?.commands.setContent(toDoc(next), { emitUpdate: false });
      if (dirtyRef.current) {
        dirtyRef.current = false;
        callbacks.current.onDirtyChange?.(false);
      }
    },
  }), [editor, fromDoc, toDoc]);

  return (
    <div className="rt-editor" aria-disabled={disabled || undefined}>
      <span className="md-label">{label}</span>
      {editor && <Toolbar editor={editor} disabled={disabled} />}
      <div className="rt-surface" style={minHeight ? { minHeight } : undefined} onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});

// ───────── 도구 모음 ─────────

export type ColorState = { mixed: true } | { mixed: false; color: string | null };

/** 색상 박스 표시: 선택 영역의 색(여러 색이면 혼합), 선택이 없으면 이후 입력할 글자색 */
export function colorState(editor: Editor): ColorState {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const colorOf = (marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[]) => {
    const m = marks.find((x) => x.type.name === "textStyle");
    return typeof m?.attrs.color === "string" ? m.attrs.color : null;
  };
  if (empty) return { mixed: false, color: colorOf(state.storedMarks ?? state.selection.$from.marks()) };
  const seen = new Set<string | null>();
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) seen.add(colorOf(node.marks));
  });
  if (seen.size > 1) return { mixed: true };
  return { mixed: false, color: seen.size ? [...seen][0]! : null };
}

/**
 * 저장해 둔 선택 영역에 글자색을 적용한다(팔레트를 여는 동안 선택이 풀려도 원래 영역에 적용).
 * color = null은 ‘기본색’: 색 지정을 해제해 테마 글자색을 따른다.
 */
export function applyColor(editor: Editor, selection: { from: number; to: number } | null, color: string | null): void {
  let chain = editor.chain().focus();
  if (selection) chain = chain.setTextSelection(selection);
  (color ? chain.setMark("textStyle", { color }) : chain.setMark("textStyle", { color: null }).removeEmptyTextStyle()).run();
}

/** 한글 조합 중이면 조합이 끝난 뒤 실행한다(글자 조합·커서 위치를 깨지 않게) */
export function afterComposition(editor: Editor, fn: () => void) {
  if (editor.view.composing) editor.view.dom.addEventListener("compositionend", () => setTimeout(fn, 0), { once: true });
  else fn();
}

/** 도구 버튼이 포커스·선택 영역을 가져가지 않게 한다 */
const keepSelection = (e: ReactPointerEvent | ReactMouseEvent) => e.preventDefault();

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      underline: ed.isActive("underline"),
      color: colorState(ed),
    }),
  });
  const [open, setOpen] = useState(false);
  const saved = useRef<{ from: number; to: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (mark: "bold" | "underline") => afterComposition(editor, () => {
    const chain = editor.chain().focus();
    (mark === "bold" ? chain.toggleBold() : chain.toggleUnderline()).run();
  });

  const pick = (color: string | null) => {
    const sel = saved.current;
    setOpen(false);
    afterComposition(editor, () => applyColor(editor, sel, color));
  };

  const current = s.color;
  const currentLabel = current.mixed ? "여러 색 섞임" : current.color ? PALETTE.find((c) => c.value === current.color)?.label ?? "색" : "기본색";

  return (
    <div className="rt-toolbar" role="toolbar" aria-label="서식">
      <button type="button" className="rt-tool rt-bold" aria-label="굵게" aria-pressed={s.bold} disabled={disabled}
        onPointerDown={keepSelection} onMouseDown={keepSelection} onClick={() => toggle("bold")}>B</button>
      <button type="button" className="rt-tool rt-underline" aria-label="밑줄" aria-pressed={s.underline} disabled={disabled}
        onPointerDown={keepSelection} onMouseDown={keepSelection} onClick={() => toggle("underline")}>가</button>
      <div className="rt-color-wrap" ref={boxRef}>
        <button type="button" className="rt-tool rt-color" aria-label={`글자색: ${currentLabel}`} aria-haspopup="true" aria-expanded={open}
          disabled={disabled} onPointerDown={keepSelection} onMouseDown={keepSelection}
          onClick={() => {
            const { from, to } = editor.state.selection;
            saved.current = { from, to };
            setOpen((v) => !v);
          }}>
          <span className={`rt-swatch${current.mixed ? " rt-mixed" : ""}${!current.mixed && !current.color ? " rt-default" : ""}`}
            style={!current.mixed && current.color ? { background: current.color } : undefined}
            data-rt-swatch={!current.mixed && current.color ? current.color : undefined} />
        </button>
        {open && (
          <div className="rt-palette" role="menu" aria-label="글자색 선택">
            <button type="button" role="menuitemradio" aria-checked={!current.mixed && !current.color} className="rt-chip"
              onPointerDown={keepSelection} onMouseDown={keepSelection} onClick={() => pick(null)}>
              <span className="rt-swatch rt-default" /> 기본색
            </button>
            {PALETTE.map((c) => (
              <button key={c.id} type="button" role="menuitemradio" aria-checked={!current.mixed && current.color === c.value}
                className="rt-chip" title={c.label} aria-label={c.label}
                onPointerDown={keepSelection} onMouseDown={keepSelection} onClick={() => pick(c.value)}>
                <span className="rt-swatch" style={{ background: c.value }} data-rt-swatch={c.value} />
              </button>
            ))}
          </div>
        )}
      </div>
      {current.mixed && <span className="muted rt-mixed-label">여러 색</span>}
    </div>
  );
}
