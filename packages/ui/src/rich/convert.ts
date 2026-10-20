// 저장 형식(Markdown + <u>·글자색 span) ↔ 편집기 문서(Tiptap JSON) 변환.
// docs/plans/2026-10-20-rich-text.md 2장. 해석 규칙은 서버와 같은 richtext.ts(parseMarkdown·foldInline)를 쓴다.
// - 편집기가 다루지 못하는 요소(HTML 블록·각주·정의·이미지 등)는 원래 Markdown을 그대로 담은 보존 노드로 둔다.
// - 직렬화는 mdast-util-to-markdown(GFM)으로 하므로 글자 속 *, <, | 같은 기호는 자동으로 이스케이프된다.

import { foldInline, isPaletteColor, parseMarkdown, type InlineNode } from "@meeting/client-core";
import type { JSONContent } from "@tiptap/core";
import type { BlockContent, ListItem, Nodes, PhrasingContent, Root, RootContent, Table, TableCell, TableRow } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

export const PRESERVED_BLOCK = "preservedBlock";
export const PRESERVED_INLINE = "preservedInline";

type Mark = { type: string; attrs?: Record<string, unknown> };

// ───────── Markdown → 편집기 문서 ─────────

export function markdownToDoc(markdown: string): JSONContent {
  const root = parseMarkdown(markdown);
  const content = blocksToDoc(root.children, markdown);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function slice(source: string, n: Nodes): string {
  const s = n.position?.start.offset;
  const e = n.position?.end.offset;
  return s !== undefined && e !== undefined ? source.slice(s, e) : "";
}

function preservedBlock(source: string, n: Nodes): JSONContent {
  return { type: PRESERVED_BLOCK, attrs: { markdown: slice(source, n) } };
}

function blocksToDoc(nodes: readonly RootContent[], source: string): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph":
        out.push(paragraph(n.children, source));
        break;
      case "heading":
        out.push({ type: "heading", attrs: { level: n.depth }, content: inlineContent(n.children, source) });
        break;
      case "blockquote":
        out.push({ type: "blockquote", content: nonEmpty(blocksToDoc(n.children, source)) });
        break;
      case "list": {
        const task = n.children.some((i) => i.checked !== null && i.checked !== undefined);
        if (task) {
          out.push({ type: "taskList", content: n.children.map((i) => ({ type: "taskItem", attrs: { checked: i.checked === true }, content: itemBlocks(i, source) })) });
        } else if (n.ordered) {
          out.push({ type: "orderedList", attrs: { start: n.start ?? 1 }, content: n.children.map((i) => ({ type: "listItem", content: itemBlocks(i, source) })) });
        } else {
          out.push({ type: "bulletList", content: n.children.map((i) => ({ type: "listItem", content: itemBlocks(i, source) })) });
        }
        break;
      }
      case "code":
        out.push({ type: "codeBlock", attrs: { language: n.lang ?? null }, content: n.value ? [{ type: "text", text: n.value }] : [] });
        break;
      case "thematicBreak":
        out.push({ type: "horizontalRule" });
        break;
      case "table":
        out.push(tableToDoc(n, source));
        break;
      default:
        out.push(preservedBlock(source, n));
    }
  }
  return out;
}

function nonEmpty(blocks: JSONContent[]): JSONContent[] {
  return blocks.length ? blocks : [{ type: "paragraph" }];
}

/** 목록 항목은 문단으로 시작해야 한다(편집기 스키마) */
function itemBlocks(item: ListItem, source: string): JSONContent[] {
  const blocks = blocksToDoc(item.children, source);
  if (blocks[0]?.type !== "paragraph") blocks.unshift({ type: "paragraph" });
  return blocks;
}

function tableToDoc(t: Table, source: string): JSONContent {
  const width = Math.max(1, ...t.children.map((r) => r.children.length));
  return {
    type: "table",
    content: t.children.map((row, ri) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_, ci) => {
        const cell = row.children[ci];
        return { type: ri === 0 ? "tableHeader" : "tableCell", content: [paragraph(cell ? cell.children : [], source)] };
      }),
    })),
  };
}

function paragraph(children: readonly PhrasingContent[], source: string): JSONContent {
  const content = inlineContent(children, source);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function inlineContent(children: readonly PhrasingContent[], source: string): JSONContent[] {
  // 이미지처럼 편집기가 다루지 못하는 인라인은 원래 Markdown 조각을 보존한다
  const out: JSONContent[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    if (run.length) out.push(...inlineToDoc(foldInline(run), []));
    run = [];
  };
  for (const c of children) {
    if (c.type === "image" || c.type === "imageReference" || c.type === "footnoteReference" || c.type === "linkReference") {
      flush();
      const md = slice(source, c);
      out.push({ type: PRESERVED_INLINE, attrs: { markdown: md, label: c.type === "image" || c.type === "imageReference" ? `[이미지${c.alt ? `: ${c.alt}` : ""}]` : md } });
    } else run.push(c);
  }
  flush();
  return out;
}

function inlineToDoc(nodes: InlineNode[], marks: Mark[]): JSONContent[] {
  const out: JSONContent[] = [];
  const text = (value: string) => {
    const parts = value.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) out.push({ type: "hardBreak" });
      if (p) out.push(marks.length ? { type: "text", text: p, marks: marks.map((m) => ({ ...m })) } : { type: "text", text: p });
    });
  };
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        text(n.value);
        break;
      case "break":
        out.push({ type: "hardBreak" });
        break;
      case "inlineCode":
        out.push({ type: "text", text: n.value, marks: [...marks, { type: "code" }] });
        break;
      case "strong":
        out.push(...inlineToDoc(n.children, [...marks, { type: "bold" }]));
        break;
      case "emphasis":
        out.push(...inlineToDoc(n.children, [...marks, { type: "italic" }]));
        break;
      case "delete":
        out.push(...inlineToDoc(n.children, [...marks, { type: "strike" }]));
        break;
      case "underline":
        out.push(...inlineToDoc(n.children, [...marks, { type: "underline" }]));
        break;
      case "color":
        // 팔레트 밖 색은 색 없이 글자만 둔다
        out.push(...inlineToDoc(n.children, isPaletteColor(n.color)
          ? [...marks.filter((m) => m.type !== "textStyle"), { type: "textStyle", attrs: { color: n.color } }]
          : marks));
        break;
      case "link":
        out.push(...inlineToDoc(n.children, [...marks, { type: "link", attrs: { href: n.url } }]));
        break;
      case "image":
        out.push({ type: "text", text: n.alt ? `[이미지: ${n.alt}]` : "[이미지]", marks });
        break;
    }
  }
  return out;
}

// ───────── 편집기 문서 → Markdown ─────────

export function docToMarkdown(doc: JSONContent): string {
  const root: Root = { type: "root", children: docBlocks(doc.content ?? []) as RootContent[] };
  const md = toMarkdown(root, {
    extensions: [gfmToMarkdown()],
    bullet: "-",
    emphasis: "*",
    strong: "*",
    rule: "-",
    fences: true,
    listItemIndent: "one",
  });
  return md.replace(/\n+$/, "");
}

function docBlocks(nodes: JSONContent[]): (BlockContent | Nodes)[] {
  const out: (BlockContent | Nodes)[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph":
        out.push({ type: "paragraph", children: docInline(n.content ?? []) });
        break;
      case "heading":
        out.push({ type: "heading", depth: clampDepth(n.attrs?.level), children: docInline(n.content ?? []) });
        break;
      case "blockquote":
        out.push({ type: "blockquote", children: docBlocks(n.content ?? []) as BlockContent[] });
        break;
      case "bulletList":
      case "orderedList":
      case "taskList":
        out.push({
          type: "list",
          ordered: n.type === "orderedList",
          start: n.type === "orderedList" ? Number(n.attrs?.start ?? 1) : null,
          spread: false,
          children: (n.content ?? []).map((item): ListItem => ({
            type: "listItem",
            spread: false,
            checked: n.type === "taskList" ? Boolean(item.attrs?.checked) : null,
            children: docBlocks(item.content ?? []) as BlockContent[],
          })),
        });
        break;
      case "codeBlock":
        out.push({ type: "code", lang: (n.attrs?.language as string | null) ?? null, value: (n.content ?? []).map((t) => t.text ?? "").join("") });
        break;
      case "horizontalRule":
        out.push({ type: "thematicBreak" });
        break;
      case "table":
        out.push({
          type: "table",
          align: null,
          children: (n.content ?? []).map((row): TableRow => ({
            type: "tableRow",
            children: (row.content ?? []).map((cell): TableCell => ({
              type: "tableCell",
              // 셀 안 여러 문단은 줄바꿈으로 잇는다(Markdown 표 셀은 한 줄)
              children: (cell.content ?? []).flatMap((b, i) => [
                ...(i > 0 ? [{ type: "break" } as PhrasingContent] : []),
                ...docInline(b.content ?? []),
              ]),
            })),
          })),
        });
        break;
      case PRESERVED_BLOCK:
        out.push({ type: "html", value: String(n.attrs?.markdown ?? "") });
        break;
      default:
        // 알 수 없는 블록은 글자만 남긴다
        out.push({ type: "paragraph", children: docInline(n.content ?? []) });
    }
  }
  return out;
}

function clampDepth(v: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = Math.min(6, Math.max(1, Number(v) || 1));
  return n as 1 | 2 | 3 | 4 | 5 | 6;
}

// 바깥쪽부터 감싸는 순서. 같은 서식이 이어진 글자는 한 번만 감싼다(**a****b** 방지).
const MARK_ORDER = ["link", "bold", "italic", "strike", "underline", "textStyle", "code"] as const;

interface Piece {
  kind: "text" | "break" | "raw";
  text: string;
  marks: Mark[];
}

function docInline(nodes: JSONContent[]): PhrasingContent[] {
  const pieces: Piece[] = [];
  for (const n of nodes) {
    if (n.type === "text") pieces.push({ kind: "text", text: n.text ?? "", marks: normalizeMarks(n.marks as Mark[] | undefined) });
    else if (n.type === "hardBreak") pieces.push({ kind: "break", text: "", marks: [] });
    else if (n.type === PRESERVED_INLINE) pieces.push({ kind: "raw", text: String(n.attrs?.markdown ?? ""), marks: [] });
  }
  return wrap(pieces, 0);
}

function normalizeMarks(marks: Mark[] | undefined): Mark[] {
  return (marks ?? []).filter((m) => {
    if (m.type === "textStyle") return typeof m.attrs?.color === "string" && isPaletteColor(m.attrs.color);
    if (m.type === "link") return typeof m.attrs?.href === "string" && /^https?:\/\//i.test(m.attrs.href);
    return (MARK_ORDER as readonly string[]).includes(m.type);
  });
}

function markKey(m: Mark | undefined): string {
  if (!m) return "";
  if (m.type === "link") return `link:${String(m.attrs?.href)}`;
  if (m.type === "textStyle") return `color:${String(m.attrs?.color).toLowerCase()}`;
  return m.type;
}

function markAt(p: Piece, level: number): Mark | undefined {
  const type = MARK_ORDER[level];
  return p.marks.find((m) => m.type === type);
}

function wrap(pieces: Piece[], level: number): PhrasingContent[] {
  if (level >= MARK_ORDER.length) {
    return pieces.flatMap((p): PhrasingContent[] => {
      if (p.kind === "break") return [{ type: "break" }];
      if (p.kind === "raw") return [{ type: "html", value: p.text }];
      return p.text ? [{ type: "text", value: p.text }] : [];
    });
  }
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < pieces.length) {
    const key = markKey(markAt(pieces[i]!, level));
    let j = i + 1;
    // 줄바꿈은 바깥 서식을 끊지 않는다(같은 서식 사이의 줄바꿈)
    while (j < pieces.length && markKey(markAt(pieces[j]!, level)) === key) j++;
    const group = pieces.slice(i, j);
    const mark = markAt(pieces[i]!, level);
    const inner = wrap(group, level + 1);
    if (!mark) out.push(...inner);
    else out.push(...applyMark(mark, inner, group));
    i = j;
  }
  return out;
}

function applyMark(mark: Mark, inner: PhrasingContent[], group: Piece[]): PhrasingContent[] {
  switch (mark.type) {
    case "link":
      return [{ type: "link", url: String(mark.attrs?.href), children: inner }];
    case "bold":
      return [{ type: "strong", children: inner }];
    case "italic":
      return [{ type: "emphasis", children: inner }];
    case "strike":
      return [{ type: "delete", children: inner }];
    case "underline":
      return [{ type: "html", value: "<u>" }, ...inner, { type: "html", value: "</u>" }];
    case "textStyle":
      return [{ type: "html", value: `<span style="color:${String(mark.attrs?.color).toLowerCase()}">` }, ...inner, { type: "html", value: "</span>" }];
    case "code":
      return [{ type: "inlineCode", value: group.map((p) => (p.kind === "break" ? " " : p.text)).join("") }];
    default:
      return inner;
  }
}
