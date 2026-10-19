import { describe, expect, it } from "vitest";
import type { EventCandidate, MeetingAnalysisState } from "@meeting/contracts";
import { visibleCandidates } from "./CandidateList";

const cand = (id: string, result_id: string, status: EventCandidate["status"]) => ({ id, result_id, status }) as EventCandidate;

describe("visibleCandidates", () => {
  it("거절한 후보는 최신 결과든 이전 결과든 보이지 않고, 숨긴 개수에도 넣지 않는다", () => {
    const state = {
      latest_result: { id: "new" },
      candidates: [
        cand("a", "new", "needs_review"),
        cand("r1", "new", "rejected"),
        cand("r2", "old", "rejected"),
        cand("done", "old", "registered"),
        cand("stale", "old", "needs_review"),
      ],
    } as unknown as MeetingAnalysisState;
    const { shown, hidden } = visibleCandidates(state);
    expect(shown.map((c) => c.id)).toEqual(["a", "done"]);
    expect(hidden).toBe(1);
  });
});
