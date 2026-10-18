import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // 공개 설정(VITE_*)은 저장소 루트의 .env.local에서 읽는다. VITE_ 접두사만 번들에 들어간다.
  envDir: "../..",
  server: { port: 5173, strictPort: true },
});
