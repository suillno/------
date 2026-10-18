// UI가 기기 기능에 접근하는 유일한 경로. UI는 DB·CLI·파일 경로를 직접 다루지 않는다 (docs/design.md 20.2).
// 구현: apps/web/src/platform, apps/desktop/src/platform (Tauri IPC)

import type { AnalysisRunner, MeetingApi } from "@meeting/client-core";

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
