// Edge Function 진입점. 처리 로직은 ../_shared/handlers.ts에 있다.
import { handleDisconnect, loadServerEnv } from "../_shared/handlers.ts";

const env = loadServerEnv((name) => Deno.env.get(name));

Deno.serve((req) => handleDisconnect(req, env));
