// 설치된 PC 앱 실행. 실행: npm run start:app  (설치: npm run install:desktop)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exe = join(process.env.LOCALAPPDATA ?? "", "Programs", "MeetingAssistant", "meeting-assistant.exe");
if (!existsSync(exe)) {
  console.error("설치본이 없습니다. 먼저 npm run install:desktop 을 실행하세요.");
  process.exit(1);
}
// 앱은 이 터미널과 분리해 띄운다. 이미 실행 중이면 앱이 기존 창을 앞으로 가져온다(단일 인스턴스).
spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
console.log("회의 어시스턴트를 실행했습니다.");
