// 로컬 Supabase + Edge Function 통합 테스트. 실제 Google·Claude는 호출하지 않는다.
// 실행: npm run db:start, supabase functions serve --env-file supabase/functions/.env 후
//   LOCAL_SUPABASE_URL=http://127.0.0.1:54321 LOCAL_SUPABASE_ANON_KEY=<supabase status의 ANON_KEY> npx vitest run tests/integration
// 환경변수가 없으면 건너뛴다.

import { describe, expect, it } from "vitest";
import { ApiRequestError, createSupabaseMeetingApi, localToInstant } from "@meeting/client-core";
import type { AnalysisResultV1 } from "@meeting/contracts";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const payload: AnalysisResultV1 = {
  schema_version: 1,
  summary: "통합 테스트 요약",
  decisions: ["다음 주 리뷰"],
  action_items: [],
  event_candidates: [{
    title: "리뷰", start_local: "2026-10-20T15:00", end_local: "2026-10-20T16:00", time_zone: "Asia/Seoul",
    all_day: false, evidence: "화요일 3시", needs_confirmation: false,
  }],
};

describe.skipIf(!url || !anonKey)("로컬 Supabase 흐름", () => {
  it("저장 → 분석 실행(중복 클릭) → PC 처리 → 후보 승인 요청", async () => {
    const api = createSupabaseMeetingApi({ url: url!, anonKey: anonKey!, storage: memoryStorage() });
    const email = `it-${crypto.randomUUID()}@test.invalid`;
    await api.signUp(email, "local-only-password");
    await api.signIn(email, "local-only-password");
    const session = await api.getSession();
    expect(session?.email).toBe(email);

    const meeting = await api.createMeeting(crypto.randomUUID(), {
      title: "통합 테스트", body: "다음 주 화요일 3시 리뷰", meeting_at: localToInstant("2026-10-16T10:00", "Asia/Seoul")!, time_zone: "Asia/Seoul",
    });
    const before = await api.getAnalysisState(meeting.id);
    expect(before.job).toBeNull();

    const [a, b] = await Promise.all([
      api.requestAnalysis(crypto.randomUUID(), meeting.id, meeting.revision_id, "initial"),
      api.requestAnalysis(crypto.randomUUID(), meeting.id, meeting.revision_id, "initial"),
    ]);
    expect(a.id).toBe(b.id);

    const claimed = await api.claimAnalysis("pc-it");
    expect(claimed?.job.id).toBe(a.id);
    expect(await api.claimAnalysis("pc-other")).toBeNull();
    await api.submitAnalysisResult(claimed!.job.id, claimed!.lease_token, claimed!.input.source_revision_id, payload,
      { engine_version: "test", prompt_version: "meeting-analysis/v1", input_hash: "h" });

    const after = await api.getAnalysisState(meeting.id);
    expect(after.job?.status).toBe("completed");
    expect(after.notes?.summary).toBe("통합 테스트 요약");
    const cand = after.candidates[0]!;
    expect(cand.status).toBe("needs_review");

    // Google 비밀이 없는 로컬 서버는 승인 전에 503으로 멈춘다(승인·등록 없음)
    const err = await api.approveAndRegister(crypto.randomUUID(), cand).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(503);
    expect((await api.getAnalysisState(meeting.id)).candidates[0]!.status).toBe("needs_review");

    const conn = await api.getGoogleConnection();
    expect(conn.connected).toBe(false);
    await api.signOut();
  }, 30_000);

  it("OAuth 콜백은 위조 state를 거절하고 앱으로 돌려보낸다", async () => {
    const res = await fetch(`${url}/functions/v1/google-oauth-callback?state=forged&code=x`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("google=invalid_state");
  });
});
