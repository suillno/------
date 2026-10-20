// Edge Function 진입점. 처리 로직은 ../_shared/richHandlers.ts에 있다.
// 라이브러리 버전은 deno.json에서 package.json과 같은 값으로 고정한다.
import { loadServerEnv } from "../_shared/handlers.ts";
import { handleMeetingSave } from "../_shared/richHandlers.ts";

const env = loadServerEnv((name) => Deno.env.get(name));

Deno.serve((req) => handleMeetingSave(req, env));
