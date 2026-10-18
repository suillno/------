import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 휴대폰 앱 화면. Tauri 2 Android가 이 dev 서버(또는 빌드 결과)를 연다 (docs/plans/mobile-android.md).
export default defineConfig({
  plugins: [react()],
  // 공개 설정(VITE_*)은 저장소 루트의 .env.local에서 읽는다. VITE_ 접두사만 번들에 들어간다.
  envDir: "../..",
  clearScreen: false,
  server: { port: 1430, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
