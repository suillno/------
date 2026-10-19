// PC 분석 에이전트 실행 순서 (docs/design.md 9장 분석 파이프라인).
// 사용자가 누른 '분석 실행'·'재분석'·'재시도'로 서버에 대기 중인 작업만 처리한다.
// 이 모듈은 새 분석 작업을 만들지 않는다(analysis_request를 호출하지 않는다).

import type { AnalysisResult } from "@meeting/contracts";
import { ApiRequestError, type AnalysisMetadata, type ClaimedAnalysis, type MeetingApi } from "./api";

/** CLI 실행 결과. 데스크톱이 업로드 전에 로컬 파일로 먼저 저장한 값이다. */
export interface SavedAnalysis {
  job_id: string;
  lease_token: string;
  source_revision_id: string;
  payload: AnalysisResult;
  metadata: AnalysisMetadata;
}

export type RunOutcome = { ok: true; saved: SavedAnalysis } | { ok: false; error_code: string };

/** 데스크톱 Tauri IPC 구현: apps/desktop/src/platform. 웹에는 없다. */
export interface AnalysisRunner {
  run(userId: string, claimed: ClaimedAnalysis): Promise<RunOutcome>;
  pendingUploads(userId: string): Promise<SavedAnalysis[]>;
  clearUpload(userId: string, jobId: string): Promise<void>;
}

export type AgentResult = "idle" | "completed" | "failed" | "upload_pending";

/** 서버가 다시 받을 수 없는 업로드(리스 만료·검증 실패·작업 없음)인지 */
function isPermanent(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 429;
}

/** 이전에 결과를 만들었지만 업로드하지 못한 것부터 올린다(A06: 분석을 다시 하지 않는다). */
export async function uploadPending(api: MeetingApi, runner: AnalysisRunner, userId: string): Promise<number> {
  let uploaded = 0;
  for (const saved of await runner.pendingUploads(userId)) {
    try {
      await api.submitAnalysisResult(saved.job_id, saved.lease_token, saved.source_revision_id, saved.payload, saved.metadata);
      await runner.clearUpload(userId, saved.job_id);
      uploaded++;
    } catch (e) {
      if (isPermanent(e)) {
        // 리스가 만료된 결과는 서버가 받지 않는다. 사용자가 '재시도'로 다시 실행한다.
        await runner.clearUpload(userId, saved.job_id);
      }
    }
  }
  return uploaded;
}

export interface RunOptions {
  userId: string;
  deviceId: string;
  /** 특정 작업만 처리할 때(이 PC에서 방금 누른 버튼) */
  jobId?: string;
  heartbeatMs?: number;
}

/**
 * 데스크톱 앱이 켜져 있고 사용자가 '이 PC 분석 허용'을 켰을 때만 돈다.
 * 주기적으로 사용자가 이미 요청한 대기 작업만 확인하며, 새 분석을 만들거나 실패 작업을 다시 대기시키지 않는다.
 * 앱 시작 직후에는 실행하지 않고 첫 주기 또는 runNow(이 PC에서 누른 버튼)부터 처리한다.
 */
export class AnalysisAgentLoop {
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: MeetingApi,
    private readonly runner: AnalysisRunner,
    private readonly opts: { userId: string; deviceId: string; intervalMs?: number; onResult?: (r: AgentResult) => void },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 진행 중이면 'busy'를 돌려주고 새로 실행하지 않는다. 대기 작업은 다음 주기에 처리된다. */
  async tick(jobId?: string): Promise<AgentResult | "busy"> {
    if (this.busy) return "busy";
    this.busy = true;
    try {
      const result = await runOneAnalysis(this.api, this.runner, { userId: this.opts.userId, deviceId: this.opts.deviceId, jobId });
      this.opts.onResult?.(result);
      return result;
    } catch {
      return "upload_pending";
    } finally {
      this.busy = false;
    }
  }
}

/** 대기 작업 하나를 가져와 실행한다. 동시 실행은 호출하는 쪽이 하나로 제한한다(설계 9장: 기기당 1개). */
export async function runOneAnalysis(api: MeetingApi, runner: AnalysisRunner, opts: RunOptions): Promise<AgentResult> {
  await uploadPending(api, runner, opts.userId);

  const claimed = await api.claimAnalysis(opts.deviceId, opts.jobId);
  if (!claimed) return "idle";

  const heartbeat = setInterval(() => {
    api.heartbeatAnalysis(claimed.job.id, claimed.lease_token).catch(() => undefined);
  }, opts.heartbeatMs ?? 30_000);

  let outcome: RunOutcome;
  try {
    outcome = await runner.run(opts.userId, claimed);
  } catch {
    outcome = { ok: false, error_code: "CLI_ERROR" };
  } finally {
    clearInterval(heartbeat);
  }

  if (!outcome.ok) {
    try {
      await api.submitAnalysisFailure(claimed.job.id, claimed.lease_token, outcome.error_code);
    } catch {
      // 기록하지 못하면 리스 만료 후 서버가 실패(LEASE_EXPIRED)로 보여준다.
    }
    return "failed";
  }

  try {
    const s = outcome.saved;
    await api.submitAnalysisResult(s.job_id, s.lease_token, s.source_revision_id, s.payload, s.metadata);
    await runner.clearUpload(opts.userId, s.job_id);
    return "completed";
  } catch (e) {
    if (isPermanent(e)) {
      await runner.clearUpload(opts.userId, outcome.saved.job_id);
      return "failed";
    }
    return "upload_pending";
  }
}
