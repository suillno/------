// Supabase Auth 이메일 로그인. 데스크톱 PKCE + Credential Manager 저장은 Phase 2 남은 작업이다.

import { useState } from "react";
import type { MeetingApi } from "@meeting/client-core";
import { ErrorText, errorMessage } from "../../common";

export function LoginForm({ api }: { api: MeetingApi }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signin") await api.signIn(email, password);
      else {
        await api.signUp(email, password);
        setInfo("가입했습니다. 이메일 확인이 필요하면 메일의 링크를 누른 뒤 로그인하세요.");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel login" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>{mode === "signin" ? "로그인" : "회원가입"}</h2>
      <fieldset disabled={busy}>
        <label>
          이메일
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          비밀번호
          <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} required minLength={8}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="primary">{busy ? "처리 중…" : mode === "signin" ? "로그인" : "가입"}</button>
          <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "회원가입" : "로그인으로"}
          </button>
        </div>
      </fieldset>
      {info && <p className="ok">{info}</p>}
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
