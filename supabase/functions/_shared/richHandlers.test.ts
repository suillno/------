import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "./handlers.ts";
import { handleMeetingSave, handleNotesSave } from "./richHandlers.ts";
import { PALETTE } from "./richtext.ts";
import { fakeFetch, jsonResponse, type RecordedCall, type Route } from "./testing.ts";

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEETING = "cccccccc-0000-4000-8000-000000000002";
const BASIS_REV = "dddddddd-0000-4000-8000-000000000003";
const OP = "eeeeeeee-0000-4000-8000-000000000004";

function env(routes: Route[]) {
  const f = fakeFetch(routes);
  const vars: Record<string, string> = {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-test",
    SUPABASE_SERVICE_ROLE_KEY: "service-test",
  };
  return { env: loadServerEnv((k) => vars[k], f.fetch), calls: f.calls };
}

const userRoute: Route = (call) =>
  call.url === "http://supabase.test/auth/v1/user"
    ? call.headers.authorization === "Bearer user-jwt" ? jsonResponse(200, { id: USER }) : jsonResponse(401, {})
    : undefined;

const meetingRow = {
  id: MEETING, version: 3, title: "회의", body: "**새** 본문", meeting_at: "2026-10-20T01:00:00+00:00",
  time_zone: "Asia/Seoul", analysis_revision_id: BASIS_REV, deleted_at: null,
};
const basisSnapshot = { title: "회의", body: "새 본문", meeting_at: "2026-10-20T01:00:00+00:00", time_zone: "Asia/Seoul" };

function readRoutes(row: Record<string, unknown> | null = meetingRow): Route[] {
  return [
    (call) => call.url.startsWith("http://supabase.test/rest/v1/meetings?")
      ? (expect(call.headers.authorization).toBe("Bearer user-jwt"), jsonResponse(200, row ? [row] : []))
      : undefined,
    (call) => call.url.startsWith(`http://supabase.test/rest/v1/meeting_revisions?id=eq.${BASIS_REV}`)
      ? jsonResponse(200, [{ immutable_snapshot: basisSnapshot }])
      : undefined,
  ];
}

const svcRoute = (fn: string, handler: (args: Record<string, unknown>, call: RecordedCall) => Response): Route =>
  (call) => (call.url === `http://supabase.test/rest/v1/rpc/${fn}` ? handler(JSON.parse(call.body ?? "{}"), call) : undefined);

const post = (path: string, body: unknown, auth = "Bearer user-jwt") =>
  new Request(`http://fn.test/${path}`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("handleMeetingSave", () => {
  it("로그인하지 않으면 거절하고 저장 RPC를 부르지 않는다", async () => {
    const { env: e, calls } = env([userRoute]);
    const res = await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { body: "x" } }, "Bearer x"), e);
    expect(res.status).toBe(401);
    expect(calls.some((c) => c.url.includes("/rpc/"))).toBe(false);
  });

  it("C01 서식만 바뀌면 analysis_changed=false로 서비스 RPC에 넘긴다(서비스 키는 저장 RPC에만)", async () => {
    let args: Record<string, unknown> | null = null;
    let svcCall: RecordedCall | null = null;
    const { env: e } = env([userRoute, ...readRoutes(), svcRoute("svc_meeting_patch", (a, call) => {
      args = a;
      svcCall = call;
      return jsonResponse(200, { ...meetingRow, version: 4, analysis_revision_id: BASIS_REV });
    })]);
    const res = await handleMeetingSave(post("meeting-save", {
      operation_id: OP, id: MEETING, base_version: 3, patch: { body: "<u>새</u> <span style=\"color:#c92a2a\">본문</span>" },
    }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 4, analysis_changed: false });
    expect(args).toMatchObject({
      p_user_id: USER, p_operation_id: OP, p_id: MEETING, p_base_version: 3,
      p_expected_analysis_revision_id: BASIS_REV, p_analysis_changed: false,
    });
    expect(svcCall!.headers.authorization).toBe("Bearer service-test");
  });

  it("C02 글자·제목이 바뀌면 analysis_changed=true", async () => {
    const seen: unknown[] = [];
    const { env: e } = env([userRoute, ...readRoutes(), svcRoute("svc_meeting_patch", (a) => {
      seen.push(a.p_analysis_changed);
      return jsonResponse(200, { ...meetingRow, analysis_revision_id: "ffffffff-0000-4000-8000-000000000009" });
    })]);
    await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { body: "새 본문 추가" } }), e);
    await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { title: "회의 2" } }), e);
    expect(seen).toEqual([true, true]);
  });

  it("다른 사용자의 회의(RLS로 안 보임)는 404, 팔레트 밖 색은 400", async () => {
    const { env: e } = env([userRoute, ...readRoutes(null)]);
    expect((await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { body: "x" } }), e)).status).toBe(404);
    const bad = await handleMeetingSave(post("meeting-save", {
      operation_id: OP, id: MEETING, base_version: 3, patch: { body: "<span style=\"color:#123456\">x</span>" },
    }), e);
    expect(bad.status).toBe(400);
  });

  it("허용하지 않는 필드·잘못된 ID는 거절한다", async () => {
    const { env: e } = env([userRoute]);
    expect((await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { version: "9" } }), e)).status).toBe(400);
    expect((await handleMeetingSave(post("meeting-save", { operation_id: OP, id: "x", base_version: 3, patch: { body: "a" } }), e)).status).toBe(400);
  });

  it("서버 충돌(409)은 그대로 돌려준다(입력 보존은 화면이 한다)", async () => {
    const { env: e } = env([userRoute, ...readRoutes(), svcRoute("svc_meeting_patch", () =>
      jsonResponse(409, { code: "VERSION_CONFLICT", message: "다른 기기에서 수정되었습니다.", details: "{\"current_version\":4}", hint: null }))]);
    const res = await handleMeetingSave(post("meeting-save", { operation_id: OP, id: MEETING, base_version: 3, patch: { body: "y" } }), e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
  });
});

describe("handleNotesSave", () => {
  it("보이는 글자 수를 계산해 넘긴다(서식 기호 제외)", async () => {
    let args: Record<string, unknown> | null = null;
    const { env: e } = env([userRoute, svcRoute("svc_meeting_notes_patch", (a) => ((args = a), jsonResponse(200, { version: 2 })))]);
    const res = await handleNotesSave(post("notes-save", {
      operation_id: OP, meeting_id: MEETING, base_version: 1, patch: { summary: "**가나** <u>다</u>", decisions: ["<span style=\"color:#1864ab\">결정</span>"] },
    }), e);
    expect(res.status).toBe(200);
    expect(args).toMatchObject({ p_user_id: USER, p_summary_visible: 4, p_decisions_visible: [2] });
  });

  it("L01 보이는 글자 4000자를 넘으면 자르지 않고 거절한다(저장 RPC 호출 없음)", async () => {
    const { env: e, calls } = env([userRoute]);
    const res = await handleNotesSave(post("notes-save", {
      operation_id: OP, meeting_id: MEETING, base_version: 1, patch: { summary: "가".repeat(4001) },
    }), e);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("4,001자");
    expect(calls.some((c) => c.url.includes("/rpc/"))).toBe(false);
  });

  it("잘못된 형식은 거절한다", async () => {
    const { env: e } = env([userRoute]);
    expect((await handleNotesSave(post("notes-save", { operation_id: OP, meeting_id: MEETING, base_version: 1, patch: { decisions: [1] } }), e)).status).toBe(400);
    expect((await handleNotesSave(post("notes-save", { operation_id: OP, meeting_id: MEETING, base_version: 1, patch: {} }), e)).status).toBe(400);
  });
});

describe("서버·PC 설정 일치", () => {
  it("Deno(deno.json)와 Node(package.json)가 같은 라이브러리 버전을 쓴다", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    for (const fn of ["meeting-save", "notes-save"]) {
      const deno = JSON.parse(readFileSync(`supabase/functions/${fn}/deno.json`, "utf8")) as { imports: Record<string, string> };
      for (const name of ["mdast-util-from-markdown", "mdast-util-gfm", "micromark-extension-gfm"]) {
        expect(deno.imports[name], `${fn} ${name}`).toBe(`npm:${name}@${pkg.dependencies[name]}`);
      }
    }
  });

  it("SQL 팔레트(app_private.palette_colors)가 PALETTE와 같다", () => {
    const sql = readFileSync("supabase/migrations/20261020090000_rich_text.sql", "utf8");
    const m = /palette_colors\(\) returns text\[\][\s\S]*?array\[([^\]]*)\]/.exec(sql);
    expect(m).not.toBeNull();
    const colors = [...m![1]!.matchAll(/'(#[0-9a-f]{6})'/g)].map((x) => x[1]);
    expect(colors).toEqual(PALETTE.map((c) => c.value));
  });
});
