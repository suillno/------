// 서식이 적용된 읽기 화면. 저장 형식(Markdown + 허용 태그)을 서버와 같은 해석 규칙으로 읽어 React 요소로만 그린다.
// - HTML 문자열을 DOM에 넣지 않는다. 허용 밖 HTML은 글자만 남는다.
// - 링크는 이동하지 않는 글자 + 주소, 이미지는 대체 문구, 표는 가로 스크롤 상자.
// - AI 출력도 Markdown으로 쓰이므로 같은 규칙으로 보여 준다(허용 태그 외 HTML은 글자만, 실행 없음).

import { Fragment, useEffect, type ReactNode } from "react";
import { foldInline, isPaletteColor, parseMarkdown, stripTags, type InlineNode } from "@meeting/client-core";
import type { ListItem, RootContent } from "mdast";
import { ensurePaletteStyle } from "./palette";

const SAFE_URL = /^https?:\/\//i;

export function RichView({ source, empty = "(본문 없음)" }: { source: string; empty?: string }) {
  useEffect(ensurePaletteStyle, []);
  if (!source.trim()) return <p className="muted">{empty}</p>;
  return <div className="rich">{blocks(parseMarkdown(source).children)}</div>;
}

/** AI 출력 같은 일반 텍스트. 줄바꿈만 살린다. */
export function PlainText({ text, empty = "(요약 없음)" }: { text: string; empty?: string }) {
  if (!text.trim()) return <p className="muted">{empty}</p>;
  return <p className="ai-text">{text}</p>;
}

function blocks(nodes: readonly RootContent[]): ReactNode[] {
  return nodes.map((n, i) => block(n, i));
}

function block(n: RootContent, key: number): ReactNode {
  switch (n.type) {
    case "paragraph":
      return <p key={key}>{inline(foldInline(n.children))}</p>;
    case "heading": {
      const H = `h${Math.min(6, Math.max(1, n.depth))}` as "h1";
      return <H key={key}>{inline(foldInline(n.children))}</H>;
    }
    case "blockquote":
      return <blockquote key={key}>{blocks(n.children)}</blockquote>;
    case "list": {
      const items = n.children.map((item, i) => listItem(item, i));
      return n.ordered
        ? <ol key={key} start={n.start ?? undefined}>{items}</ol>
        : <ul key={key} className={n.children.some((c) => typeof c.checked === "boolean") ? "rich-tasks" : undefined}>{items}</ul>;
    }
    case "code":
      return <pre key={key}><code>{n.value}</code></pre>;
    case "thematicBreak":
      return <hr key={key} />;
    case "table":
      return (
        <div key={key} className="rich-table">
          <table>
            <tbody>
              {n.children.map((row, ri) => (
                <tr key={ri}>
                  {row.children.map((cell, ci) => (ri === 0
                    ? <th key={ci}>{inline(foldInline(cell.children))}</th>
                    : <td key={ci}>{inline(foldInline(cell.children))}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "html": {
      const text = stripTags(n.value).trim();
      return text ? <p key={key}>{lines(text)}</p> : null;
    }
    case "footnoteDefinition":
      return <div key={key} className="muted rich-footnote">[^{n.label ?? n.identifier}] {blocks(n.children)}</div>;
    default:
      return null;
  }
}

function listItem(item: ListItem, key: number): ReactNode {
  const check = typeof item.checked === "boolean"
    ? <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? "완료" : "미완료"} />
    : null;
  // 붙어 있는 목록(tight)은 문단 여백 없이 보여 준다
  const children = item.spread ? blocks(item.children) : item.children.map((c, i) => (c.type === "paragraph"
    ? <Fragment key={i}>{inline(foldInline(c.children))}</Fragment>
    : block(c, i)));
  return <li key={key}>{check}{children}</li>;
}

function lines(text: string): ReactNode[] {
  return text.split("\n").flatMap((l, i) => (i ? [<br key={`b${i}`} />, l] : [l]));
}

function inline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return <Fragment key={i}>{lines(n.value)}</Fragment>;
      case "break":
        return <br key={i} />;
      case "strong":
        return <strong key={i}>{inline(n.children)}</strong>;
      case "emphasis":
        return <em key={i}>{inline(n.children)}</em>;
      case "delete":
        return <del key={i}>{inline(n.children)}</del>;
      case "underline":
        return <u key={i}>{inline(n.children)}</u>;
      case "color":
        return isPaletteColor(n.color)
          ? <span key={i} style={{ color: n.color }} data-rt-color={n.color}>{inline(n.children)}</span>
          : <Fragment key={i}>{inline(n.children)}</Fragment>;
      case "inlineCode":
        return <code key={i}>{n.value}</code>;
      case "link": {
        const url = SAFE_URL.test(n.url) ? n.url : null;
        return (
          <span key={i} className="md-link" title={url ?? undefined}>
            {inline(n.children)}
            {url && <span className="muted"> ({url})</span>}
          </span>
        );
      }
      case "image":
        return <span key={i} className="muted">[이미지{n.alt ? `: ${n.alt}` : ""}]</span>;
    }
  });
}
