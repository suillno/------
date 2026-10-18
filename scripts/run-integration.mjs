// 로컬 Supabase 주소·공개 키를 `supabase status`에서 읽어 통합 테스트를 실행한다.
// 키 값은 출력하지 않고 자식 프로세스 환경변수로만 넘긴다. 실행 전: npm run db:start, npm run functions:serve
import { spawnSync } from "node:child_process";

const status = spawnSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", shell: true });
const env = Object.fromEntries(
  (status.stdout ?? "").split(/\r?\n/).map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]),
);
if (!env.API_URL || !env.ANON_KEY) {
  console.error("로컬 Supabase가 실행 중이 아닙니다. npm run db:start 후 다시 실행하세요.");
  process.exit(1);
}
const run = spawnSync("npx", ["vitest", "run", "tests/integration"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, LOCAL_SUPABASE_URL: env.API_URL, LOCAL_SUPABASE_ANON_KEY: env.ANON_KEY },
});
process.exit(run.status ?? 1);
