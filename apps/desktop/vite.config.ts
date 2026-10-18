import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri devUrl(1420)과 일치해야 한다. src-tauri는 감시 대상에서 제외한다.
export default defineConfig({
  plugins: [react()],
  // 공개 설정(VITE_*)은 저장소 루트의 .env.local에서 읽는다. VITE_ 접두사만 번들에 들어간다.
  envDir: "../..",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022" },
});
