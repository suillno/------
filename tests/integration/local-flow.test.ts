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

    // Google 비밀이 없으면 503, 있으면 이 사용자가 Google을 연결하지 않았으므로 409 GOOGLE_AUTH_REQUIRED.
    // 어느 쪽이든 승인·등록은 일어나지 않아야 한다(C01).
    const err = await api.approveAndRegister(crypto.randomUUID(), cand).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    const e = err as ApiRequestError;
    expect(e.status === 503 || (e.status === 409 && e.code === "GOOGLE_AUTH_REQUIRED")).toBe(true);
    expect((await api.getAnalysisState(meeting.id)).candidates[0]!.status).toBe("needs_review");

    const conn = await api.getGoogleConnection();
    expect(conn.connected).toBe(false);

    // S01 분석이 끝난 회의는 요약 목록에 자동으로 나온다
    const summaries = await api.listSummaries();
    expect(summaries.map((s) => s.meeting_id)).toEqual([meeting.id]);
    expect(summaries[0]!.summary_preview).toBe("통합 테스트 요약");

    // D02 영구 삭제 → 목록·요약에서 사라지고 상세는 NOT_FOUND
    const purged = await api.purgeMeeting(crypto.randomUUID(), meeting.id, meeting.version);
    expect(purged).toMatchObject({ id: meeting.id, purged: true, registered_events_kept: 0 });
    expect((await api.listMeetings()).some((m) => m.id === meeting.id)).toBe(false);
    expect(await api.listSummaries()).toEqual([]);
    const gone = await api.getAnalysisState(meeting.id).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ApiRequestError);
    expect((gone as ApiRequestError).code).toBe("NOT_FOUND");
    await api.signOut();
  }, 30_000);

  it("I02 분석 요청사항을 작업에 보관하고 PC가 원문과 따로 받는다", async () => {
    const api = createSupabaseMeetingApi({ url: url!, anonKey: anonKey!, storage: memoryStorage() });
    const email = `it-${crypto.randomUUID()}@test.invalid`;
    await api.signUp(email, "local-only-password");
    await api.signIn(email, "local-only-password");
    const meeting = await api.createMeeting(crypto.randomUUID(), {
      title: "요청사항 테스트", body: "본문", meeting_at: localToInstant("2026-10-16T10:00", "Asia/Seoul")!, time_zone: "Asia/Seoul",
    });
    const job = await api.requestAnalysis(crypto.randomUUID(), meeting.id, meeting.revision_id, "initial", "  결정사항만 짧게  ");
    expect(job.user_instructions).toBe("결정사항만 짧게");
    const claimed = await api.claimAnalysis("pc-it");
    expect(claimed?.input).toMatchObject({ body: "본문", user_instructions: "결정사항만 짧게" });
    await api.purgeMeeting(crypto.randomUUID(), meeting.id, meeting.version);
    await api.signOut();
  }, 30_000);

  it("OAuth 콜백은 위조 state를 거절하고 앱으로 돌려보낸다", async () => {
    const res = await fetch(`${url}/functions/v1/google-oauth-callback?state=forged&code=x`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("google=invalid_state");
  });
});
