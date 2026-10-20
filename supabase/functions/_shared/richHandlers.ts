// 서식 있는 회의 본문·편집본 저장 (docs/plans/2026-10-20-rich-text.md 5.3, ADR 0005).
// DB(SQL)는 Markdown을 해석할 수 없으므로, PC 앱과 같은 변환 코드(richtext.ts)로 여기서 판정한 뒤
// 서비스 전용 RPC로 저장한다. 판정값을 받는 RPC는 버전·소유·저장 길이·분석 기준 revision을 다시 검사한다.
// 이 파일은 Markdown 라이브러리를 쓰므로 meeting-save·notes-save 함수만 가져온다(각 함수의 deno.json에 버전 고정).

import {
  UUID,
  apiError,
  authenticatedPost,
  json,
  rpcFailure,
  serviceEndpoint,
  userEndpoint,
  type ServerEnv,
} from "./handlers.ts";
import { rpc, select } from "./postgrest.ts";
import { analysisChanged, checkNotes, foreignColors, notesIssueMessage, visibleLength, type AnalysisInput } from "./richtext.ts";

const MEETING_FIELDS = new Set(["title", "body", "meeting_at", "time_zone"]);

interface MeetingRowLite {
  id: string;
  version: number;
  title: string;
  body: string;
  meeting_at: string;
  time_zone: string;
  analysis_revision_id: string;
  deleted_at: string | null;
}

interface RevisionLite {
  immutable_snapshot: { title?: unknown; body?: unknown; meeting_at?: unknown; time_zone?: unknown };
}

function asInput(s: RevisionLite["immutable_snapshot"]): AnalysisInput {
  return {
    title: typeof s.title === "string" ? s.title : "",
    body: typeof s.body === "string" ? s.body : "",
    meeting_at: typeof s.meeting_at === "string" ? s.meeting_at : "",
    time_zone: typeof s.time_zone === "string" ? s.time_zone : "",
  };
}

/**
 * POST meeting-save: { operation_id, id, base_version, patch: { title?, body?, meeting_at?, time_zone? } }
 * 분석 기준 revision(분석 당시 원문)과 저장할 값을 같은 규칙으로 비교해 ‘서식만 바뀜’이면 기존 결과·후보를 유지한다.
 * 응답: 저장된 회의 + analysis_changed
 */
export async function handleMeetingSave(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const { operation_id, id, base_version, patch } = auth.body;
  if (typeof operation_id !== "string" || !UUID.test(operation_id) || typeof id !== "string" || !UUID.test(id)
      || !Number.isSafeInteger(base_version) || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "operation_id, id, base_version, patch가 필요합니다.");
  }
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.some((k) => !MEETING_FIELDS.has(k) || typeof p[k] !== "string")) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "title·body·meeting_at·time_zone 문자열만 수정할 수 있습니다.");
  }
  if (typeof p.body === "string" && foreignColors(p.body).length) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "허용하지 않는 글자색이 있습니다.");
  }

  try {
    // 사용자 JWT로 읽는다(RLS가 소유권 검사). 다른 사용자의 회의는 없는 것으로 보인다.
    const user = userEndpoint(env, auth.token);
    const [meeting] = await select<MeetingRowLite>(user, "meetings",
      `id=eq.${id}&select=id,version,title,body,meeting_at,time_zone,analysis_revision_id,deleted_at`);
    if (!meeting || meeting.deleted_at) return apiError(req, env, 404, "NOT_FOUND", "회의록을 찾을 수 없습니다.");
    const [basisRev] = await select<RevisionLite>(user, "meeting_revisions",
      `id=eq.${meeting.analysis_revision_id}&select=immutable_snapshot`);
    if (!basisRev) return apiError(req, env, 503, "SERVICE_UNAVAILABLE", "분석 기준 원문을 읽을 수 없습니다.");

    const after: AnalysisInput = {
      title: typeof p.title === "string" ? p.title : meeting.title,
      body: typeof p.body === "string" ? p.body : meeting.body,
      meeting_at: typeof p.meeting_at === "string" ? p.meeting_at : meeting.meeting_at,
      time_zone: typeof p.time_zone === "string" ? p.time_zone : meeting.time_zone,
    };
    const changed = analysisChanged(asInput(basisRev.immutable_snapshot), after);

    const saved = await rpc<Record<string, unknown>>(serviceEndpoint(env), "svc_meeting_patch", {
      p_user_id: auth.userId,
      p_operation_id: operation_id,
      p_id: id,
      p_base_version: base_version,
      p_patch: p,
      p_expected_analysis_revision_id: meeting.analysis_revision_id,
      p_analysis_changed: changed,
    });
    return json(req, env, 200, { ...saved, analysis_changed: saved.analysis_revision_id !== meeting.analysis_revision_id });
  } catch (e) {
    return rpcFailure(req, env, e);
  }
}

/**
 * POST notes-save: { operation_id, meeting_id, base_version, patch: { summary?, decisions? } }
 * 보이는 글자 수(요약 4000·결정 항목 1000)와 서식 포함 저장 한도를 검사한다. 넘으면 자르지 않고 거절한다.
 */
export async function handleNotesSave(req: Request, env: ServerEnv): Promise<Response> {
  const auth = await authenticatedPost(req, env);
  if (auth instanceof Response) return auth;
  const { operation_id, meeting_id, base_version, patch } = auth.body;
  if (typeof operation_id !== "string" || !UUID.test(operation_id) || typeof meeting_id !== "string" || !UUID.test(meeting_id)
      || !Number.isSafeInteger(base_version) || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "operation_id, meeting_id, base_version, patch가 필요합니다.");
  }
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.some((k) => k !== "summary" && k !== "decisions")
      || (p.summary !== undefined && typeof p.summary !== "string")
      || (p.decisions !== undefined && (!Array.isArray(p.decisions) || p.decisions.some((d) => typeof d !== "string")))) {
    return apiError(req, env, 400, "VALIDATION_FAILED", "summary(문자열)·decisions(문자열 배열)만 수정할 수 있습니다.");
  }
  const summary = p.summary as string | undefined;
  const decisions = p.decisions as string[] | undefined;
  const issues = checkNotes(summary ?? "", decisions ?? []);
  if (issues.length) return apiError(req, env, 400, "VALIDATION_FAILED", issues.map(notesIssueMessage).join(" "));

  try {
    const saved = await rpc<unknown>(serviceEndpoint(env), "svc_meeting_notes_patch", {
      p_user_id: auth.userId,
      p_operation_id: operation_id,
      p_meeting_id: meeting_id,
      p_base_version: base_version,
      p_patch: p,
      p_summary_visible: summary === undefined ? null : visibleLength(summary),
      p_decisions_visible: decisions === undefined ? null : decisions.map(visibleLength),
    });
    return json(req, env, 200, saved);
  } catch (e) {
    return rpcFailure(req, env, e);
  }
}
