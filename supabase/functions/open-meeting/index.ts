// Edge Function 진입점. 처리 로직은 ../_shared/handlers.ts에 있다.
// DB를 쓰지 않는다(회의 UUID 형식만 검사하고 앱으로 넘긴다). 공개 함수 주소는 OAuth 콜백 주소에서 만든다.
import { functionsBaseUrlFrom, handleOpenMeeting } from "../_shared/handlers.ts";

const functionsBaseUrl = functionsBaseUrlFrom(Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI"));

Deno.serve((req) => handleOpenMeeting(req, functionsBaseUrl));
