// '분석 실행'·'재분석'·'재시도' 버튼과 분석 상태·편집본.
// 분석은 이 버튼을 누르고 확인했을 때만 요청한다. 화면을 열거나 저장할 때 자동으로 요청하지 않는다.

import { useRef, useState } from "react";
import { SingleFlight, analysisView } from "@meeting/client-core";
import type { MeetingAnalysisState } from "@meeting/contracts";
import { Badge, ConfirmBox, ErrorText, errorMessage, needsRefresh } from "../../common";
import { useApp } from "../../context";
import { NotesEditor } from "../notes/NotesEditor";
import { InstructionsField, initialInstructions, instructionsIgnored } from "./Instructions";

type Pending = "run" | "rerun" | "retry" | null;

export function AnalysisPanel({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api, runOnThisDevice, pcAnalysisEnabled, platform } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [pending, setPending] = useState<Pending>(null);
  const [confirming, setConfirmingState] = useState<"run" | "rerun" | null>(null);
  const [instructions, setInstructions] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setConfirming = (kind: "run" | "rerun" | null) => {
    if (kind) setInstructions(initialInstructions(state, kind));
    setConfirmingState(kind);
  };
  const view = analysisView(state, pending !== null);
  const key = `analysis:${state.meeting.id}`;

  async function execute(kind: "run" | "rerun" | "retry") {
    setError(null);
    setNotice(null);
    setPending(kind);
    try {
      const job = await flight.run(key, (op) =>
        kind === "retry" && state.job
          ? api.retryAnalysis(op, state.job.id)
          : api.requestAnalysis(op, state.meeting.id, state.meeting.analysis_revision_id ?? state.meeting.revision_id, kind === "rerun" ? "rerun" : "initial", instructions),
      );
      if (kind !== "retry" && instructionsIgnored(job, instructions)) {
        setNotice("이미 요청된 분석이 있어 새 요청사항은 적용되지 않았습니다. 분석이 끝난 뒤 재분석에서 다시 입력하세요.");
      }
      setConfirming(null);
      if (job.status === "queued") runOnThisDevice?.(job.id);
    } catch (e) {
      setError(errorMessage(e));
      if (needsRefresh(e)) setConfirming(null);
    } finally {
      setPending(null);
      await refresh();
    }
  }

  const isDesktop = Boolean(platform.analysisRunner);
  return (
    <section className="panel" aria-label="AI 분석">
      <div className="row between">
        <h3>AI 분석</h3>
        <Badge tone={view.tone}>{pending ? "요청 중…" : view.statusLabel}</Badge>
      </div>
      {view.message && <p className={view.tone === "error" ? "error" : "muted"}>{view.message}</p>}
      {state.job?.status === "queued" && !isDesktop && (
        <p className="muted">웹에서는 분석을 실행하지 않습니다. 이 요청은 데스크톱 앱(로그인 + 설정의 ‘이 PC에서 분석 실행’ 켜짐)이 처리합니다.</p>
      )}
      {state.job?.status === "queued" && isDesktop && pcAnalysisEnabled && (
        <p className="muted">이 PC가 30초 안에 가져가 분석합니다.</p>
      )}
      {view.tone === "busy" && isDesktop && !pcAnalysisEnabled && (
        <p className="muted">이 PC에서 분석이 꺼져 있습니다. 설정에서 ‘이 PC에서 분석 실행’을 켜거나 다른 PC 앱에서 처리됩니다.</p>
      )}

      {confirming ? (
        <ConfirmBox
          title={confirming === "rerun" ? "재분석" : "분석 실행"}
          confirmLabel={confirming === "rerun" ? "재분석 실행" : "분석 실행"}
          busy={pending !== null}
          onConfirm={() => void execute(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>현재 회의록 원문(제목·본문·회의 날짜)을 PC의 Claude Code로 보내 분석합니다. 원문은 Anthropic 서비스로 전송됩니다.</p>
          {confirming === "rerun" && <p>재분석 결과는 새 결과로만 저장되며, 지금의 요약·결정사항 편집본과 할 일 상태는 바뀌지 않습니다.</p>}
          <InstructionsField value={instructions} onChange={setInstructions} disabled={pending !== null} />
        </ConfirmBox>
      ) : (
        <div className="row">
          {view.buttons.map((b) => (
            <button
              key={b.kind}
              type="button"
              className={b.kind === "retry" ? "primary" : undefined}
              disabled={!b.enabled}
              title={b.reason}
              onClick={() => (b.kind === "retry" ? void execute("retry") : setConfirming(b.kind))}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      {state.job?.user_instructions && !confirming && (
        <p className="muted">요청사항: {state.job.user_instructions}</p>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      <NotesEditor state={state} refresh={refresh} />
    </section>
  );
}

