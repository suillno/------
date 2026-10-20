// 서식 있는 회의 본문·요약의 공통 규칙 (docs/plans/2026-10-20-rich-text.md, ADR 0005).
// 서버(Edge Function, Deno)와 PC 앱·화면(TS)이 이 파일 하나를 함께 쓴다. 같은 입력에서 같은 결과가 나와야 한다.
//
// 저장 형식: Markdown(GFM) + 허용 인라인 태그 2종
//   <u>밑줄</u>, <span style="color:#rrggbb">글자색</span> (팔레트 색만)
// 그 밖의 HTML은 표시할 때 태그를 버리고 글자만 남긴다(<br>은 줄바꿈). 실행하지 않는다.
//
// 라이브러리 버전은 Node(package.json)와 Deno(각 함수의 deno.json)에서 같은 값으로 고정한다.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { ListItem, Nodes, PhrasingContent, Root, RootContent } from "mdast";

/** 변환 규칙 버전. 규칙을 바꾸면 올리고 이행 방법을 함께 정한다(분석 기준 비교에 들어간다). */
export const ANALYSIS_TEXT_VERSION = "analysis-text/v1";

// ───────── 글자색 팔레트 ─────────

export interface PaletteColor {
  id: string;
  label: string;
  /** 저장값(기기 간 공통). 밝은 화면 표시색과 같다 */
  value: string;
  /** 어두운 화면에서 보여 줄 색(저장값은 그대로) */
  dark: string;
}

/** ‘기본색’은 목록에 없다. 기본색을 고르면 색 지정을 해제해 테마 글자색을 따른다. */
export const PALETTE: readonly PaletteColor[] = [
  { id: "red", label: "빨강", value: "#c92a2a", dark: "#ff8787" },
  { id: "orange", label: "주황", value: "#b4430b", dark: "#ffa94d" },
  { id: "yellow", label: "노랑", value: "#8a6100", dark: "#ffd43b" },
  { id: "green", label: "초록", value: "#2b7a3b", dark: "#69db7c" },
  { id: "teal", label: "청록", value: "#0b6e7f", dark: "#66d9e8" },
  { id: "blue", label: "파랑", value: "#1864ab", dark: "#74c0fc" },
  { id: "violet", label: "보라", value: "#6741d9", dark: "#b197fc" },
  { id: "pink", label: "분홍", value: "#a61e4d", dark: "#f783ac" },
  { id: "gray", label: "회색", value: "#495057", dark: "#adb5bd" },
];

const PALETTE_VALUES = new Set(PALETTE.map((c) => c.value));

export function isPaletteColor(value: string): boolean {
  return PALETTE_VALUES.has(value.toLowerCase());
}

// ───────── 허용 인라인 태그 ─────────

const U_OPEN = /^<u>$/i;
const U_CLOSE = /^<\/u>$/i;
const COLOR_OPEN = /^<span\s+style\s*=\s*"\s*color\s*:\s*(#[0-9a-f]{6})\s*;?\s*">$/i;
const SPAN_CLOSE = /^<\/span>$/i;
const BR = /^<br\s*\/?>$/i;

/** 저장 형식이 만드는 글자색 태그(값 검사용). 팔레트 밖 색이면 서버·화면이 거절한다. */
const COLOR_TAG_ANYWHERE = /<span\s+style\s*=\s*"\s*color\s*:\s*(#[0-9a-fA-F]{6})\s*;?\s*">/g;

/** 본문·요약에 팔레트 밖 글자색 태그가 있으면 그 값을 돌려준다(없으면 빈 배열). */
export function foreignColors(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(COLOR_TAG_ANYWHERE)) if (!isPaletteColor(m[1]!)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** 표시·편집용으로 허용 태그를 짝지은 인라인 노드 */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "break" }
  | { type: "strong" | "emphasis" | "delete"; children: InlineNode[] }
  | { type: "underline"; children: InlineNode[] }
  | { type: "color"; color: string; children: InlineNode[] }
  | { type: "inlineCode"; value: string }
  | { type: "link"; url: string; children: InlineNode[] }
  | { type: "image"; alt: string };

type Frame = { kind: "root" | "underline" | "color" | "drop"; color?: string; tag?: string; children: InlineNode[] };

const DROP_OPEN = /^<(script|style)(?:\s[^>]*)?>$/i;

/**
 * mdast 인라인 노드를 허용 태그를 짝지은 트리로 바꾼다.
 * 짝이 맞지 않는 태그·허용 밖 태그는 버리고 글자만 남긴다.
 */
export function foldInline(nodes: readonly PhrasingContent[]): InlineNode[] {
  const stack: Frame[] = [{ kind: "root", children: [] }];
  const top = () => stack[stack.length - 1]!;
  for (const n of nodes) {
    if (n.type === "html") {
      const v = n.value.trim();
      const color = COLOR_OPEN.exec(v);
      const drop = DROP_OPEN.exec(v);
      if (drop) stack.push({ kind: "drop", tag: drop[1]!.toLowerCase(), children: [] });
      else if (top().kind === "drop") {
        // <script>·<style> 안의 글자는 버린다
        if (v.toLowerCase().replace(/\s+/g, "") === `</${top().tag}>`) stack.pop();
      } else if (U_OPEN.test(v)) stack.push({ kind: "underline", children: [] });
      else if (color) stack.push({ kind: "color", color: color[1]!.toLowerCase(), children: [] });
      else if (U_CLOSE.test(v) || SPAN_CLOSE.test(v)) {
        const want = U_CLOSE.test(v) ? "underline" : "color";
        const idx = findLast(stack, (f) => f.kind === want);
        if (idx > 0) {
          // 사이에 닫히지 않은 태그가 있으면 글자만 남기고 닫는다
          while (stack.length - 1 > idx) {
            const f = stack.pop()!;
            top().children.push(...f.children);
          }
          const f = stack.pop()!;
          top().children.push(f.kind === "underline"
            ? { type: "underline", children: f.children }
            : { type: "color", color: f.color!, children: f.children });
        }
      } else if (BR.test(v)) top().children.push({ type: "break" });
      else {
        const text = stripTags(n.value);
        if (text) top().children.push({ type: "text", value: text });
      }
      continue;
    }
    if (top().kind !== "drop") top().children.push(...convertInline(n));
  }
  while (stack.length > 1) {
    const f = stack.pop()!;
    if (f.kind !== "drop") top().children.push(...f.children);
  }
  return mergeText(stack[0]!.children);
}

function convertInline(n: PhrasingContent): InlineNode[] {
  switch (n.type) {
    case "text":
      return [{ type: "text", value: n.value }];
    case "break":
      return [{ type: "break" }];
    case "strong":
    case "emphasis":
    case "delete":
      return [{ type: n.type, children: foldInline(n.children) }];
    case "inlineCode":
      return [{ type: "inlineCode", value: n.value }];
    case "link":
      return [{ type: "link", url: n.url, children: foldInline(n.children) }];
    case "linkReference":
      return foldInline(n.children);
    case "image":
      return [{ type: "image", alt: n.alt ?? "" }];
    case "imageReference":
      return [{ type: "image", alt: n.alt ?? "" }];
    case "footnoteReference":
      return [{ type: "text", value: `[^${n.label ?? n.identifier}]` }];
    case "html":
      return [];
    default:
      return [];
  }
}

function findLast<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

function mergeText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text") last.value += n.value;
    else out.push(n.type === "text" ? { ...n } : n);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** HTML 조각에서 태그를 버리고 글자만 남긴다(<br>·블록 태그는 줄바꿈). 실행·해석하지 않는다. */
export function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// ───────── 해석 ─────────

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

// ───────── AI 입력 텍스트·보이는 텍스트 ─────────

interface TextOptions {
  /** 목록·인용 접두(- , 1. , [x] , > )를 붙인다 */
  prefixes: boolean;
  /** 링크 주소를 ‘글자 (주소)’로 남긴다 */
  linkUrls: boolean;
  /** 표 셀 구분 */
  cellSeparator: string;
}

const ANALYSIS: TextOptions = { prefixes: true, linkUrls: true, cellSeparator: " | " };
const VISIBLE: TextOptions = { prefixes: false, linkUrls: false, cellSeparator: "\t" };

/**
 * AI에 전달하는 읽는 텍스트. 굵게·밑줄·색·제목 기호는 빼고, 링크 주소·표 셀·목록 구분·줄바꿈은 남긴다.
 * 문단 사이 빈 줄 수, 목록 기호 종류(*, -), 번호 표기처럼 서식 편집기가 바꿀 수 있는 표기 차이는 결과에 영향을 주지 않는다.
 */
export function analysisText(markdown: string): string {
  return render(parseMarkdown(markdown), ANALYSIS);
}

/** 화면에 보이는 글자(글자 수 기준). 접두 기호·링크 주소를 빼고 셀은 탭 1자로 구분한다. */
export function visibleText(markdown: string): string {
  return render(parseMarkdown(markdown), VISIBLE);
}

/** 보이는 글자 수(유니코드 코드 포인트). 화면·Edge Function·SQL(char_length)이 같은 값을 쓴다. */
export function visibleLength(markdown: string): number {
  return codePoints(visibleText(markdown));
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function render(root: Root, o: TextOptions): string {
  const lines = blocks(root.children, o);
  return lines.map((l) => l.replace(/[ \t]+$/u, "")).filter((l) => l.trim() !== "").join("\n").trim();
}

function blocks(nodes: readonly (RootContent | Nodes)[], o: TextOptions): string[] {
  const out: string[] = [];
  for (const n of nodes) out.push(...block(n as RootContent, o));
  return out;
}

function block(n: RootContent, o: TextOptions): string[] {
  switch (n.type) {
    case "paragraph":
    case "heading":
      return inlineText(foldInline(n.children), o).split("\n");
    case "blockquote": {
      const inner = blocks(n.children, o);
      return o.prefixes ? inner.map((l) => `> ${l}`) : inner;
    }
    case "list": {
      const out: string[] = [];
      n.children.forEach((item, i) => {
        const marker = n.ordered ? `${(n.start ?? 1) + i}. ` : "- ";
        out.push(...listItem(item, marker, o));
      });
      return out;
    }
    case "code":
      return n.value.split("\n");
    case "table":
      return n.children.map((row) => row.children.map((cell) => inlineText(foldInline(cell.children), o).replace(/\n/g, " ")).join(o.cellSeparator));
    case "thematicBreak":
      return o.prefixes ? ["---"] : [];
    case "html":
      return stripTags(n.value).split("\n");
    case "definition":
      return o.linkUrls ? [`[${n.label ?? n.identifier}]: ${n.url}`] : [];
    case "footnoteDefinition": {
      const inner = blocks(n.children, o);
      return inner.length ? [`[^${n.label ?? n.identifier}]: ${inner[0]}`, ...inner.slice(1)] : [];
    }
    default:
      return [];
  }
}

function listItem(item: ListItem, marker: string, o: TextOptions): string[] {
  const check = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
  const inner = blocks(item.children, o).filter((l) => l.trim() !== "");
  if (!o.prefixes) return check && inner.length ? [`${check}${inner[0]}`, ...inner.slice(1)] : inner;
  if (inner.length === 0) return [`${marker}${check}`.trimEnd()];
  return [`${marker}${check}${inner[0]}`, ...inner.slice(1).map((l) => `  ${l}`)];
}

function inlineText(nodes: InlineNode[], o: TextOptions): string {
  let s = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text":
      case "inlineCode":
        s += n.value;
        break;
      case "break":
        s += "\n";
        break;
      case "image":
        s += n.alt ? `[이미지: ${n.alt}]` : "[이미지]";
        break;
      case "link": {
        const text = inlineText(n.children, o);
        s += o.linkUrls && n.url && n.url !== text ? (text ? `${text} (${n.url})` : n.url) : text;
        break;
      }
      default:
        s += inlineText(n.children, o);
    }
  }
  return s;
}

// ───────── 분석 기준 ─────────

export interface AnalysisInput {
  title: string;
  body: string;
  /** ISO 8601 (어떤 오프셋이든 같은 순간이면 같은 기준) */
  meeting_at: string;
  time_zone: string;
}

/**
 * 원문 변경 판정에 쓰는 분석 기준 문자열. 같으면 서식만 바뀐 것이고 기존 분석 결과·일정 후보를 유지한다.
 * 분석 추가 요청사항은 작업마다 고정되며 작업 입력 해시에 들어간다.
 */
export function analysisBasis(input: AnalysisInput): string {
  const at = new Date(input.meeting_at);
  return JSON.stringify({
    v: ANALYSIS_TEXT_VERSION,
    title: input.title,
    meeting_at: Number.isNaN(at.getTime()) ? input.meeting_at : at.toISOString(),
    time_zone: input.time_zone,
    text: analysisText(input.body),
  });
}

export function analysisChanged(before: AnalysisInput, after: AnalysisInput): boolean {
  return analysisBasis(before) !== analysisBasis(after);
}

// ───────── 길이 제한 (화면·Edge Function·SQL 공통) ─────────

export const LIMITS = {
  summaryVisible: 4000,
  /** 서식 포함 저장 한도. 모든 문장에 굵게+밑줄+색을 넣어도 들어가는 값으로 측정해 정했다(richtext.test.ts L02) */
  summaryStored: 12000,
  decisionVisible: 1000,
  decisionStored: 3000,
  decisionCount: 50,
} as const;

export type NotesIssue =
  | { field: "summary"; kind: "visible" | "stored"; length: number; max: number }
  | { field: "decisions"; kind: "count"; length: number; max: number }
  | { field: "decisions"; index: number; kind: "visible" | "stored"; length: number; max: number }
  | { field: "summary" | "decisions"; kind: "color"; colors: string[]; index?: number };

/** 요약·결정사항 편집본 검사. 문제가 없으면 빈 배열. 자르지 않고 문제만 알린다. */
export function checkNotes(summary: string, decisions: readonly string[]): NotesIssue[] {
  const issues: NotesIssue[] = [];
  const sv = visibleLength(summary);
  if (sv > LIMITS.summaryVisible) issues.push({ field: "summary", kind: "visible", length: sv, max: LIMITS.summaryVisible });
  const ss = codePoints(summary);
  if (ss > LIMITS.summaryStored) issues.push({ field: "summary", kind: "stored", length: ss, max: LIMITS.summaryStored });
  const sc = foreignColors(summary);
  if (sc.length) issues.push({ field: "summary", kind: "color", colors: sc });
  if (decisions.length > LIMITS.decisionCount) issues.push({ field: "decisions", kind: "count", length: decisions.length, max: LIMITS.decisionCount });
  decisions.forEach((d, index) => {
    const v = visibleLength(d);
    if (v > LIMITS.decisionVisible) issues.push({ field: "decisions", index, kind: "visible", length: v, max: LIMITS.decisionVisible });
    const s = codePoints(d);
    if (s > LIMITS.decisionStored) issues.push({ field: "decisions", index, kind: "stored", length: s, max: LIMITS.decisionStored });
    const c = foreignColors(d);
    if (c.length) issues.push({ field: "decisions", index, kind: "color", colors: c });
  });
  return issues;
}

export function notesIssueMessage(i: NotesIssue): string {
  const where = i.field === "summary" ? "요약" : "index" in i && i.index !== undefined ? `결정사항 ${i.index + 1}번` : "결정사항";
  switch (i.kind) {
    case "visible":
      return `${where}: 글자 수가 ${i.length.toLocaleString()}자로 ${i.max.toLocaleString()}자를 넘습니다. 내용을 줄여 주세요.`;
    case "stored":
      return `${where}: 서식이 너무 많아 저장할 수 없습니다(서식 포함 ${i.length.toLocaleString()}/${i.max.toLocaleString()}자). 일부 서식을 지워 주세요.`;
    case "count":
      return `결정사항은 ${i.max}개까지 저장할 수 있습니다(현재 ${i.length}개).`;
    case "color":
      return `${where}: 허용하지 않는 글자색이 있습니다(${i.colors.join(", ")}).`;
  }
}
