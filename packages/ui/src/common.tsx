// 화면 공통 조각. 서버·AI 문자열은 React 텍스트로만 렌더링한다(HTML로 해석하지 않는다).

import type { ReactNode } from "react";
import { ApiRequestError, type Tone } from "@meeting/client-core";

const CODE_MESSAGES: Record<string, string> = {
  VERSION_CONFLICT: "다른 기기에서 먼저 수정했습니다. 최신 내용을 불러왔으니 다시 확인하세요.",
  STALE_SOURCE: "회의록이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 실행하세요.",
  PAYLOAD_CHANGED: "확인한 내용과 현재 후보가 다릅니다. 다시 확인하세요.",
  CANDIDATE_LOCKED: "등록 중이거나 등록된 일정은 바꿀 수 없습니다.",
  GOOGLE_AUTH_REQUIRED: "설정에서 Google 캘린더를 먼저 연결하세요.",
  JOB_IN_PROGRESS: "이미 진행 중인 작업이 있습니다.",
  SERVICE_UNAVAILABLE: "서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.",
  UNAUTHENTICATED: "다시 로그인하세요.",
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return CODE_MESSAGES[e.code] ?? (e.apiError.error.message || `요청이 실패했습니다 (${e.code}).`);
  }
  return e instanceof Error ? e.message : String(e);
}

/** 서버 최신 상태를 다시 읽어야 하는 오류인지 */
export function needsRefresh(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status === 409;
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`} role="status">{children}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="error" role="alert">{children}</p>;
}

/** 실행 전 대상·내용 확인. 확인 버튼을 눌러야만 onConfirm이 실행된다. */
export function ConfirmBox(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm" role="dialog" aria-label={props.title}>
      <strong>{props.title}</strong>
      <div className="confirm-body">{props.children}</div>
      <div className="row">
        <button type="button" className="primary" disabled={props.busy} onClick={props.onConfirm}>
          {props.busy ? "처리 중…" : props.confirmLabel}
        </button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
