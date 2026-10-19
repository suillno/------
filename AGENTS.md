# 개발 규칙

AI 회의록·캘린더 연동 앱. 설계 기준은 [docs/design.md](docs/design.md)(v2.3)이며, 이 파일은 작업 시 항상 지켜야 할 규칙과 명령만 담는다.

## 구성 (확정)

- npm workspaces 모노레포. React 19 + TypeScript + Vite 8
- Windows: Tauri 2 + **Rust 에이전트** ([ADR 0001](docs/adr/0001-windows-agent.md)). Python 경로는 사용하지 않는다.
- 클라우드: Supabase Auth/PostgreSQL/RLS, Edge Function. 캘린더 등록·Google OAuth는 `supabase/functions` (공유 로직 `_shared/`, [ADR 0003](docs/adr/0003-manual-execution.md))
- 폴더별 책임: [docs/file-map.md](docs/file-map.md). 구조를 바꾸면 file-map·ADR·`.env.example`을 함께 갱신한다.

## 명령

| 목적 | 명령 |
|---|---|
| PC 앱 실행 | 바탕화면·시작 메뉴 ‘회의 어시스턴트’ 또는 `npm run start:app` (설치본, 클라우드 연결) |
| PC 앱 설치본 갱신 | `npm run install:desktop` — release exe 빌드 → `%LOCALAPPDATA%\Programs\MeetingAssistant` 복사 → 바로가기 |
| 개발용 한 번에 실행 | `start-meeting-assistant.cmd` — 로컬 주소면 Docker → Supabase → Edge Function → 데스크톱 개발 앱, 클라우드 주소면 개발 앱만 (`scripts/start-local.ps1`) |
| 웹 개발 서버 | `npm run dev:web` (5173) |
| 데스크톱 개발 | `npm run dev:desktop` (Vite 1420 + Tauri) |
| 휴대폰 화면 개발 | `npm run dev:mobile` (Vite 1430, PC 브라우저에서 미리보기) |
| 안드로이드 APK 빌드 | `npm run build:android` (디버그 서명, arm64) → `apps/mobile/meeting-assistant.apk`. 사용자 환경변수 `ANDROID_HOME`·`NDK_HOME`·`JAVA_HOME` 필요 |
| 타입 검사 | `npm run typecheck` |
| TS 단위 테스트 | `npm test` |
| 타입 검사 + TS 테스트 | `npm run check` |
| 전체 검증 (+ Rust) | `npm run verify` |
| Rust 테스트 | `npm run test:rust` |
| 데스크톱 exe 빌드 | `npm run build:desktop` (NSIS 설치 파일) |
| 로컬 Supabase | `npm run db:start` / `db:reset` / `db:test` (Docker Desktop 필요) |
| 로컬 Edge Function | `npm run functions:serve` (`supabase/functions/.env` 필요, Git 제외) |
| 계약 생성 파일 갱신 | `npm run gen:contracts` (분석 schema를 바꾼 뒤) |
| 로컬 통합 테스트 | `npm run test:integration` (db·functions 실행 중) |

변경 후에는 `npm run typecheck && npm test`를 실행하고, Rust를 바꿨다면 `npm run test:rust`도 실행한다. 보고할 때는 테스트 작성과 실행·통과를 구분한다.

## 절대 규칙

- Google Calendar API 키를 포함한 모든 비밀값(API 키, OAuth client secret, service-role 키, 토큰 암호화 키, 토큰)은 Git에 올리지 않는다. 실제 값은 소스·문서·테스트·예제·로그·커밋 메시지에 기록하지 않고, Git에서 제외한 로컬 환경변수(`.env.local`, `supabase/functions/.env`) 또는 서버 비밀 저장소(`supabase secrets`)로 관리한다. `.env.example`에는 변수 이름과 빈 값만 둔다. 대화·이슈에 키가 노출되면 저장하지 말고 폐기·재발급을 안내한다.
- AI 분석·재분석·캘린더 등록은 사용자가 해당 실행 버튼(‘분석 실행’, ‘재분석’, ‘승인하고 캘린더 등록’)을 눌렀을 때만 시작한다. 앱 시작·회의록 저장·동기화·백그라운드 스케줄로 새 실행을 자동 시작하지 않는다. 실행 전 대상과 내용을 확인하고, 실행 중·완료·실패 상태와 실패 사유를 표시한다. 캘린더 후보 변경 후에는 다시 승인받는다.
- 같은 작업이 중복 클릭으로 반복되지 않게 한다. 화면은 진행 중 버튼을 막고(`SingleFlight`), 서버는 operation_id 영수증과 진행 중 작업 반환으로 막는다.
- 실패한 분석·등록은 자동으로 다시 실행하지 않는다. 사용자가 ‘재시도’를 눌렀을 때만 다시 대기시킨다(한 요청 안의 같은 operation_id 재전송과 Google 응답 유실 확인 조회는 예외).
- 경로는 중앙 resolver(`apps/desktop/src-tauri/src/paths.rs`)로만 만든다. 개인 PC 절대경로, 비밀값, 실행 데이터를 소스에 넣지 않는다.
- UI(`packages/ui`)는 DB·CLI·파일을 직접 다루지 않고 `Platform` 어댑터나 API를 통해서만 접근한다. Tauri IPC에 임의 경로·SQL·프로세스 명령을 노출하지 않는다.
- 계약 schema는 `packages/contracts`가 단일 원본이다. 생성 파일은 직접 수정하지 않는다.
- 재분석으로 사용자 요약·결정사항·할 일 완료 상태를 덮어쓰지 않는다. 새 결과를 적용하려면 사용자의 명시적 선택과 버전 검사가 필요하다.
- 미전송 로컬 편집을 서버 캐시로 덮어쓰지 않는다.
- `updated_at`만으로 충돌을 해결하지 않는다. 일반 sequence를 커밋 순서로 가정하지 않는다.
- `source_revision_id`가 없는 분석 결과를 최신 결과로 사용하지 않는다.
- 사용자 승인 없이 Google 이벤트를 등록·수정하거나 초대를 보내지 않는다. 후보가 바뀐 뒤 이전 승인을 재사용하지 않는다.
- service-role, Google secret, 구독 토큰을 클라이언트 번들·SQLite·로그에 넣지 않는다.
- 회의록을 shell 문자열에 넣지 않는다(인자 배열 + stdin). 권한 우회 옵션을 쓰지 않는다.
- 구독 CLI에 `--bare`를 쓰지 않는다. 한도를 초과해도 유료 API로 자동 전환하지 않는다.
- 회의 원문과 AI 출력은 신뢰할 수 없는 데이터로 다룬다.
- 마이그레이션은 이미 적용한 파일을 수정하지 않고 새 파일을 추가한다.
