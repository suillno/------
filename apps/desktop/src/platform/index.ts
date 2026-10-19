import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createSupabaseMeetingApi, type AnalysisRunner, type SavedAnalysis, type RunOutcome } from "@meeting/client-core";
import { createMeetingLinkInbox, isAllowedExternalUrl, storageSettings, type Platform, type PlatformStatus } from "@meeting/ui";

// Tauri IPC 클라이언트. 허용된 명령만 호출한다 (src-tauri/src/commands).

/** 외부 링크(Google 동의·캘린더)를 열 브라우저. capabilities/default.json의 app 값과 같아야 한다. */
const PREFERRED_BROWSER = "chrome.exe";
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const analysisRunner: AnalysisRunner = {
  run(userId, claimed) {
    return invoke<RunOutcome>("run_analysis", { userId, claimed });
  },
  pendingUploads(userId) {
    return invoke<SavedAnalysis[]>("pending_analysis_uploads", { userId });
  },
  clearUpload(userId, jobId) {
    return invoke<void>("clear_analysis_upload", { userId, jobId });
  },
};

const deviceSettings = storageSettings(() => window.localStorage);

// 캘린더 ‘원본 회의록 보기’ 딥링크. 앱을 링크로 처음 켰을 때(getCurrent)와 켜져 있을 때(onOpenUrl) 모두 받는다.
// 회의 UUID만 꺼내 기기에 보관하고, 로그인한 화면이 꺼내 연다.
const meetingLinks = createMeetingLinkInbox(deviceSettings);
void getCurrent().then((urls) => urls?.forEach((u) => meetingLinks.push(u))).catch(() => undefined);
void onOpenUrl((urls) => urls.forEach((u) => meetingLinks.push(u))).catch(() => undefined);

export const platform: Platform = {
  async getStatus() {
    return invoke<PlatformStatus>("app_status");
  },
  api: url && anonKey ? createSupabaseMeetingApi({ url, anonKey }) : null,
  analysisRunner,
  async openExternal(target) {
    // capabilities/default.json도 같은 주소만, 기본 브라우저 또는 chrome.exe로만 허용한다
    if (!isAllowedExternalUrl(target)) throw new Error("허용되지 않은 외부 주소입니다");
    try {
      // Chrome으로 연다. 경로는 Windows App Paths 레지스트리에서 찾고 URL은 셸 없이 인자로 넘긴다.
      await openUrl(target, PREFERRED_BROWSER);
    } catch {
      // Chrome이 없거나 실행할 수 없으면 Windows 기본 브라우저로 연다
      await openUrl(target);
    }
  },
  deviceSettings,
  meetingLinks,
};
