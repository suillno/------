import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createSupabaseMeetingApi } from "@meeting/client-core";
import { createMeetingLinkInbox, isAllowedExternalUrl, storageSettings, type Platform, type SharedText } from "@meeting/ui";

// 휴대폰 앱 Platform 어댑터. 분석 실행기는 없다(분석은 PC가 한다).
// 안드로이드 앱(Tauri) 안에서는 opener 플러그인으로, PC 브라우저 미리보기에서는 새 탭으로 연다.
// 로그인 세션은 아직 webview 저장소에 있다. Android Keystore 보안 저장소로 옮기는 작업은 로드맵에 남아 있다.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const deviceSettings = storageSettings(() => window.localStorage);

// 캘린더 ‘원본 회의록 보기’ 딥링크(intent → meetingassistant://meeting/<UUID>)
const meetingLinks = createMeetingLinkInbox(deviceSettings);
if (inTauri) {
  void getCurrent().then((urls) => urls?.forEach((u) => meetingLinks.push(u))).catch(() => undefined);
  void onOpenUrl((urls) => urls.forEach((u) => meetingLinks.push(u))).catch(() => undefined);
}

/**
 * MainActivity.kt가 WebView에 붙이는 공유 수신 브리지. take()는 보관된 공유를 JSON으로 돌려주고 지운다.
 * 형식: {"title": string|null, "text": string|null, "unsupported": string|null}
 */
interface ShareBridge {
  take(): string;
}

function shareBridge(): ShareBridge | null {
  const b = (window as unknown as { MeetingAssistantShare?: ShareBridge }).MeetingAssistantShare;
  return b && typeof b.take === "function" ? b : null;
}

const MAX_SHARED_CHARS = 1_000_000;

async function takeSharedText(): Promise<SharedText | null> {
  const bridge = shareBridge();
  if (!bridge) return null;
  let parsed: unknown;
  try {
    const raw = bridge.take();
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // 공유 내용은 다른 앱이 보낸 신뢰할 수 없는 데이터다. 문자열만 받고 길이를 자른다.
  const o = parsed as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
  return {
    title: str(o.title, 300),
    text: str(o.text, MAX_SHARED_CHARS),
    unsupported: str(o.unsupported, 300),
  };
}

export const platform: Platform = {
  async getStatus() {
    return { kind: "web", appVersion: "0.0.2", environment: import.meta.env.VITE_APP_ENV ?? "development" };
  },
  api: url && anonKey ? createSupabaseMeetingApi({ url, anonKey }) : null,
  async openExternal(target) {
    // capabilities/default.json도 같은 주소만 허용한다
    if (!isAllowedExternalUrl(target)) throw new Error("허용되지 않은 외부 주소입니다");
    if (inTauri) await openUrl(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  },
  deviceSettings,
  meetingLinks,
  takeSharedText,
};
