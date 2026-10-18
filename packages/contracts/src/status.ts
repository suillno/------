// 엔터티 상태와 허용 전이. 서버(supabase/migrations)가 같은 규칙을 강제하며 클라이언트 검사는 UX용이다.

export type ActionItemStatus = "proposed" | "todo" | "in_progress" | "done" | "cancelled";

export const ACTION_ITEM_TRANSITIONS: Record<ActionItemStatus, readonly ActionItemStatus[]> = {
  proposed: ["todo", "cancelled"],
  todo: ["in_progress", "done", "cancelled"],
  in_progress: ["todo", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["todo"],
};

// 원문 변경으로 승인할 수 없는 후보(stale)는 저장 상태가 아니라 화면에서 계산하는 표시다.
export type EventCandidateStatus =
  | "needs_review"
  | "approved"
  | "registering"
  | "registered"
  | "failed"
  | "rejected";

export const EVENT_CANDIDATE_TRANSITIONS: Record<
  EventCandidateStatus,
  readonly EventCandidateStatus[]
> = {
  // 후보 수정은 새 content_version + needs_review 유지
  needs_review: ["needs_review", "approved", "rejected"],
  // 승인 후 수정하면 승인이 무효화되어 needs_review로 돌아간다
  approved: ["registering", "needs_review", "rejected", "failed"],
  registering: ["registered", "failed"],
  // 실패: 사용자가 '재시도'(approved) 또는 수정(needs_review)·거절을 고른다
  failed: ["approved", "needs_review", "rejected"],
  rejected: ["needs_review", "approved"],
  registered: [],
};

// 자동 재시도 상태는 없다. 실패하면 failed로 남고 사용자의 '재시도'만 queued로 되돌린다.
export type AnalysisJobStatus = "queued" | "running" | "failed" | "completed" | "cancelled";

export const ANALYSIS_JOB_TRANSITIONS: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  failed: ["queued"],
  completed: [],
  cancelled: [],
};

export type CalendarJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const CALENDAR_JOB_TRANSITIONS: Record<CalendarJobStatus, readonly CalendarJobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed"],
  failed: ["queued", "cancelled"],
  succeeded: [],
  cancelled: [],
};

export function canTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}
