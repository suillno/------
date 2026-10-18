// Google 캘린더 연결·해제, 이 PC 분석 허용. 연결은 '연결' 버튼을 눌렀을 때만 시작한다.

import { useRef, useState } from "react";
import { SingleFlight } from "@meeting/client-core";
import { Badge, ConfirmBox, ErrorText, errorMessage } from "../../common";
import { useApp } from "../../context";
import { SETTING_PC_ANALYSIS } from "../../platform";

export const settingsFeature = {
  id: "settings",
  title: "설정",
} as const;

const OAUTH_RESULT: Record<string, string> = {
  connected: "Google 캘린더를 연결했습니다.",
  denied: "Google 연결을 취소했습니다.",
  scope_denied: "캘린더 권한을 허용하지 않아 연결하지 않았습니다.",
  invalid_state: "연결 요청이 만료되었거나 올바르지 않습니다. 다시 연결하세요.",
  error: "Google 연결 중 오류가 발생했습니다.",
};

export function SettingsPage({ oauthResult }: { oauthResult?: string | null }) {
  const { api, google, refreshGoogle, platform, pcAnalysisEnabled } = useApp();
  const flight = useRef(new SingleFlight()).current;
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const url = await flight.run("google-connect", () => api.startGoogleConnect("/settings"));
      await platform.openExternal(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await flight.run("google-disconnect", () => api.disconnectGoogle());
      setConfirmDisconnect(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refreshGoogle();
    }
  }

  const status = google?.status ?? "none";
  return (
    <section>
      <h2>설정</h2>

      <div className="panel">
        <div className="row between">
          <h3>Google 캘린더</h3>
          <Badge tone={google?.connected ? "done" : status === "auth_required" ? "error" : "idle"}>
            {google?.connected ? "연결됨" : status === "auth_required" ? "다시 연결 필요" : "연결 안 됨"}
          </Badge>
        </div>
        {oauthResult && <p className={oauthResult === "connected" ? "ok" : "error"}>{OAUTH_RESULT[oauthResult] ?? OAUTH_RESULT.error}</p>}
        <p className="muted">
          연결하면 승인한 일정만 기본 캘린더에 등록합니다. 토큰은 서버에만 암호화해 보관하며 이 기기에 저장하지 않습니다.
          {platform.analysisRunner && " 연결 화면은 기본 브라우저에서 열립니다. 완료 후 이 화면에서 ‘상태 새로고침’을 누르세요."}
        </p>
        {confirmDisconnect ? (
          <ConfirmBox title="Google 연결 해제" confirmLabel="연결 해제" busy={busy} onConfirm={() => void disconnect()} onCancel={() => setConfirmDisconnect(false)}>
            <p>Google 토큰을 폐기하고 대기 중인 등록을 멈춥니다. 이미 등록한 일정은 지우지 않습니다.</p>
          </ConfirmBox>
        ) : (
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void connect()}>
              {google?.connected ? "다시 연결" : "Google 캘린더 연결"}
            </button>
            {google?.connected && <button type="button" disabled={busy} onClick={() => setConfirmDisconnect(true)}>연결 해제</button>}
            <button type="button" disabled={busy} onClick={() => void refreshGoogle()}>상태 새로고침</button>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>

      {platform.analysisRunner && <PcAnalysisSetting enabled={pcAnalysisEnabled} />}
    </section>
  );
}

function PcAnalysisSetting({ enabled }: { enabled: boolean }) {
  const { platform } = useApp();
  return (
    <div className="panel">
      <h3>이 PC에서 분석 실행</h3>
      <p className="muted">
        켜면 사용자가 ‘분석 실행’·‘재분석’·‘재시도’를 눌러 요청한 작업만 이 PC의 Claude Code(구독 로그인)로 분석합니다.
        회의 원문이 Anthropic 서비스로 전송됩니다. 앱 시작·저장만으로는 분석하지 않으며, 한도를 넘어도 유료 API로 바꾸지 않습니다.
      </p>
      <label className="inline">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            platform.deviceSettings.set(SETTING_PC_ANALYSIS, e.target.checked ? "1" : "0");
            window.dispatchEvent(new Event("meeting-assistant:settings"));
          }}
        />{" "}
        이 PC에서 요청된 분석을 실행
      </label>
    </div>
  );
}
