# ADR 0003. 버튼으로만 실행하는 분석·캘린더 등록

- 상태: 채택
- 날짜: 2026-10-18

## 배경

요구사항(2026-10-18):

1. 모든 비밀값은 Git·소스·문서·테스트·로그에 두지 않는다.
2. ‘분석 실행’, ‘재분석’ 버튼을 눌렀을 때만 분석한다. 앱 시작·저장·백그라운드 스케줄로 자동 실행하지 않는다. 재분석은 사용자 편집을 덮어쓰지 않는다.
3. 일정 후보를 확인·수정하고 ‘승인하고 캘린더 등록’을 눌렀을 때만 등록한다. 후보가 바뀌면 다시 승인받는다. Google OAuth로 개인 캘린더에 연결한다.
4. 실행 중·완료·실패를 표시하고, 중복 클릭으로 반복 실행하지 않으며, 실패는 ‘재시도’ 버튼으로만 다시 실행한다.

설계서 v2.2는 ‘자동 분석’ 설정, 자동 재시도 상태(`retry_wait`, `auth_required`), 상시 캘린더 워커를 전제했다.

## 결정

### 분석

- 작업은 `analysis_request`(분석 실행 `initial` / 재분석 `rerun`)와 `analysis_retry`(재시도)로만 생긴다. 둘 다 사용자 JWT로 호출하며 화면에서 확인 단계를 거친다.
- 회의록당 대기·실행 중 작업은 하나다(부분 unique 인덱스). 중복 클릭은 진행 중 작업을 돌려준다. 같은 operation_id 재전송은 저장된 응답을 돌려준다.
- 상태는 `queued → running → completed | failed`뿐이다. 실패·리스 만료·원문 변경은 `failed` + `error_code`로 남고 자동으로 다시 대기하지 않는다.
- PC 앱은 사용자가 ‘이 PC에서 분석 실행’을 켰을 때만 30초마다 대기 작업을 확인한다(`AnalysisAgentLoop`). 앱 시작 직후에는 실행하지 않는다. 이 PC에서 버튼을 누르면 그 작업을 바로 처리한다. 모바일에서 누른 요청도 이미 사용자가 누른 실행이므로 PC가 처리한다. PC 앱은 새 작업을 만들지 않는다.
- 재분석 결과는 새 `analysis_results`로만 저장한다. `meeting_notes`는 첫 결과에서만 만들고, 이후에는 ‘새 결과 적용’(필드 선택 + base_version 검사)으로만 바뀐다.

### 캘린더

- 후보 상태는 `needs_review → approved → registering → registered | failed`, 그리고 `rejected`다. 원문이 바뀐 후보(stale)는 계산 값이다.
- 승인은 화면에 보인 `version`과 `payload_hash`가 현재 후보와 같을 때만 받는다. 승인은 `content_version`과 payload snapshot을 고정한다. 후보를 수정·거절하면 승인을 무효화하고 대기 작업을 취소한다.
- 등록은 ‘승인하고 캘린더 등록’ 요청을 받은 Edge Function `calendar-register`가 그 자리에서 처리한다. 실패하면 `calendar-retry`(재시도 버튼)로만 다시 처리한다. cron·상시 워커를 두지 않는다. 그래서 로드맵의 “calendar-worker 실행 환경” 결정은 이 방식으로 정했다.
- 한 요청 안의 자동 동작은 두 가지뿐이다. Google 응답이 없거나 409·5xx일 때 같은 event ID로 조회해 복구하는 것과, 없으면 같은 ID로 한 번 더 넣는 것이다. 둘 다 중복 등록을 막기 위한 동작이며 새 실행이 아니다.
- 참석자 초대·알림은 보내지 않는다(`attendees` 없음, `sendUpdates=none`).

### Google OAuth

- `google-oauth-start`가 일회용 state(해시만 저장)와 PKCE verifier를 만들고 동의 화면 주소를 준다. `google-oauth-callback`은 JWT 없이 state로 사용자를 찾고, 코드를 교환한 뒤 refresh token을 AES-GCM으로 암호화해 `app_private.oauth_connections`에 저장한다. 클라이언트는 `google_connection_status()`로 상태만 본다.
- 기본 scope는 `calendar.events.owned`다. 공유 캘린더가 필요하면 `GOOGLE_OAUTH_SCOPES`로 바꾼다(로드맵 미확정 항목).
- Google API 키는 사용하지 않는다. API 키로는 사용자 캘린더에 쓸 수 없고 OAuth 토큰이 필요하다.

### 비밀값

- 클라이언트 번들에는 Supabase URL·anon 키만 들어간다. Google client secret·토큰 암호화 키·service-role 키는 Edge Function 환경(로컬 `supabase/functions/.env`, 운영 `supabase secrets`)에만 둔다.
- 빌드 결과물에서 비밀값 문자열을 검색해 없음을 확인한다(R03).

### 구조 변경

- `server/calendar-worker`를 없애고 등록 로직을 `supabase/functions/_shared/`(google.ts, handlers.ts, crypto.ts, postgrest.ts)로 옮겼다. `supabase functions serve`는 `supabase/functions` 밖의 파일을 올리지 않아 Edge Function이 import할 수 없기 때문이다. 공유 모듈은 Web 표준 API만 써서 vitest로도 테스트한다.

## 결과

- 마이그레이션: `supabase/migrations/20261018090000_analysis_calendar.sql`
- 테스트: `supabase/tests/analysis_calendar.test.sql`(pgTAP), `supabase/functions/_shared/*.test.ts`, `packages/client-core/src/{actions,agent}.test.ts`, `tests/integration/local-flow.test.ts`, Rust `agent::*`
- 남은 위험: 실제 Google 계정 E2E는 OAuth 클라이언트가 생긴 뒤 확인해야 한다. 데스크톱 로그인 토큰은 아직 webview localStorage에 있다(Credential Manager 이전은 Phase 2).
