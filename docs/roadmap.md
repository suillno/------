# 로드맵과 미확정 결정

설계서 [15장](design.md#15-로드맵과-완료-기준)과 [18장](design.md#18-claude-code-개발-지시문)을 작은 수직 기능 단위로 나눈 작업 목록이다. 완료하면 체크하고 날짜와 검증 결과를 적는다.

## 목표 (2026-10-18 확정)

휴대폰(안드로이드 앱)에서 회의 내용을 등록하고 **분석 요청**을 누르면, PC 앱이 사용자의 Claude Code 구독 CLI로 분석한다. 분석이 끝나면 휴대폰 **일정 확인**에서 사용자가 승인한 일정만 Google 캘린더에 등록한다. 요약·결정사항 편집은 PC 앱에서 한다.

- 분석·재분석·캘린더 등록은 버튼으로만 실행한다. 자동 분석·자동 재시도·자동 캘린더 등록은 하지 않는다.
- Gmail 알림은 범위에서 제외한다.
- 서버는 Supabase 클라우드다. PC는 앱 실행과 분석만 담당한다.
- 현재: 클라우드 배포, PC 설치본(바탕화면 ‘회의 어시스턴트’), 안드로이드 디버그 APK까지 사용자 동작 확인 완료.

## 결정 완료

| 항목 | 결정 | 근거 |
|---|---|---|
| Windows 에이전트 경로 | Rust | [ADR 0001](adr/0001-windows-agent.md) |
| 저장소 구조 | npm workspaces 모노레포, 설계서 20.2 구조 | 2026-10-17 초기화 |
| 사용 범위 | 개인 사용 MVP, 사용자별 독립 자료 | 설계서 머리말 |
| CLI 호출 구성 | `-p --output-format json --json-schema --tools "" --restricted --safe-mode --strict-mcp-config --permission-prompts none --no-session-persistence` | [ADR 0002](adr/0002-claude-cli-invocation.md) |
| 쓰기 경로 | 테이블 직접 쓰기 회수, `SECURITY DEFINER` RPC만 허용. 내부 테이블은 `app_private` 스키마 | [api.md](api.md) |
| 실행 방식 | 분석·재분석·캘린더 등록은 버튼으로만. 자동 분석·자동 재시도 없음, 실패는 ‘재시도’ 버튼 | [ADR 0003](adr/0003-manual-execution.md) |
| 캘린더 등록 실행 환경 | 승인·재시도 요청을 처리하는 Edge Function(`calendar-register`, `calendar-retry`)이 즉시 처리. cron·상시 워커 없음 | [ADR 0003](adr/0003-manual-execution.md) |

## 미확정 결정 (구현 전에 확인 필요)

- [ ] Supabase 프로젝트: 개발/운영 프로젝트 분리, 요금제 (지역은 ap-southeast-2로 결정, 2026-10-18)
- [ ] 모바일 웹 호스팅 도메인 (OAuth redirect URI와 CSP에 필요)
- [ ] Google Cloud 프로젝트, 최소 scope(`calendar.events.owned`인지 `calendar.events`인지), 테스트 모드 사용자. 코드 기본값은 `calendar.events.owned`, `GOOGLE_OAUTH_SCOPES`로 바꿀 수 있다
- [ ] 모바일에서 누른 분석 요청을 PC 앱이 켜질 때 처리하는 것을 허용할지 (현재: ‘이 PC에서 분석 실행’을 켠 PC만 30초마다 처리. 앱 시작 직후에는 처리하지 않음)
- [ ] 모바일 토큰 저장 방식 (Supabase JS 기본 localStorage인지 서버 중계 HttpOnly 쿠키인지)
- [ ] Claude Code 구독의 비대화형 자동 실행 허용 범위(약관·플랜). 플래그 동작은 검증 완료([ADR 0002](adr/0002-claude-cli-invocation.md)), 약관 확인은 사람이 해야 한다
- [ ] change feed·tombstone 보존 기간과 `prune_change_feed` 실행 스케줄 (pg_cron 또는 운영 스케줄러)
- [ ] 설치 파일 서명 인증서, 업데이트 배포 경로
- [ ] 데이터 보존 기간(tombstone 90일 제안), 백업·복구 목표, 분석 전송 동의 문구
- [ ] 상태 전이표 확정: `packages/contracts/src/status.ts`의 할 일·분석 작업 전이 중 설계서에 명시되지 않은 부분은 초안이다 (예: done → in_progress 재개, cancelled → todo 복원)

## 작업 목록

### 2026-10-18 요구사항 변경: 버튼으로 수동 실행

- API 키 실제 값은 저장소에 기록하지 않는다. Git 제외 로컬 설정 또는 서버 비밀 저장소로 관리하며, 예제에는 빈 값만 둔다.
- [x] 회의록 화면에 `분석 실행`, `재분석` 버튼을 추가한다. 사용자가 눌렀을 때만 분석 작업을 생성·실행한다. 회의록 저장·앱 시작으로 분석하지 않는다. (2026-10-18: `analysis_request`·`AnalysisPanel`, pgTAP “저장만으로 작업 없음”, client-core “start만으로 실행 안 함”)
- [x] 분석 결과는 요약·결정사항·일정 후보로 표시한다. 기존 사용자 편집을 바꾸는 적용은 별도 명시적 선택과 버전 검사를 거친다. (2026-10-18: `meeting_notes_apply_result`, pgTAP E02. **할 일(action_items) 표시·생성은 미구현**, Phase 2 항목)
- [x] 일정 후보 확인·편집 후 `승인하고 캘린더 등록` 버튼으로 등록한다. 후보 수정 후에는 이전 승인을 재사용하지 않는다. (2026-10-18: `candidate_approve`·`calendar-register`, pgTAP C01·C02·C06, 가짜 Google 테스트 C03·C05·C07. **실제 Google 계정 등록은 미검증**)
- [x] 각 실행 버튼에 실행 중·완료·실패 표시와 중복 클릭 방지를 추가한다. 실패 후 재시도도 사용자가 버튼으로 요청한다. (2026-10-18: `analysisView`·`candidateView`·`SingleFlight`, 서버 진행 중 작업 반환, 통합 테스트 동시 클릭 1건)
- 버튼이 CLI를 실행하는 방식이므로 CLI 도구 제한·입출력 검증은 유지한다. 버튼 실행에 대한 구독 이용 조건 확인도 별도로 필요하다.
- 이 항목은 기존 설계의 자동 분석·자동 신규 등록 트리거보다 우선한다. 일반 데이터 동기화는 기존 설계를 따른다.

### 2026-10-19 기능 추가 ([plans/2026-10-19-meeting-features.md](plans/2026-10-19-meeting-features.md))
- [ ] 1. 회의록 영구 삭제 (확인창, 등록된 일정 유지 안내)
- [ ] 2. 분석 추가 요청사항 (원문과 분리 전달, 작업 이력 보관, 재분석 시 불러오기)
- [ ] 3. 목적지·네이버 지도 링크 (원문에 있을 때만, 불명확하면 승인 전 확인)
- [ ] 4. 캘린더 일정에서 원본 회의록 열기 (https 중계 + 앱 딥링크)
- [ ] 5. Joplin 공유로 새 회의 작성 (안드로이드, Markdown 편집/미리보기)
- [ ] 6. 요약·결정사항 탭 AI 요약 목록 (PC·휴대폰)
- [ ] 클라우드 적용·설치본·APK 재빌드

### Phase 0. 기술 검증
- [x] 저장소 초기화, 템플릿 빌드 확인 (2026-10-17: typecheck, TS 테스트 8건, Rust 테스트 4건, 웹 빌드, 릴리스 exe 빌드·실행 확인)
- [x] `claude -p` 구독 로그인 상태에서 stdin 입력과 `--output-format json` 실행, 결과 envelope 형식 기록 (2026-10-17: Claude Code 2.1.291, Pro. ADR 0002)
- [x] 도구 차단 구성 실제 버전 검증 (2026-10-17: `--tools ""`에서 도구 0개, 본문 주입 시험에서 파일 생성 없음. 도구 허용 대조군은 미실행 — ADR 0002 "미검증" 참고)
- [x] Google OAuth 개발 클라이언트로 테스트 캘린더에 `events.insert` 수동 검증 (2026-10-18, 로컬·클라우드에서 사용자 확인)
- [x] Docker Desktop 첫 실행 → `npm run db:start` 성공 확인 (2026-10-17)

### Phase 1. 데이터 기반
- [x] `meetings` + `meeting_revisions` + `change_feed` + 사용자별 seq 카운터 + `operation_receipts` 마이그레이션 (2026-10-17, `20261017090000_sync_foundation.sql`)
- [x] RLS: 읽기 정책, 직접 쓰기 회수, 버전 검사 쓰기 RPC (create / patch / delete) (2026-10-17, 로컬 PostgREST에서 HTTP 401/403/404/409 매핑 수동 확인)
- [x] pgTAP 테스트: 교차 사용자 차단(R01), 직접 조작 차단(R02), 동시 수정 409(S03), 멱등 재시도(S06), seq 커밋 순서(S09), 커서 만료(S08 일부) (2026-10-17: `npm run db:test` 43건 통과)
- [x] `GET /v1/sync/changes`, `/v1/sync/snapshot` — RPC `sync_changes`, `sync_snapshot` (2026-10-17). 논리 경로 Edge Function 어댑터는 필요해지면 추가
- [ ] audit_events, devices 테이블 (Phase 3 claim 전에 devices 필요)

### Phase 2. 클라이언트
- [x] Supabase Auth 이메일 로그인 (웹·데스크톱 공통, 세션은 supabase-js 기본 localStorage) (2026-10-18)
- [ ] 데스크톱 PKCE + Credential Manager 토큰 보관
- [x] 회의록 목록·작성·조회 (온라인) (2026-10-18)
- [ ] 회의록 수정·삭제 화면, 검색
- [ ] SQLite 캐시·outbox (Rust) / IndexedDB outbox (웹), 동기화 엔진, "지금 동기화"
- [ ] 충돌 UI (base / 내 편집 / 서버 최신)
- [x] meeting_notes 편집·새 결과 적용 (2026-10-18)
- [ ] 독립 action_items (분석 결과의 할 일 생성 포함)
- [ ] 오프라인 검색 범위 표시

### Phase 3. AI 분석
- [x] analysis_jobs 큐, request / retry / claim / heartbeat / result / failure RPC (2026-10-18, pgTAP A01·A02·A03·A04)
- [x] Rust 에이전트: CLI stdin 실행, timeout, JSON 검증, 업로드 전 로컬 저장·업로드 재시도 (2026-10-18, Rust 테스트 + 실제 CLI 1회)
- [x] stale 처리, 재분석 편집 보호 (2026-10-18)
- [ ] 실제 데스크톱 앱(`npm run dev:desktop`)에서 버튼→분석→업로드 수동 확인

### Phase 4. Calendar
- [x] OAuth 연결 Edge Function, 토큰 서버 보관(AES-GCM 암호화) (2026-10-18, 가짜 Google 테스트·위조 state 통합 테스트)
- [x] 후보 편집·승인 snapshot, 결정적 event ID 멱등 등록 (2026-10-18)
- [ ] 운영 배포: Edge Function 배포, `supabase secrets set`, Google 콘솔 리디렉션 URI 등록

### 모바일(안드로이드) 앱 — 계획 단계 ([docs/plans/mobile-android.md](plans/mobile-android.md))
- [x] 확정 (2026-10-18): 캘린더는 사용자 승인 후 등록(자동 등록 없음), Tauri 2 Android, Google 연결 완료는 웹 호스팅 없이 안내 페이지, Gmail 알림 제외
- [x] Supabase 클라우드 가입 (2026-10-18)
- [x] Supabase 프로젝트 생성 후 정보 등록 위치 확인·등록 (계획 문서 6.2) (2026-10-18: 지역 ap-southeast-2 시드니로 확정, `.env.local` 입력칸 등록·형식 확인, `supabase link` 완료)
- [x] 클라우드 Supabase 배포 (휴대폰↔PC 중계, 선행 조건) (2026-10-18)
  - [x] 마이그레이션 2개 적용 `supabase db push` (2026-10-18, 비로그인 호출 401 확인)
  - [x] 서버 비밀 6개 등록(`supabase secrets set`, 운영용 새 암호화 키, 임시 파일은 등록 후 삭제), Edge Function 5개 배포(`--use-api`) (2026-10-18: 위조 state 302, 비로그인 401, CORS 확인). `APP_WEB_ORIGIN`은 이후 삭제(안내 문구 응답)
  - [x] Google 콘솔에 클라우드 콜백 주소 추가 (2026-10-18)
  - [x] 데스크톱 앱을 클라우드 주소로 전환 (2026-10-18: `.env.local`, 실행기 클라우드 모드)
  - [x] 클라우드에서 가입·로그인·Google 연결·분석·등록 수동 확인 (2026-10-18, 사용자 확인)
- [x] `google-oauth-callback` 안내 문구 응답으로 변경 (2026-10-18: `APP_WEB_ORIGIN` 없으면 text/plain 안내, vitest 3건, 클라우드 배포 후 응답 확인)
- [x] 휴대폰 화면: 로그인, 회의 등록, 등록 내역, 내역 상세(분석 요청·재시도), 일정 확인(수정·확인·거절·재시도) (2026-10-18: `features/mobile`, `apps/mobile`, API `listLatestJobs`·`listPendingCandidates`, `jobBadge` 테스트 3건. PC 브라우저 미리보기)
- [ ] 휴대폰 화면 사용자 확인 (미리보기)
- [x] Android Studio·SDK·NDK 준비, 사용자 환경변수, Rust Android 타깃 (2026-10-18)
- [x] Tauri 2 Android 초기화(`apps/mobile/src-tauri`), 디버그 APK 빌드 `npm run build:android` (2026-10-18: 한글 경로 우회 2가지, 화면 번들 비밀값 검사 통과)
- [x] 휴대폰에 APK 설치·동작 확인 (2026-10-18, 사용자 확인)
- [ ] 배포용 서명 키(저장소 밖)로 release APK 빌드, 로그인 세션 Android Keystore 보관
- [ ] 통합 확인 MB01~MB09

### Phase 5. 배포
- [x] PC 앱 설치본(release exe) + 바탕화면·시작 메뉴 바로가기 `npm run install:desktop` (2026-10-18). 서명 설치 프로그램은 아래 항목
- [ ] NSIS 서명 설치, 트레이, 로그인 시 자동 시작, 업데이트, 진단 내보내기
