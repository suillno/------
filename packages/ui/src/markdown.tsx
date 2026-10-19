// Markdown 편집/미리보기 (docs/plans/2026-10-19-meeting-features.md 5장).
// 원문은 그대로 저장하고, 미리보기는 React 요소로만 만든다.
// - HTML 원문은 렌더링하지 않는다(skipHtml): <script>·이벤트 속성·iframe 등이 실행되지 않는다.
// - 링크는 이동하지 않는 텍스트로 보여 준다(앱 화면이 외부 페이지로 바뀌거나 javascript: 링크가 실행되지 않게).
// - 이미지는 불러오지 않고 대체 텍스트만 보인다(첫 버전은 텍스트·Markdown만 다룬다).

import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_URL = /^https?:\/\//i;

const components: Components = {
  a({ href, children }) {
    const url = typeof href === "string" && SAFE_URL.test(href) ? href : null;
    return (
      <span className="md-link" title={url ?? undefined}>
        {children}
        {url && <span className="muted"> ({url})</span>}
      </span>
    );
  },
  img({ alt }) {
    return <span className="muted">[이미지{alt ? `: ${alt}` : ""}]</span>;
  },
};

export function MarkdownView({ source, empty = "(본문 없음)" }: { source: string; empty?: string }) {
  if (!source.trim()) return <p className="muted">{empty}</p>;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} urlTransform={(u) => (SAFE_URL.test(u) ? u : "")}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** 편집 / 미리보기 전환. 저장되는 값은 항상 Markdown 원문이다. */
export function MarkdownEditor(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  return (
    <div className="md-editor">
      <div className="row between">
        <span className="md-label">{props.label}</span>
        <div className="md-tabs" role="tablist" aria-label={`${props.label} 보기 방식`}>
          <button type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>편집</button>
          <button type="button" role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")}>미리보기</button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea aria-label={props.label} rows={props.rows ?? 10} value={props.value} disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <div className="md-preview"><MarkdownView source={props.value} /></div>
      )}
      {props.footer}
    </div>
  );
}

/** 회의 상세 본문: 미리보기가 기본이고 원문 보기로 전환할 수 있다 */
export function MarkdownBody({ source }: { source: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div>
      <div className="row between">
        <span />
        <button type="button" className="m-link" onClick={() => setRaw(!raw)}>{raw ? "미리보기" : "원문 보기"}</button>
      </div>
      {raw ? <p className="body-text">{source || "(본문 없음)"}</p> : <MarkdownView source={source} />}
    </div>
  );
}
