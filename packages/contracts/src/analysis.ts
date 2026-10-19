// 분석 결과 schema v1·v2 (docs/design.md 9장). 이 파일이 단일 원본이며 prompts/에 사본을 두지 않는다.

export interface AnalysisActionItem {
  text: string;
  assignee: string | null;
  due_date: string | null;
}

export interface AnalysisEventCandidate {
  title: string;
  start_local: string | null;
  end_local: string | null;
  time_zone: string;
  all_day: boolean;
  evidence: string;
  needs_confirmation: boolean;
}

export interface AnalysisResultV1 {
  schema_version: 1;
  summary: string;
  decisions: string[];
  action_items: AnalysisActionItem[];
  event_candidates: AnalysisEventCandidate[];
}

const nullableString = { type: ["string", "null"] } as const;

export const analysisResultV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "meeting-assistant/analysis-result/v1",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "summary", "decisions", "action_items", "event_candidates"],
  properties: {
    schema_version: { const: 1 },
    summary: { type: "string", maxLength: 4000 },
    decisions: { type: "array", maxItems: 50, items: { type: "string", maxLength: 1000 } },
    action_items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "assignee", "due_date"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 1000 },
          assignee: nullableString,
          due_date: { type: ["string", "null"], format: "date" },
        },
      },
    },
    event_candidates: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "start_local",
          "end_local",
          "time_zone",
          "all_day",
          "evidence",
          "needs_confirmation",
        ],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 300 },
          start_local: nullableString,
          end_local: nullableString,
          time_zone: { type: "string", minLength: 1 },
          all_day: { type: "boolean" },
          evidence: { type: "string", maxLength: 2000 },
          needs_confirmation: { type: "boolean" },
        },
      },
    },
  },
} as const;

// ───────────── schema v2 (2026-10-19): 일정 후보에 목적지 추가 ─────────────
// docs/plans/2026-10-19-meeting-features.md 3장. v1 결과는 location = null로 다룬다.

export interface AnalysisEventCandidateV2 extends AnalysisEventCandidate {
  /** 원문에 실제 목적지가 적힌 경우에만 그 이름. 없으면 null(추측·기본값 금지) */
  location: string | null;
  /** 목적지가 언급됐지만 어느 곳인지 불명확하거나 여러 곳이면 true → 승인 전 사용자 확인 */
  location_uncertain: boolean;
}

export interface AnalysisResultV2 {
  schema_version: 2;
  summary: string;
  decisions: string[];
  action_items: AnalysisActionItem[];
  event_candidates: AnalysisEventCandidateV2[];
}

/** 저장된 결과는 v1·v2가 섞여 있다. 새 분석은 v2로 만든다. */
export type AnalysisResult = AnalysisResultV1 | AnalysisResultV2;

const v1Candidate = analysisResultV1Schema.properties.event_candidates.items;

export const analysisResultV2Schema = {
  ...analysisResultV1Schema,
  $id: "meeting-assistant/analysis-result/v2",
  properties: {
    ...analysisResultV1Schema.properties,
    schema_version: { const: 2 },
    event_candidates: {
      type: "array",
      maxItems: 30,
      items: {
        ...v1Candidate,
        required: [...v1Candidate.required, "location", "location_uncertain"],
        properties: {
          ...v1Candidate.properties,
          location: { type: ["string", "null"], maxLength: 200 },
          location_uncertain: { type: "boolean" },
        },
      },
    },
  },
} as const;
