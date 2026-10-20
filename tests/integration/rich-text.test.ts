// 서식 편집: 실제 Edge Function(Deno)이 PC·화면(Node)과 같은 판정을 하는지 확인한다(C03).
// 실행 방법은 local-flow.test.ts와 같다. 환경변수가 없으면 건너뛴다.

import { describe, expect, it } from "vitest";
import { ApiRequestError, createSupabaseMeetingApi, localToInstant, type MeetingApi } from "@meeting/client-core";
import type { AnalysisResultV2 } from "@meeting/contracts";
import { RICH_FIXTURES } from "../../supabase/functions/_shared/richtext.fixtures.ts";
import { docToMarkdown, markdownToDoc } from "../../packages/ui/src/rich/convert";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

async function signedIn(): Promise<MeetingApi> {
  const api = createSupabaseMeetingApi({ url: url!, anonKey: anonKey!, storage: memoryStorage() });
  const email = `rt-${crypto.randomUUID()}@test.invalid`;
  await api.signUp(email, "local-only-password");
  await api.signIn(email, "local-only-password");
  return api;
}

const payload: AnalysisResultV2 = {
  schema_version: 2,
  summary: "요약",
  decisions: ["결정"],
  action_items: [],
  event_candidates: [{
    title: "리뷰", start_local: "2026-10-21T15:00", end_local: "2026-10-21T16:00", time_zone: "Asia/Seoul",
    all_day: false, evidence: "수요일 3시", needs_confirmation: false, location: null, location_uncertain: false,
  }],
};

describe.skipIf(!url || !anonKey)("서식 편집 서버 판정 (Edge Function)", () => {
  it("C01·C02 서식만 바꾸면 결과·후보 유지, 글자가 바뀌면 원문 변경", async () => {
    const api = await signedIn();
    const m = await api.createMeeting(crypto.randomUUID(), {
      title: "서식 테스트", body: "회의 **본문**\n\n- 결정 하나", meeting_at: localToInstant("2026-10-20T10:00", "Asia/Seoul")!, time_zone: "Asia/Seoul",
    });
    const job = await api.requestAnalysis(crypto.randomUUID(), m.id, m.analysis_revision_id, "initial");
    const claimed = await api.claimAnalysis("pc-rt", job.id);
    await api.submitAnalysisResult(job.id, claimed!.lease_token, claimed!.input.source_revision_id, payload,
      { engine_version: "test", prompt_version: "meeting-analysis/v2", input_hash: "h" });

    const formatted = await api.patchMeeting(crypto.randomUUID(), m.id, m.version, {
      body: "<u>회의</u> <span style=\"color:#c92a2a\">본문</span>\n\n* 결정 **하나**",
    });
    expect(formatted.analysis_changed).toBe(false);
    expect(formatted.version).toBe(m.version + 1);
    expect(formatted.analysis_revision_id).toBe(m.analysis_revision_id);
    const kept = await api.getAnalysisState(m.id);
    expect(kept.latest_result?.stale).toBe(false);
    expect(kept.candidates[0]?.stale).toBe(false);

    const changed = await api.patchMeeting(crypto.randomUUID(), m.id, formatted.version, { body: "회의 본문 수정\n\n- 결정 하나" });
    expect(changed.analysis_changed).toBe(true);
    expect((await api.getAnalysisState(m.id)).candidates[0]?.stale).toBe(true);

    // E01 오래된 version으로 저장하면 충돌(입력은 화면이 보존)
    const err = await api.patchMeeting(crypto.randomUUID(), m.id, formatted.version, { body: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe("VERSION_CONFLICT");
    await api.purgeMeeting(crypto.randomUUID(), m.id, changed.version);
    await api.signOut();
  }, 60_000);

  it("C03 고정 자료: 편집기 왕복(서식 표기 정규화)은 서버(Deno)에서도 원문 변경이 아니다", async () => {
    const api = await signedIn();
    for (const f of RICH_FIXTURES) {
      const m = await api.createMeeting(crypto.randomUUID(), {
        title: f.name, body: f.markdown, meeting_at: localToInstant("2026-10-20T10:00", "Asia/Seoul")!, time_zone: "Asia/Seoul",
      });
      const roundTripped = docToMarkdown(markdownToDoc(f.markdown));
      const saved = await api.patchMeeting(crypto.randomUUID(), m.id, m.version, { body: roundTripped + "\n\n" });
      expect(saved.analysis_changed, f.name).toBe(false);
      await api.purgeMeeting(crypto.randomUUID(), m.id, saved.version);
    }
    await api.signOut();
  }, 60_000);

  it("L01 편집본: 보이는 글자 4000자 초과는 서버가 거절, 서식이 많아도 한도 안이면 저장", async () => {
    const api = await signedIn();
    const m = await api.createMeeting(crypto.randomUUID(), {
      title: "편집본", body: "본문", meeting_at: localToInstant("2026-10-20T10:00", "Asia/Seoul")!, time_zone: "Asia/Seoul",
    });
    const job = await api.requestAnalysis(crypto.randomUUID(), m.id, m.analysis_revision_id, "initial");
    const claimed = await api.claimAnalysis("pc-rt", job.id);
    await api.submitAnalysisResult(job.id, claimed!.lease_token, claimed!.input.source_revision_id, payload,
      { engine_version: "test", prompt_version: "meeting-analysis/v2", input_hash: "h" });
    const notes = (await api.getAnalysisState(m.id)).notes!;

    const tooLong = await api.patchNotes(crypto.randomUUID(), m.id, notes.version, { summary: "가".repeat(4001) }).catch((e: unknown) => e);
    expect(tooLong).toBeInstanceOf(ApiRequestError);
    expect((tooLong as ApiRequestError).code).toBe("VALIDATION_FAILED");

    // 보이는 글자 4000자 + 모든 문장에 굵게·밑줄·색 (측정상 약 10,500자)
    const sentence = "다음 주 화요일까지 수수료 계산 방식을 확정한다.";
    const unit = `**<u><span style="color:#c92a2a">${sentence}</span></u>** `;
    const heavy = unit.repeat(Math.floor(4000 / (sentence.length + 1)));
    const saved = await api.patchNotes(crypto.randomUUID(), m.id, notes.version, { summary: heavy, decisions: ["**확정**", "<u>보류</u>"] });
    expect(saved.summary).toBe(heavy);
    expect(saved.decisions).toEqual(["**확정**", "<u>보류</u>"]);
    await api.purgeMeeting(crypto.randomUUID(), m.id, m.version);
    await api.signOut();
  }, 60_000);
});
