// 실행 버튼의 표시·활성화 규칙과 중복 클릭 방지. 화면(packages/ui)은 이 결과만 그린다.
// 서버도 같은 규칙을 강제한다(중복 작업 반환, 상태 검사). 여기 규칙은 UX와 불필요한 요청 방지용이다.

import { jobErrorMessage, type EventCandidate, type MeetingAnalysisState } from "@meeting/contracts";
import { ApiRequestError } from "./api";
import { classifyFailure } from "./retry";

export type Tone = "idle" | "busy" | "done" | "error";

export interface ActionButton<K extends string> {
  kind: K;
  label: string;
  enabled: boolean;
  /** 비활성 이유 (title 툴팁) */
  reason?: string;
}

export interface AnalysisView {
  statusLabel: string;
  tone: Tone;
  message: string | null;
  buttons: ActionButton<"run" | "rerun" | "retry">[];
}

/** pending: 이 화면에서 보낸 요청이 아직 끝나지 않음 */
export function analysisView(state: MeetingAnalysisState, pending: boolean): AnalysisView {
  const { job, meeting } = state;
  const busyReason = "요청을 처리하는 중입니다";
  const disable = <K extends string>(b: ActionButton<K>): ActionButton<K> =>
    pending ? { ...b, enabled: false, reason: busyReason } : b;

  if (meeting.deleted) {
    return { statusLabel: "삭제된 회의록", tone: "idle", message: null, buttons: [] };
  }
  if (!job || job.status === "cancelled") {
    return { statusLabel: "분석 전", tone: "idle", message: null, buttons: [disable({ kind: "run", label: "분석 실행", enabled: true })] };
  }

  const current = job.source_revision_id === meeting.revision_id;
  const inProgress = { kind: "run" as const, label: "분석 실행", enabled: false, reason: "분석이 진행 중입니다" };
  switch (job.status) {
    case "queued":
      return { statusLabel: "대기 중", tone: "busy", message: "PC 앱이 켜져 있고 이 PC 분석이 허용되어 있으면 곧 실행됩니다.", buttons: [inProgress] };
    case "running":
      return { statusLabel: "실행 중", tone: "busy", message: "PC의 Claude Code가 분석하고 있습니다.", buttons: [inProgress] };
    case "completed":
      return current
        ? { statusLabel: "완료", tone: "done", message: null, buttons: [disable({ kind: "rerun", label: "재분석", enabled: true })] }
        : {
            statusLabel: "완료 (이전 원문 기준)",
            tone: "done",
            message: "분석 뒤에 회의록이 바뀌었습니다. 최신 내용으로 분석하려면 실행하세요.",
            buttons: [disable({ kind: "run", label: "분석 실행", enabled: true })],
          };
    case "failed": {
      const message = jobErrorMessage(job.error_code);
      if (!current || job.error_code === "SOURCE_CHANGED") {
        return { statusLabel: "실패", tone: "error", message, buttons: [disable({ kind: "run", label: "분석 실행", enabled: true })] };
      }
      return { statusLabel: "실패", tone: "error", message, buttons: [disable({ kind: "retry", label: "재시도", enabled: true })] };
    }
  }
}

export interface CandidateView {
  statusLabel: string;
  tone: Tone;
  message: string | null;
  canEdit: boolean;
  approve: ActionButton<"approve"> | null;
  retry: ActionButton<"retry"> | null;
  reject: ActionButton<"reject"> | null;
}

export function candidateView(c: EventCandidate, opts: { googleConnected: boolean; pending: boolean; dirty?: boolean }): CandidateView {
  const busy = opts.pending ? "요청을 처리하는 중입니다" : undefined;
  const lockedEdit = opts.pending;

  if (c.status === "registered") {
    return { statusLabel: "등록 완료", tone: "done", message: null, canEdit: false, approve: null, retry: null, reject: null };
  }
  if (c.status === "registering") {
    return { statusLabel: "등록 중", tone: "busy", message: null, canEdit: false, approve: null, retry: null, reject: null };
  }
  if (c.stale) {
    return {
      statusLabel: "원문 변경됨",
      tone: "idle",
      message: "회의록이 바뀌어 이 후보는 승인할 수 없습니다. 다시 분석하세요.",
      canEdit: false,
      approve: { kind: "approve", label: "승인하고 캘린더 등록", enabled: false, reason: "원문이 바뀐 후보입니다" },
      retry: null,
      reject: null,
    };
  }

  const reject = { kind: "reject" as const, label: "거절", enabled: !busy, reason: busy };
  if (c.status === "approved") {
    // 승인 직후 등록 요청이 끊겼다면 '재시도'로 같은 승인을 다시 처리한다(중복 등록은 서버가 막는다).
    return {
      statusLabel: "승인됨 · 등록 대기",
      tone: "busy",
      message: null,
      canEdit: !lockedEdit,
      approve: null,
      retry: c.calendar_job ? { kind: "retry", label: "재시도", enabled: !busy, reason: busy } : null,
      reject,
    };
  }
  if (c.status === "failed") {
    const code = c.calendar_job?.last_error_code ?? c.last_error_code;
    const needsConnect = code === "AUTH_REQUIRED" && !opts.googleConnected;
    const retryable = c.calendar_job?.status === "failed";
    return {
      statusLabel: "등록 실패",
      tone: "error",
      message: jobErrorMessage(code),
      canEdit: !lockedEdit,
      approve: retryable ? null : approveButton(c, opts),
      retry: retryable
        ? { kind: "retry", label: "재시도", enabled: !busy && !needsConnect, reason: busy ?? (needsConnect ? "Google 캘린더를 다시 연결하세요" : undefined) }
        : null,
      reject,
    };
  }

  // needs_review, rejected
  return {
    statusLabel: c.status === "rejected" ? "거절됨" : c.payload.needs_confirmation || c.payload.location_uncertain ? "확인 필요" : "검토 필요",
    tone: "idle",
    message: c.payload.needs_confirmation
      ? "AI가 날짜·시각을 확정하지 못했습니다. 직접 확인하세요."
      : c.payload.location_uncertain
        ? "목적지가 분명하지 않습니다. 확인하거나 고쳐 주세요."
        : null,
    canEdit: !lockedEdit,
    approve: approveButton(c, opts),
    retry: null,
    reject: c.status === "rejected" ? null : reject,
  };
}

function approveButton(c: EventCandidate, opts: { googleConnected: boolean; pending: boolean; dirty?: boolean }): ActionButton<"approve"> {
  const label = "승인하고 캘린더 등록";
  if (opts.pending) return { kind: "approve", label, enabled: false, reason: "요청을 처리하는 중입니다" };
  if (opts.dirty) return { kind: "approve", label, enabled: false, reason: "수정한 내용을 먼저 저장하세요" };
  if (!c.payload.start_local || !c.payload.end_local) return { kind: "approve", label, enabled: false, reason: "시작·종료 일시를 확정하세요" };
  if (c.payload.location_uncertain) return { kind: "approve", label, enabled: false, reason: "목적지를 확인하세요(수정·삭제하거나 ‘이 목적지가 맞음’)" };
  if (!opts.googleConnected) return { kind: "approve", label, enabled: false, reason: "설정에서 Google 캘린더를 먼저 연결하세요" };
  return { kind: "approve", label, enabled: true };
}

/**
 * 같은 key의 작업이 진행 중이면 새로 실행하지 않고 진행 중인 Promise를 돌려준다(중복 클릭 방지).
 * 한 번의 클릭 안에서는 같은 operation_id로만 재전송하므로 서버가 중복 실행을 막는다.
 * 응답이 없거나 5xx·429일 때만 짧게 재전송하고, 4xx(충돌·검증 실패)는 바로 돌려준다.
 */
export class SingleFlight {
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; newId?: () => string } = {},
  ) {}

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  run<T>(key: string, fn: (operationId: string) => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) return existing as Promise<T>;
    const operationId = (this.opts.newId ?? (() => crypto.randomUUID()))();
    const p = this.attempt(fn, operationId).finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private async attempt<T>(fn: (operationId: string) => Promise<T>, operationId: string): Promise<T> {
    const max = this.opts.maxAttempts ?? 3;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(operationId);
      } catch (e) {
        const status = e instanceof ApiRequestError ? e.status : null;
        const action = classifyFailure(status, attempt, null, { baseMs: 500, maxMs: 4_000 });
        if (action.kind !== "retry" || attempt + 1 >= max || !(e instanceof ApiRequestError)) throw e;
        await sleep(action.delayMs);
      }
    }
  }
}

/** 휴대폰 등록 내역의 분석 상태 배지. 리스가 만료된 실행 중 작업은 실패로 본다(서버 meeting_analysis_state와 같은 규칙). */
export function jobBadge(
  job: { status: string; source_revision_id: string; lease_until: string | null } | undefined,
  meetingRevisionId: string,
  now: number = Date.now(),
): { label: string; tone: Tone } {
  if (!job || job.status === "cancelled") return { label: "분석 전", tone: "idle" };
  if (job.status === "running" && job.lease_until && Date.parse(job.lease_until) < now) return { label: "실패", tone: "error" };
  switch (job.status) {
    case "queued":
      return { label: "대기 중", tone: "busy" };
    case "running":
      return { label: "분석 중", tone: "busy" };
    case "failed":
      return { label: "실패", tone: "error" };
    case "completed":
      return job.source_revision_id === meetingRevisionId
        ? { label: "완료", tone: "done" }
        : { label: "완료 (이전 원문)", tone: "idle" };
    default:
      return { label: job.status, tone: "idle" };
  }
}
