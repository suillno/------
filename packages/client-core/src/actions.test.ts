import { describe, expect, it, vi } from "vitest";
import type { AnalysisJob, EventCandidate, MeetingAnalysisState } from "@meeting/contracts";
import { analysisView, approveAllSequentially, candidateView, jobBadge, planBulkApprove, SingleFlight } from "./actions";
import { ApiRequestError } from "./api";

const REV = "11111111-0000-4000-8000-000000000001";

function state(job: Partial<AnalysisJob> | null, revision = REV): MeetingAnalysisState {
  return {
    meeting: { id: "m", version: 1, revision_id: revision, deleted: false },
    job: job && ({
      id: "j", meeting_id: "m", source_revision_id: REV, run_no: 1, status: "queued", version: 1, device_id: null,
      lease_until: null, attempt: 0, error_code: null, requested_at: "", started_at: null, finished_at: null, ...job,
    } as AnalysisJob),
    latest_result: null,
    notes: null,
    candidates: [],
  };
}

const kinds = (v: ReturnType<typeof analysisView>) => v.buttons.map((b) => `${b.kind}:${b.enabled}`);

describe("analysisView", () => {
  it("분석 전에는 '분석 실행'만 누를 수 있다", () => {
    expect(kinds(analysisView(state(null), false))).toEqual(["run:true"]);
  });
  it("대기·실행 중에는 버튼을 막는다", () => {
    expect(analysisView(state({ status: "queued" }), false)).toMatchObject({ statusLabel: "대기 중", tone: "busy" });
    expect(kinds(analysisView(state({ status: "running" }), false))).toEqual(["run:false"]);
  });
  it("완료 후에는 '재분석'을 보여준다", () => {
    expect(kinds(analysisView(state({ status: "completed" }), false))).toEqual(["rerun:true"]);
  });
  it("원문이 바뀐 뒤에는 새 원문으로 '분석 실행'을 보여준다", () => {
    const v = analysisView(state({ status: "completed" }, "22222222-0000-4000-8000-000000000002"), false);
    expect(v.statusLabel).toBe("완료 (이전 원문 기준)");
    expect(kinds(v)).toEqual(["run:true"]);
  });
  it("실패하면 사유와 '재시도'를 보여준다", () => {
    const v = analysisView(state({ status: "failed", error_code: "RATE_LIMITED" }), false);
    expect(v).toMatchObject({ statusLabel: "실패", tone: "error", message: "사용 한도에 도달했습니다. 잠시 후 재시도하세요." });
    expect(kinds(v)).toEqual(["retry:true"]);
  });
  it("요청을 보내는 동안에는 모든 버튼을 막는다(중복 클릭)", () => {
    expect(kinds(analysisView(state(null), true))).toEqual(["run:false"]);
    expect(kinds(analysisView(state({ status: "failed" }), true))).toEqual(["retry:false"]);
  });
});

function cand(over: Partial<EventCandidate> = {}, payload: Partial<EventCandidate["payload"]> = {}): EventCandidate {
  return {
    id: "c", meeting_id: "m", result_id: "r", item_index: 0, source_revision_id: REV, version: 1, content_version: 1,
    payload: {
      title: "리뷰", start_local: "2026-10-20T15:00", end_local: "2026-10-20T16:00", time_zone: "Asia/Seoul",
      all_day: false, evidence: "근거", needs_confirmation: false, description: null, ...payload,
    },
    payload_hash: "h", status: "needs_review", last_error_code: null, stale: false, approval_id: null,
    calendar_job: null, link: null, ...over,
  };
}

describe("candidateView", () => {
  const on = { googleConnected: true, pending: false };
  it("확정된 후보는 승인하고 등록할 수 있다", () => {
    expect(candidateView(cand(), on).approve).toMatchObject({ enabled: true, label: "승인하고 캘린더 등록" });
  });
  it("날짜 미확정·Google 미연결·저장 안 한 수정이 있으면 승인 버튼을 막고 이유를 보여준다", () => {
    expect(candidateView(cand({}, { end_local: null }), on).approve).toMatchObject({ enabled: false, reason: "시작·종료 일시를 확정하세요" });
    expect(candidateView(cand(), { ...on, googleConnected: false }).approve?.enabled).toBe(false);
    expect(candidateView(cand(), { ...on, dirty: true }).approve?.reason).toBe("수정한 내용을 먼저 저장하세요");
  });
  it("L03 목적지가 불명확하면 확인 전 승인을 막는다", () => {
    const v = candidateView(cand({}, { location: "강남", location_uncertain: true }), on);
    expect(v).toMatchObject({ statusLabel: "확인 필요", message: "목적지가 분명하지 않습니다. 확인하거나 고쳐 주세요." });
    expect(v.approve).toMatchObject({ enabled: false });
    expect(candidateView(cand({}, { location: "교대역", location_uncertain: false }), on).approve?.enabled).toBe(true);
    expect(candidateView(cand({}, { location: null }), on).approve?.enabled).toBe(true);
  });
  it("원문이 바뀐 후보는 승인할 수 없다", () => {
    expect(candidateView(cand({ stale: true }), on).approve?.enabled).toBe(false);
  });
  it("등록 중·등록 완료 후보는 수정할 수 없다", () => {
    expect(candidateView(cand({ status: "registering" }), on)).toMatchObject({ canEdit: false, approve: null, tone: "busy" });
    expect(candidateView(cand({ status: "registered" }), on)).toMatchObject({ canEdit: false, statusLabel: "등록 완료" });
  });
  it("등록 실패는 사유와 '재시도'를 보여준다", () => {
    const job = { id: "cj", approval_id: "a", candidate_id: "c", status: "failed" as const, attempts: 1,
      last_error_code: "NETWORK", last_error_message: null, updated_at: "" };
    const v = candidateView(cand({ status: "failed", calendar_job: job }), on);
    expect(v).toMatchObject({ statusLabel: "등록 실패", message: "Google 응답이 없습니다.", retry: { enabled: true } });
    const auth = candidateView(cand({ status: "failed", calendar_job: { ...job, last_error_code: "AUTH_REQUIRED" } }), { ...on, googleConnected: false });
    expect(auth.retry).toMatchObject({ enabled: false, reason: "Google 캘린더를 다시 연결하세요" });
  });
});

describe("SingleFlight", () => {
  it("진행 중인 같은 작업은 다시 실행하지 않는다", async () => {
    const sf = new SingleFlight();
    let release!: () => void;
    const fn = vi.fn(() => new Promise<string>((r) => (release = () => r("done"))));
    const a = sf.run("approve:c", fn);
    const b = sf.run("approve:c", fn);
    expect(sf.isRunning("approve:c")).toBe(true);
    release();
    expect(await a).toBe("done");
    expect(await b).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sf.isRunning("approve:c")).toBe(false);
  });

  it("응답이 없으면 같은 operation_id로 다시 보낸다", async () => {
    const ids: string[] = [];
    let n = 0;
    const sf = new SingleFlight({ sleep: async () => undefined, newId: () => `op-${++n}` });
    const result = await sf.run("k", async (op) => {
      ids.push(op);
      if (ids.length < 2) throw new ApiRequestError(null, { error: { code: "SERVICE_UNAVAILABLE", message: "", request_id: "r" } });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(ids).toEqual(["op-1", "op-1"]);
  });

  it("충돌(409)은 재전송하지 않는다", async () => {
    const sf = new SingleFlight({ sleep: async () => undefined });
    const fn = vi.fn(async () => {
      throw new ApiRequestError(409, { error: { code: "VERSION_CONFLICT", message: "", request_id: "r" } });
    });
    await expect(sf.run("k", fn)).rejects.toBeInstanceOf(ApiRequestError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("새 클릭은 새 operation_id를 쓴다", async () => {
    const ids: string[] = [];
    const sf = new SingleFlight();
    await sf.run("k", async (op) => void ids.push(op));
    await sf.run("k", async (op) => void ids.push(op));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("jobBadge", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const job = (status: string, extra: Partial<{ source_revision_id: string; lease_until: string | null }> = {}) =>
    ({ status, source_revision_id: REV, lease_until: null, ...extra });
  it("상태별 배지", () => {
    expect(jobBadge(undefined, REV, now).label).toBe("분석 전");
    expect(jobBadge(job("queued"), REV, now)).toEqual({ label: "대기 중", tone: "busy" });
    expect(jobBadge(job("running", { lease_until: "2026-10-18T12:01:00Z" }), REV, now).label).toBe("분석 중");
    expect(jobBadge(job("completed"), REV, now)).toEqual({ label: "완료", tone: "done" });
    expect(jobBadge(job("failed"), REV, now).tone).toBe("error");
  });
  it("리스가 만료된 실행 중 작업은 실패로 보인다", () => {
    expect(jobBadge(job("running", { lease_until: "2026-10-18T11:59:00Z" }), REV, now).label).toBe("실패");
  });
  it("원문이 바뀐 뒤의 완료는 이전 원문 기준으로 표시한다", () => {
    expect(jobBadge(job("completed"), "22222222-0000-4000-8000-000000000002", now).label).toBe("완료 (이전 원문)");
  });
});

describe("planBulkApprove", () => {
  it("거절·등록 완료·승인된 후보는 빼고, 승인 가능한 후보만 대상으로 한다", () => {
    const list = [
      cand({ id: "a" }),
      cand({ id: "rej", status: "rejected" }),
      cand({ id: "done", status: "registered" }),
      cand({ id: "appr", status: "approved" }),
      cand({ id: "loc" }, { location: "강남역", location_uncertain: true }),
      cand({ id: "nodate" }, { start_local: null, end_local: null, needs_confirmation: true }),
      cand({ id: "old", stale: true }),
      cand({ id: "edit" }),
    ];
    const plan = planBulkApprove(list, { googleConnected: true, dirtyIds: new Set(["edit"]) });
    expect(plan.targets.map((c) => c.id)).toEqual(["a"]);
    expect(plan.skipped.map((s) => s.candidate.id)).toEqual(["loc", "nodate", "old", "edit"]);
    expect(plan.skipped.find((s) => s.candidate.id === "edit")?.reason).toBe("수정한 내용을 먼저 저장하세요");
  });

  it("Google 연결 전에는 대상이 없다", () => {
    expect(planBulkApprove([cand()], { googleConnected: false }).targets).toEqual([]);
  });

  it("재시도할 수 있는 등록 실패 후보는 ‘재시도’로 안내하고 빼낸다", () => {
    const failed = cand({ status: "failed", calendar_job: { id: "j", status: "failed", last_error_code: "GOOGLE_UNAVAILABLE" } as EventCandidate["calendar_job"] });
    const plan = planBulkApprove([failed], { googleConnected: true });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped[0]!.reason).toContain("재시도");
  });
});

describe("approveAllSequentially", () => {
  it("후보마다 다른 operation_id로 차례로 등록하고, 실패해도 나머지를 계속하며 다시 실행하지 않는다", async () => {
    const calls: { op: string; id: string }[] = [];
    const api = {
      approveAndRegister: vi.fn(async (op: string, c: { id: string }) => {
        calls.push({ op, id: c.id });
        if (c.id === "b") throw new ApiRequestError(409, { error: { code: "CONFLICT" as never, message: "", request_id: "r" } });
        return { status: "succeeded" as const };
      }),
    };
    const progress: number[] = [];
    const results = await approveAllSequentially(api, new SingleFlight(), [cand({ id: "a" }), cand({ id: "b" }), cand({ id: "c" })], (d) => progress.push(d));
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(new Set(calls.map((c) => c.op)).size).toBe(3);
    expect(results.map((r) => r.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(progress).toEqual([1, 2, 3]);
  });
});
