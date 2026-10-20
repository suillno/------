import { describe, expect, it, vi } from "vitest";
import type { AnalysisResultV1 } from "@meeting/contracts";
import { AnalysisAgentLoop, runOneAnalysis, uploadPending, type AnalysisRunner, type SavedAnalysis } from "./agent";
import { ApiRequestError, type ClaimedAnalysis, type MeetingApi } from "./api";

const payload: AnalysisResultV1 = { schema_version: 1, summary: "s", decisions: [], action_items: [], event_candidates: [] };
const claimed: ClaimedAnalysis = {
  job: { id: "job-1" } as ClaimedAnalysis["job"],
  lease_token: "lease-1",
  input: { meeting_id: "m", source_revision_id: "rev", title: "t", body: "b", meeting_at: "", meeting_local_date: "2026-10-16", time_zone: "Asia/Seoul", user_instructions: null },
};
const saved: SavedAnalysis = {
  job_id: "job-1", lease_token: "lease-1", source_revision_id: "rev", payload,
  metadata: { engine_version: "e", prompt_version: "p", input_hash: "h" },
};
const err = (status: number | null, code: string) =>
  new ApiRequestError(status, { error: { code: code as never, message: "", request_id: "r" } });

function fakes(pending: SavedAnalysis[] = []) {
  const store = new Map(pending.map((s) => [s.job_id, s]));
  const api = {
    claimAnalysis: vi.fn(async () => claimed as ClaimedAnalysis | null),
    heartbeatAnalysis: vi.fn(async () => undefined),
    submitAnalysisResult: vi.fn(async () => ({ result_id: "r", stale: false })),
    submitAnalysisFailure: vi.fn(async () => undefined),
    requestAnalysis: vi.fn(),
    retryAnalysis: vi.fn(),
  };
  const runner: AnalysisRunner = {
    run: vi.fn(async () => {
      store.set(saved.job_id, saved);
      return { ok: true as const, saved };
    }),
    pendingUploads: vi.fn(async () => [...store.values()]),
    clearUpload: vi.fn(async (_u: string, id: string) => void store.delete(id)),
  };
  return { api, runner, store, typedApi: api as unknown as MeetingApi };
}

describe("runOneAnalysis", () => {
  it("대기 작업이 없으면 아무것도 실행하지 않는다", async () => {
    const f = fakes();
    f.api.claimAnalysis.mockResolvedValueOnce(null);
    expect(await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" })).toBe("idle");
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("새 분석 작업을 만들지 않는다(사용자가 누른 작업만 처리)", async () => {
    const f = fakes();
    await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" });
    expect(f.api.requestAnalysis).not.toHaveBeenCalled();
    expect(f.api.retryAnalysis).not.toHaveBeenCalled();
  });

  it("작업을 가져오면 실행 전에 onStart로 알린다(화면을 바로 '실행 중'으로)", async () => {
    const f = fakes();
    const order: string[] = [];
    vi.mocked(f.runner.run).mockImplementationOnce(async () => (order.push("run"), { ok: true, saved }));
    await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc", onStart: () => order.push("start") });
    expect(order).toEqual(["start", "run"]);

    f.api.claimAnalysis.mockResolvedValueOnce(null);
    const onStart = vi.fn();
    await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc", onStart });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("A01 CLI에는 서식 기호가 아닌 읽는 텍스트를 넘긴다(요청사항·다른 입력은 그대로)", async () => {
    const f = fakes();
    f.api.claimAnalysis.mockResolvedValueOnce({
      ...claimed,
      input: { ...claimed.input, body: "# 제목\n\n**굵게** <u>밑줄</u> <span style=\"color:#c92a2a\">색</span>\n\n- 항목", user_instructions: "짧게" },
    });
    await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" });
    const sent = vi.mocked(f.runner.run).mock.calls[0]![1];
    expect(sent.input.body).toBe("제목\n굵게 밑줄 색\n- 항목");
    expect(sent.input.user_instructions).toBe("짧게");
    expect(sent.input.source_revision_id).toBe("rev");
  });

  it("실행 → 업로드 → 로컬 저장본 정리", async () => {
    const f = fakes();
    expect(await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc", jobId: "job-1" })).toBe("completed");
    expect(f.api.claimAnalysis).toHaveBeenCalledWith("pc", "job-1");
    expect(f.api.submitAnalysisResult).toHaveBeenCalledWith("job-1", "lease-1", "rev", payload, saved.metadata);
    expect(f.store.size).toBe(0);
  });

  it("A06 업로드가 끊기면 저장본을 남기고, 다음 실행 때 분석 없이 업로드부터 한다", async () => {
    const f = fakes();
    f.api.submitAnalysisResult.mockRejectedValueOnce(err(null, "SERVICE_UNAVAILABLE"));
    expect(await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" })).toBe("upload_pending");
    expect(f.store.size).toBe(1);

    f.api.claimAnalysis.mockResolvedValueOnce(null);
    expect(await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" })).toBe("idle");
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.store.size).toBe(0);
  });

  it("CLI 실패는 사유 코드와 함께 실패로 기록한다", async () => {
    const f = fakes();
    vi.mocked(f.runner.run).mockResolvedValueOnce({ ok: false, error_code: "RATE_LIMITED" });
    expect(await runOneAnalysis(f.typedApi, f.runner, { userId: "u", deviceId: "pc" })).toBe("failed");
    expect(f.api.submitAnalysisFailure).toHaveBeenCalledWith("job-1", "lease-1", "RATE_LIMITED");
  });
});

describe("AnalysisAgentLoop", () => {
  it("실행 중에는 겹쳐 실행하지 않는다", async () => {
    const f = fakes();
    let release!: () => void;
    vi.mocked(f.runner.run).mockImplementationOnce(() => new Promise((r) => (release = () => r({ ok: true, saved }))));
    const loop = new AnalysisAgentLoop(f.typedApi, f.runner, { userId: "u", deviceId: "pc" });
    const first = loop.tick("job-1");
    await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalled());
    expect(await loop.tick("job-1")).toBe("busy");
    release();
    expect(await first).toBe("completed");
    expect(f.api.claimAnalysis).toHaveBeenCalledTimes(1);
  });

  it("start만으로는 즉시 실행하지 않는다(앱 시작 시 자동 실행 없음)", () => {
    vi.useFakeTimers();
    try {
      const f = fakes();
      const loop = new AnalysisAgentLoop(f.typedApi, f.runner, { userId: "u", deviceId: "pc", intervalMs: 1000 });
      loop.start();
      expect(f.api.claimAnalysis).not.toHaveBeenCalled();
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("uploadPending", () => {
  it("리스가 만료된 저장본은 버린다(서버가 받지 않으므로 사용자 재시도로 다시 실행)", async () => {
    const f = fakes([saved]);
    f.api.submitAnalysisResult.mockRejectedValueOnce(err(409, "LEASE_EXPIRED"));
    expect(await uploadPending(f.typedApi, f.runner, "u")).toBe(0);
    expect(f.store.size).toBe(0);
  });
});
