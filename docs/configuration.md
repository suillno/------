# 설정과 로컬 경로

## 비밀값 관리 원칙

- Google Calendar API 키를 포함한 모든 비밀값(API 키, OAuth client secret, service-role 키, 토큰 암호화 키, 토큰)은 Git에 올리지 않는다. 소스·문서·테스트·예제·로그에도 실제 값을 쓰지 않는다.
- 값은 Git에서 제외한 로컬 파일 또는 서버 비밀 저장소에만 둔다. `.gitignore`의 `.env*` 규칙이 `.env.local`과 `supabase/functions/.env`를 제외한다(`.env.example`만 예외).
- [`.env.example`](../.env.example)에는 변수 이름·용도·필수 여부와 빈 값만 둔다.
- 키가 대화·이슈·커밋에 노출됐다면 그 값을 쓰지 말고 발급처에서 폐기·재발급한다.
- 이 앱은 Google API 키를 쓰지 않는다. 사용자 캘린더 등록에는 사용자 OAuth 동의로 받은 토큰이 필요하며, 그 refresh token은 서버에 암호화해 저장한다.

## 환경변수

| 구분 | 변수 | 위치 |
|---|---|---|
| 클라이언트 공개 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ENV` | 저장소 루트 `.env.local` (Vite `envDir`). 번들에 포함되므로 RLS가 전제다. 2026-10-18부터 클라우드 값 |
| 보관용 공개 값 | `LOCAL_DEV_SUPABASE_*`, `CLOUD_SUPABASE_*` | `.env.local`. 앱은 읽지 않고, 로컬↔클라우드 전환 시 `VITE_*`로 옮겨 쓴다 |
| 서버 비밀 | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_SCOPES`, `TOKEN_ENCRYPTION_KEY`, `APP_WEB_ORIGIN`(선택), `APP_ALLOWED_ORIGINS` | 로컬: `supabase/functions/.env` / 클라우드: `supabase secrets set` (2026-10-18 등록, `APP_WEB_ORIGIN` 없음 → 콜백이 안내 문구 응답) |
| 서버 자동 주입 | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Edge Function 실행 환경. 직접 넣지 않는다 |
| 개발·테스트 전용 | `MEETING_ASSISTANT_DATA_ROOT_OVERRIDE` | 릴리스(production) 빌드에서는 무시한다 |
| 통합 테스트 | `LOCAL_SUPABASE_URL`, `LOCAL_SUPABASE_ANON_KEY` | `npm run test:integration`이 `supabase status`에서 읽어 넘긴다 |

### 로컬 Google OAuth 준비

1. Google Cloud 콘솔에서 Calendar API를 사용 설정하고 OAuth 동의 화면을 테스트 모드로 만든 뒤 본인 계정을 테스트 사용자로 추가한다.
2. OAuth 클라이언트 ID(웹 애플리케이션)를 만들고 승인된 리디렉션 URI에 `http://127.0.0.1:54321/functions/v1/google-oauth-callback`을 넣는다.
3. 발급된 client ID·secret을 `supabase/functions/.env`에만 적는다.
4. `TOKEN_ENCRYPTION_KEY`는 32바이트 난수의 base64다. 예: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`의 출력을 파일에 바로 넣고 화면·로그에 남기지 않는다.
5. `npm run db:start` → `npm run functions:serve` → `npm run dev:web`.

## Windows 데이터 경로

`apps/desktop/src-tauri/src/paths.rs`의 `PathResolver`로만 만든다.

```text
%LOCALAPPDATA%/MeetingAssistant/<development|test|production>/
├─ settings.json
├─ accounts/<user_uuid>/{db/cache.sqlite3, backups/, analysis/jobs/<job_uuid>/upload.json, exports/, logs/}
├─ logs/
└─ tmp/
```

- 환경은 빌드 종류로 정한다. 디버그 빌드는 `development`, 릴리스 빌드는 `production`, `cargo test`는 `test`다.
- 사용자·작업 ID는 하이픈 포함 소문자 UUID만 허용한다.
- `ensure_dir`는 정규화한 실제 경로가 data_root 안에 있는지 확인한다(junction·심볼릭 링크 이탈 차단).
- 설치 폴더, exe 옆, 소스 폴더, 현재 작업 폴더에 DB·토큰·로그를 저장하지 않는다.
- `analysis/jobs/<job>/upload.json`은 업로드 전 분석 결과다. 업로드에 성공하거나 서버가 받을 수 없으면(리스 만료) 작업 폴더째 지운다. 여기에 든 리스 토큰은 120초짜리 작업 토큰이며 계정 자격증명이 아니다.
- Supabase 로그인 세션은 현재 webview localStorage에 있다. Windows Credential Manager로 옮기는 작업은 Phase 2에 남아 있다. Claude Code 인증 파일은 앱이 건드리지 않는다.
- Claude Code CLI는 PATH의 `claude.exe`, npm 전역 설치(`claude.cmd` 옆 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`), `%USERPROFILE%\.local\bin\claude.exe` 순서로 찾는다. `.cmd` 래퍼는 실행하지 않는다.
