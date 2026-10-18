import { createSupabaseMeetingApi } from "@meeting/client-core";
import { isAllowedExternalUrl, storageSettings, type Platform } from "@meeting/ui";

// 모바일 PWA 플랫폼 어댑터. IndexedDB outbox·서비스 워커는 Phase 2에서 이 폴더에 추가한다.
// 웹에는 분석 실행기가 없다. 웹에서 누른 '분석 실행'은 서버 대기열에 들어가고 PC 앱이 처리한다.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const platform: Platform = {
  async getStatus() {
    return {
      kind: "web",
      appVersion: "0.0.0",
      environment: import.meta.env.VITE_APP_ENV ?? "development",
    };
  },
  api: url && anonKey ? createSupabaseMeetingApi({ url, anonKey }) : null,
  async openExternal(target) {
    if (!isAllowedExternalUrl(target)) throw new Error("허용되지 않은 외부 주소입니다");
    window.location.assign(target);
  },
  deviceSettings: storageSettings(() => window.localStorage),
};
