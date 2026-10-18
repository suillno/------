import { openUrl } from "@tauri-apps/plugin-opener";
import { createSupabaseMeetingApi } from "@meeting/client-core";
import { isAllowedExternalUrl, storageSettings, type Platform } from "@meeting/ui";

// 휴대폰 앱 Platform 어댑터. 분석 실행기는 없다(분석은 PC가 한다).
// 안드로이드 앱(Tauri) 안에서는 opener 플러그인으로, PC 브라우저 미리보기에서는 새 탭으로 연다.
// 로그인 세션은 아직 webview 저장소에 있다. Android Keystore 보안 저장소로 옮기는 작업은 로드맵에 남아 있다.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platform: Platform = {
  async getStatus() {
    return { kind: "web", appVersion: "0.0.1", environment: import.meta.env.VITE_APP_ENV ?? "development" };
  },
  api: url && anonKey ? createSupabaseMeetingApi({ url, anonKey }) : null,
  async openExternal(target) {
    // capabilities/default.json도 같은 주소만 허용한다
    if (!isAllowedExternalUrl(target)) throw new Error("허용되지 않은 외부 주소입니다");
    if (inTauri) await openUrl(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  },
  deviceSettings: storageSettings(() => window.localStorage),
};
