# 파일 책임 맵

구조를 바꾸면 이 문서를 함께 갱신한다. 설계 근거: [design.md 20장](design.md#20-유지보수를-위한-파일경로-설계).
상태 표시: ✅ 동작하는 코드 · 🧩 템플릿/자리만 · ⬜ 빈 폴더

| 경로 | 책임 | 상태 |
|---|---|---|
| `apps/web/src/app/` | 모바일 PWA 진입점 | ✅ |
| `apps/web/src/platform/` | 웹 Platform 어댑터: Supabase API, 허용 주소 이동 (IndexedDB·서비스 워커는 Phase 2) | ✅ |
| `apps/web/public/` | 공개 정적 파일 (manifest) | 🧩 |
| `apps/mobile/` | 안드로이드 휴대폰 앱 화면 진입점·Platform 어댑터 (Vite 1430) | ✅ |
| `apps/mobile/src-tauri/` | 휴대폰 앱 Tauri 셸. IPC 명령 없음, opener만 허용. 분석 실행기·CLI 기능 없음 | ✅ |
| `apps/mobile/src-tauri/gen/android/` | `tauri android init` 생성 Gradle 프로젝트(아이콘 포함). 빌드 산출물은 자체 .gitignore로 제외 | 생성 |
| `apps/desktop/src/app/` | Windows 화면 진입점 | ✅ |
| `apps/desktop/src/platform/` | Tauri IPC 클라이언트: 분석 실행기, 허용 주소 열기 | ✅ |
| `apps/desktop/src-tauri/tauri.conf.json` | 창·CSP·번들 설정 | ✅ |
| `apps/desktop/src-tauri/capabilities/` | 최소 IPC 권한 (`core:default` + Google 동의·캘린더 URL만 Chrome/기본 브라우저로 여는 opener) | ✅ |
| `apps/desktop/src-tauri/src/commands/` | 허용된 IPC 명령: `app_status`, `run_analysis`, `pending_analysis_uploads`, `clear_analysis_upload` | ✅ |
| `apps/desktop/src-tauri/src/paths.rs` | 중앙 경로 resolver (UUID 검증, root 이탈 차단) | ✅ 테스트 4건 |
| `apps/desktop/src-tauri/src/agent/` | CLI 탐색·stdin 실행·envelope/출력 검증·업로드 전 로컬 저장. 호출 구성은 [ADR 0002](adr/0002-claude-cli-invocation.md) | ✅ 테스트 18건 + 실제 CLI 수동 1건 |
| `apps/desktop/src-tauri/generated/` | `npm run gen:contracts` 생성 파일(CLI용 분석 schema). 직접 수정 금지 | ✅ |
| `packages/ui/src/` | 공통 화면 셸·로그인·`Platform` 인터페이스·공통 조각 | ✅ |
| `packages/ui/src/features/meetings/` | 회의록 목록·작성·상세, 분석 패널(분석 실행·재분석·재시도, 편집본·새 결과 적용) | ✅ |
| `packages/ui/src/features/calendar/` | 일정 후보 확인·수정·승인하고 캘린더 등록·재시도 | ✅ |
| `packages/ui/src/features/settings/` | Google 연결·해제, 이 PC 분석 허용 | ✅ |
| `packages/ui/src/features/mobile/` | 휴대폰 화면: 등록 내역(분석 상태 배지), 회의 등록, 내역 상세(분석 요청·재시도), 일정 확인 | ✅ |
| `packages/ui/src/features/notes/` | 요약·결정사항 탭: AI 요약 목록(자동 반영)과 상세(AI 원본·편집본 구분) | ✅ |
| `packages/ui/src/features/tasks` | 독립 화면 | 🧩 |
| `packages/ui/src/rich/` | 서식 편집기(Tiptap)·읽기 화면(RichView·PlainText)·저장 형식 변환·팔레트 표시·충돌 비교 | ✅ |
| `packages/ui/src/unsaved.ts` | 저장 안 한 편집 보호(탭·화면 이동·뒤로가기·창 닫기 확인) | ✅ |
| `apps/mobile/src-tauri/gen/android/app/src/main/java/…/MainActivity.kt` | 공유 수신(텍스트·Markdown)을 보관하고 WebView 브리지 `MeetingAssistantShare.take()`로 넘김. 매니페스트에 SEND intent-filter | ✅ |
| `packages/contracts/src/` | 오류 코드, 상태 전이, 분석 결과 schema v1·v2(목적지), RPC 응답 타입·실패 사유 문구 | ✅ |
| `packages/client-core/src/` | Supabase API 구현, 버튼 규칙·중복 클릭 방지(`SingleFlight`), PC 분석 실행 순서, 시간대 변환, 실패 분류·백오프 | ✅ |
| `supabase/config.toml` | 로컬 Supabase 설정 (OAuth 콜백만 JWT 검사 해제) | ✅ |
| `supabase/migrations/` | PostgreSQL DDL·RLS·RPC. 내부 테이블·함수는 API에 노출되지 않는 `app_private` 스키마 | ✅ 동기화 기반, 분석·편집본·후보·승인·등록·OAuth |
| `supabase/functions/<이름>/index.ts` | Edge Function 진입점 (환경변수만 읽고 `_shared`로 넘김) | ✅ 8개 (`open-meeting`은 원본 회의록 링크 중계·JWT 검사 없음, `meeting-save`·`notes-save`는 서식 판정 저장) |
| `supabase/functions/_shared/` | OAuth·캘린더 등록 처리, Google 호출, 토큰 암호화. Web 표준 API만 사용. `richtext.ts`는 서버·PC 공통 서식 규칙(AI 입력 텍스트·보이는 글자 수·분석 기준·팔레트, PC는 `client-core/src/richtext.ts`로 재사용), `richHandlers.ts`는 meeting-save·notes-save | ✅ 테스트 73건 |
| `supabase/functions/<이름>/deno.json` | Markdown 라이브러리를 쓰는 함수(meeting-save·notes-save)의 버전 고정. `package.json`과 같아야 한다(테스트로 검사) | ✅ |
| `supabase/functions/.env` | 로컬 Edge Function 비밀 (Git 제외) | 로컬 전용 |
| `supabase/tests/` | RLS·트랜잭션 통합 테스트 (pgTAP). `sync_commit_order`는 dblink를 쓰는 로컬 전용 | ✅ 199건 |
| `storage/sqlite/migrations/` | PC 캐시 전용 마이그레이션 | ⬜ |
| `prompts/meeting-analysis/v2/` | 분석 지시문 v2(요청사항·목적지). Rust가 컴파일 시 포함. v1은 이력 보관 | ✅ |
| `tests/integration/` | 로컬 Supabase + Edge Function 통합 테스트 (`npm run test:integration`) | ✅ 6건 |
| `tests/e2e`, `tests/fixtures` | E2E·고정 자료 | ⬜ |
| `scripts/` | 계약 생성(`gen-contracts.ts`), 통합 테스트 실행기, 실행기(`start-local.ps1`, 로컬/클라우드 모드 자동 판별), 설치본 갱신(`install-desktop.ps1`), 설치본 실행(`start-app.mjs`), APK 빌드(`build-android.mjs`). `.ps1`은 UTF-8 BOM 유지 | ✅ |
| `start-meeting-assistant.cmd` | 개발용 실행 진입점 (더블클릭). 일상 실행은 설치본 바로가기 | ✅ |
| `.env.local` | 클라이언트 공개 설정 (Git 제외) | 로컬 전용 |

v2.3에서 `server/calendar-worker`를 없애고 `supabase/functions/_shared`로 옮겼다 ([ADR 0003](adr/0003-manual-execution.md)).

## 수정 위치 안내

[design.md 20.3](design.md#203-수정할-기능에-따른-파일-위치) 표를 따른다. 이 저장소에서는 "선택한 Windows agent"가 `apps/desktop/src-tauri/src/agent/`를 뜻한다.
