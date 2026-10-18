import { describe, expect, it } from "vitest";
import {
  ACTION_ITEM_TRANSITIONS,
  ANALYSIS_JOB_TRANSITIONS,
  CALENDAR_JOB_TRANSITIONS,
  EVENT_CANDIDATE_TRANSITIONS,
  canTransition,
} from "./status";

describe("상태 전이", () => {
  it("일정 후보는 승인 없이 등록 단계로 갈 수 없다", () => {
    expect(canTransition(EVENT_CANDIDATE_TRANSITIONS, "needs_review", "registering")).toBe(false);
    expect(canTransition(EVENT_CANDIDATE_TRANSITIONS, "needs_review", "registered")).toBe(false);
    expect(canTransition(EVENT_CANDIDATE_TRANSITIONS, "approved", "registering")).toBe(true);
  });

  it("등록 중·등록 완료 후보는 수정(needs_review)으로 돌아갈 수 없다", () => {
    expect(canTransition(EVENT_CANDIDATE_TRANSITIONS, "registering", "needs_review")).toBe(false);
    expect(EVENT_CANDIDATE_TRANSITIONS.registered).toEqual([]);
  });

  it("분석 실패는 사용자 재시도로만 다시 대기한다", () => {
    expect(ANALYSIS_JOB_TRANSITIONS.failed).toEqual(["queued"]);
    expect(ANALYSIS_JOB_TRANSITIONS.completed).toEqual([]);
    expect(CALENDAR_JOB_TRANSITIONS.succeeded).toEqual([]);
  });

  it("제안된 할 일은 바로 완료되지 않는다", () => {
    expect(canTransition(ACTION_ITEM_TRANSITIONS, "proposed", "done")).toBe(false);
    expect(canTransition(ACTION_ITEM_TRANSITIONS, "todo", "done")).toBe(true);
  });
});
