// UI가 기기 기능에 접근하는 유일한 경로. UI는 DB·CLI·파일 경로를 직접 다루지 않는다 (docs/design.md 20.2).
// 구현: apps/web/src/platform, apps/desktop/src/platform (Tauri IPC)

import { parseMeetingLink, type AnalysisRunner, type MeetingApi } from "@meeting/client-core";

export interface PlatformStatus {
  kind: "web" | "desktop";
  appVersion: string;
  environment: string;
  /** 데스크톱 전용. 에이전트·CLI 진단 요약 (경로 등 민감 정보 없이) */
  diagnostics?: Record<string, string>;
}

/** 기기별 설정(브라우저 저장소). 읽기·쓰기에 실패하면 기본값으로 동작한다. */
export interface DeviceSettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Platform {
  getStatus(): Promise<PlatformStatus>;
  /** null이면 Supabase 공개 설정(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)이 없다 */
  api: MeetingApi | null;
  /** 데스크톱 전용. 이 PC의 Claude Code CLI로 분석한다 */
  analysisRunner?: AnalysisRunner;
  /** Google 동의·캘린더 화면처럼 허용된 외부 주소만 연다 */
  openExternal(url: string): Promise<void>;
  deviceSettings: DeviceSettings;
  /** 캘린더 ‘원본 회의록 보기’ 딥링크 (데스크톱·안드로이드 앱) */
  meetingLinks?: MeetingLinkInbox;
  /** 안드로이드: 다른 앱의 ‘공유’로 받은 텍스트를 한 번 꺼낸다(꺼내면 지워진다) */
  takeSharedText?: () => Promise<SharedText | null>;
}

export const SETTING_PC_ANALYSIS = "meeting-assistant.pc-analysis-enabled";
export const SETTING_DEVICE_ID = "meeting-assistant.device-id";

export function storageSettings(storage: () => Storage): DeviceSettings {
  return {
    get(key) {
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage().setItem(key, value);
      } catch {
        // 저장소를 쓸 수 없으면 이번 실행 동안만 기본값을 쓴다
      }
    },
  };
}

const EXTERNAL_PREFIXES = [
  "https://accounts.google.com/",
  "https://calendar.google.com/",
  "https://www.google.com/calendar/",
];

/** 외부로 여는 주소는 Google 동의·캘린더 화면만 허용한다(서버 응답도 신뢰하지 않는다). */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && EXTERNAL_PREFIXES.some((p) => u.href.startsWith(p));
  } catch {
    return false;
  }
}

// ───────── 원본 회의록 딥링크 수신함 (docs/plans/2026-10-19-meeting-features.md 4장) ─────────
// 앱 어댑터가 받은 링크를 회의 ID로 바꿔 기기 저장소에 먼저 보관한다(로그인 전에 받아도 유지).
// 로그인한 화면이 take()로 꺼내 해당 회의를 연다.

export const MEETING_LINK_EVENT = "meeting-assistant:meeting-link";
const SETTING_PENDING_MEETING = "meeting-assistant.pending-meeting";

export interface MeetingLinkInbox {
  /** 보관된 회의 ID를 꺼내고 지운다 */
  take(): string | null;
  /** 앱이 켜져 있는 동안 새로 받은 링크 */
  subscribe(listener: (meetingId: string) => void): () => void;
}

export function createMeetingLinkInbox(settings: DeviceSettings): MeetingLinkInbox & { push(url: string): void } {
  return {
    push(url) {
      const id = parseMeetingLink(url);
      if (!id) return;
      settings.set(SETTING_PENDING_MEETING, id);
      window.dispatchEvent(new CustomEvent<string>(MEETING_LINK_EVENT, { detail: id }));
    },
    take() {
      const id = settings.get(SETTING_PENDING_MEETING);
      if (id) settings.set(SETTING_PENDING_MEETING, "");
      return id ? parseMeetingLink(`meetingassistant://meeting/${id}`) : null;
    },
    subscribe(listener) {
      const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
      window.addEventListener(MEETING_LINK_EVENT, handler);
      return () => window.removeEventListener(MEETING_LINK_EVENT, handler);
    },
  };
}

// ───────── 다른 앱에서 공유받은 텍스트 (안드로이드, 5장) ─────────

export interface SharedText {
  title: string | null;
  text: string | null;
  /** 텍스트가 아닌 공유(이미지·첨부)를 받았을 때 안내 */
  unsupported?: string | null;
}

export const SHARE_EVENT = "meeting-assistant:share";
