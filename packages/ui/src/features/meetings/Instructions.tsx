// 분석 '추가 요청사항' 입력 (docs/plans/2026-10-19-meeting-features.md 2장). PC·휴대폰이 함께 쓴다.
// 비우면 기존 방식으로 분석한다. 요청사항은 원문과 분리돼 전달되고 작업(분석 이력)에 보관된다.

import type { AnalysisJob, MeetingAnalysisState } from "@meeting/contracts";

export const MAX_INSTRUCTIONS = 2000;

/** 확인창을 열 때 채울 값. 재분석은 직전 작업의 요청사항을 불러온다 */
export function initialInstructions(state: MeetingAnalysisState, kind: "run" | "rerun"): string {
  return kind === "rerun" ? (state.job?.user_instructions ?? "") : "";
}

/** 이미 대기·진행 중인 분석이 있어 이번 요청사항이 적용되지 않았는지 */
export function instructionsIgnored(job: AnalysisJob, sent: string): boolean {
  return Boolean(job.deduplicated && sent.trim() && (job.user_instructions ?? "") !== sent.trim());
}

export function InstructionsField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label>
      추가 요청사항 (선택)
      <textarea
        rows={3}
        maxLength={MAX_INSTRUCTIONS}
        value={value}
        disabled={disabled}
        placeholder="예: 결정사항은 짧게, 일정의 장소를 꼭 확인해 줘"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="muted">
        비우면 기존 방식으로 분석합니다. 요청사항은 요약·결정사항의 초점에만 반영되며 출력 형식이나 안전 규칙은 바뀌지 않습니다. ({value.length}/{MAX_INSTRUCTIONS})
      </span>
    </label>
  );
}
