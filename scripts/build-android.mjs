// 안드로이드 APK 빌드. 실행: npm run build:android  (인자를 주면 tauri android build에 그대로 전달)
//
// 저장소 경로에 한글이 있으면 Windows에서 두 가지가 실패한다.
//   1) NDK 링커(clang.cmd)가 비ASCII 경로의 중간 파일을 열지 못한다
//      → Rust 빌드 출력(CARGO_TARGET_DIR)을 영문 경로 %LOCALAPPDATA%\MeetingAssistant\build\android-target 에 둔다.
//   2) Android Gradle 플러그인이 비ASCII 프로젝트 경로를 거부한다
//      → gen/android/gradle.properties의 android.overridePathCheck=true.
// 빈 드라이브 문자 연결(subst)은 Rust 경로 정규화가 원래 경로로 되돌려 Tauri가 거부하므로 쓰지 않는다.
// ANDROID_HOME·NDK_HOME·JAVA_HOME은 사용자 환경변수에서 읽는다(값을 출력하지 않는다).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const missing = ["ANDROID_HOME", "NDK_HOME", "JAVA_HOME"].filter((k) => !process.env[k]);
if (missing.length) fail(`환경변수가 없습니다: ${missing.join(", ")}. Android Studio 설치 후 사용자 환경변수를 설정하세요.`);
if (process.platform !== "win32" || !process.env.LOCALAPPDATA) fail("Windows 전용 스크립트입니다.");

// Tauri는 빌드한 라이브러리를 안드로이드 프로젝트에 심볼릭 링크로 연결한다.
// Windows에서 관리자 권한 없이 심볼릭 링크를 만들려면 개발자 모드가 켜져 있어야 한다(빌드할 때만 필요).
function developerModeEnabled() {
  const q = spawnSync("reg", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock",
    "/v",
    "AllowDevelopmentWithoutDevLicense",
  ], { encoding: "utf8" });
  return q.status === 0 && /AllowDevelopmentWithoutDevLicense\s+REG_DWORD\s+0x1\b/i.test(q.stdout);
}

if (!developerModeEnabled()) {
  fail([
    "Windows 개발자 모드가 꺼져 있어 APK를 빌드할 수 없습니다.",
    "  설정(Win + I) → 시스템 → 고급(또는 '개발자용') → 개발자 모드 켬",
    "빌드가 끝나면 다시 꺼도 됩니다. 휴대폰 설치·사용과 PC 앱에는 필요 없습니다.",
  ].join("\n"));
}

const targetDir = join(process.env.LOCALAPPDATA, "MeetingAssistant", "build", "android-target");
mkdirSync(targetDir, { recursive: true });

const extra = process.argv.slice(2);
const args = ["tauri", "android", "build", "--apk", ...(extra.length ? extra : ["--debug", "--target", "aarch64"])];
const cargoBin = process.env.USERPROFILE ? join(process.env.USERPROFILE, ".cargo", "bin") : "";

const run = spawnSync("npx", args, {
  cwd: join(repoRoot, "apps", "mobile"),
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    PATH: [cargoBin, join(process.env.JAVA_HOME, "bin"), process.env.PATH].filter(Boolean).join(";"),
  },
});
const status = run.status ?? 1;

if (status === 0) {
  console.log(`\nAPK 위치: ${join(repoRoot, "apps", "mobile", "src-tauri", "gen", "android", "app", "build", "outputs", "apk")}`);
}
process.exit(status);
