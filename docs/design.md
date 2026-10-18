# AI 회의록·캘린더 연동 개발설계서 v2.3

- 작성일: 2026-10-17 (Asia/Seoul)
- 상태: 구현 기준 제안서 / 개인 사용 MVP 우선
- 목표: Windows exe와 모바일 웹에서 회의록을 조회·수정하고, 클라우드로 동기화하며, Windows PC의 Claude Code CLI로 분석한 일정 후보를 사용자 승인 후 Google Calendar에 등록한다.
- 확인 범위: [공유 대화](https://chatgpt.com/share/6ad2581f-c81c-83ee-baa4-c91a3ee7f14a)에서 기존 FastAPI + SQLite + Claude Code 구성, 이전 회의 검색, 담당자별 할 일, 승인 후 Google Calendar 등록을 확인했다. 첨부된 기존 설계서 자체는 다운로드 오류로 읽지 못했으며 실제 구현 존재 여부도 확인하지 않았다. 16장은 대화에서 확인한 내용과 추가 제안을 구분한다.
- v2.1 개정: FastAPI 재사용 경로, 회의 검색, 분석 결과 편집·재분석 보호, 독립 할 일 모델/API, 클라우드 역할 및 변경점·테스트를 보완했다. 파일명은 기존 다운로드 경로를 유지하기 위해 v2로 유지한다.
- v2.2 개정: 20장에 저장소 폴더 구조, 파일별 책임, Windows 실행 데이터 경로, 환경별 설정, 경로 변경·복구 규칙을 추가했다.
- v2.3 개정 (2026-10-18): 분석·재분석·캘린더 등록을 사용자 버튼으로만 실행하도록 바꾸고 자동 분석·자동 재시도를 없앴다. 실행 상태 표시·중복 클릭 방지·'재시도' 버튼, 비밀값 관리 규칙, 캘린더 등록을 요청 시 처리하는 Edge Function으로 정리했다. 근거: [ADR 0003](adr/0003-manual-execution.md).

## 1. 핵심 설계 결정

1. Supabase PostgreSQL을 **서버에서 승인된 공유 데이터의 기준**으로 둔다. SQLite는 PC 캐시·미전송 편집·작업 복구 저장소다.
2. PC가 꺼져도 모바일은 클라우드에 직접 저장하고 조회·수정한다. PC가 켜진 뒤 앱/사용자 에이전트가 실행되어야 변경분을 가져온다.
3. AI 분석은 Windows 사용자 세션에서 실행되는 Claude Code CLI가 담당한다. 실행 파일이 모델을 내장하거나 오프라인 추론하는 구조가 아니다.
4. 자동 동기화와 ‘지금 동기화’는 같은 엔진을 사용한다. AI 분석·재분석·캘린더 등록은 자동으로 시작하지 않으며 사용자가 각 버튼(‘분석 실행’, ‘재분석’, ‘승인하고 캘린더 등록’, ‘재시도’)을 눌렀을 때만 시작한다. 앱 시작·회의록 저장·동기화·백그라운드 스케줄은 새 실행을 만들지 않는다.
5. AI는 일정 후보만 제안한다. Google 계정 연결 동의와 개별 일정 등록 승인은 별개다.
6. 캘린더 등록은 클라우드(사용자 승인 요청을 처리하는 Edge Function)가 담당한다. 따라서 PC가 꺼져도 이미 생성된 후보를 모바일에서 승인·등록할 수 있다.
7. 본문 동시 편집은 버전 검사로 충돌을 감지하고 사용자가 해결한다. 최근 시간이라는 이유만으로 본문을 덮어쓰지 않는다.
8. 모든 API 키·OAuth 비밀·토큰 암호화 키는 Git·소스·문서·테스트·로그에 넣지 않고 Git 제외 로컬 환경변수나 서버 비밀 저장소로만 관리한다. Google Calendar 등록은 사용자 OAuth 토큰으로 하며 Google API 키는 쓰지 않는다.

## 2. 기능 범위와 화면

| 영역 | MVP 동작 |
|---|---|
| 회의록 | 제목, 회의일시, 시간대, 본문 작성·조회·수정·소프트 삭제 |
| 이전 회의 검색 | 제목·본문 키워드, 회의일자 범위, 최신순 목록, 서버/캐시 검색 범위 표시 |
| 동기화 | 자동/수동, 미전송 건수, 마지막 성공 시각, 충돌·오류 표시 |
| 분석 | ‘분석 실행’·‘재분석’·‘재시도’ 버튼, 대기/실행 중/완료/실패 표시와 실패 사유, 중복 클릭 방지, 요약·결정사항 조회·수정, AI 원본과 사용자 수정본 비교·‘새 결과 적용’ |
| 할 일 | 담당자·기한·미착수/진행/완료/취소 관리, 회의별·담당자별 조회, PC/모바일 편집 |
| 일정 | 후보 확인·수정, 날짜 미확정 표시, ‘승인하고 캘린더 등록’(확인 단계 포함)·거절, 등록 중/완료/실패 표시, 실패 시 ‘재시도’, 등록 결과 링크 |
| 설정 | 이 PC에서 분석 실행 허용(사용자가 요청한 작업만 처리), 트레이/로그인 시 시작, Google 연결·해제 |
| 모바일 | 반응형 PWA, IndexedDB 임시 저장, 클라우드 저장 상태 표시 |

음성 전사, 사진 OCR, 조직 공동 편집, Google 일정 전체 양방향 동기화는 후속 범위다. 여기서 ‘양방향’은 회의록·분석 상태·일정 후보의 PC↔클라우드↔모바일 동기화를 뜻한다. Google에서 변경한 모든 일정을 회의록으로 역수입하지 않는다.

## 3. 아키텍처

### 이전 회의 검색 계약

온라인은 서버에 승인된 전체 회의록의 제목·본문을 검색하고, 오프라인은 기기에 캐시된 회의록과 미전송 편집만 검색한다. 검색 범위와 마지막 동기화 시각을 표시하며 로컬 결과에서는 서버 사본 대신 현재 로컬 편집본을 사용한다. 미전송 변경이 있는 온라인 화면은 서버 검색과 로컬 검색을 구분해 보여주고 오래된 서버 내용이 최신인 것처럼 표시하지 않는다.

MVP는 한국어 문자열 부분 일치와 회의일자 범위 필터를 기준으로 삼는다. 서버 쿼리는 매개변수화하고 검색 길이·페이지 크기를 제한한다. 사용자 소유권/RLS와 deleted_at 필터를 검색에도 적용한다. 날짜 필터는 선택한 IANA 시간대에서 시작일 포함·종료일 다음 날 미만 구간으로 변환하고, 결과는 meeting_at DESC, id DESC의 안정된 커서로 페이지 처리한다. DB에 필요한 복합 인덱스를 마련하고 부분 일치 인덱스는 실제 한국어 데이터와 규모로 검증한다. 사용자 수정 요약·결정사항 검색은 후속 확장으로 구분한다.

```mermaid
flowchart TB
  M[모바일 웹 / PWA / IndexedDB] <-->|HTTPS + 사용자 JWT| C[클라우드 API / Supabase Auth]
  P[Windows 앱 / React + Tauri] <-->|동기화 API| C
  P <--> L[(SQLite 캐시 / outbox)]
  P --> W[Windows 사용자 분석 에이전트]
  W --> CLI[설치된 Claude Code CLI]
  CLI --> A[Anthropic 모델 서비스]
  W -->|검증된 분석 결과 업로드| C
  C <--> D[(PostgreSQL / RLS / 변경 로그)]
  D --> Q[캘린더 작업 큐]
  Q --> G[클라우드 워커 / Google OAuth]
  G --> GC[Google Calendar]
```

### 권장 구성

공유 대화의 기존 구성은 FastAPI + SQLite + Claude Code다. 아래 Tauri + Rust는 exe 화면·패키징을 위한 신규 제안이며 기존 구현이 있다는 증거는 없다. Phase 0에서 저장소를 확인한 뒤 다음 기준으로 선택한다.

| 경로 | 선택 기준 | 구성 |
|---|---|---|
| 기존 코드 재사용 우선 | Python/FastAPI 분석·저장 코드가 실제 존재하고 재사용 가치가 있는 경우 | Tauri UI + 패키징된 Python 에이전트, 필요 시 loopback FastAPI |
| 신규 구현 기본안 | 재사용할 코드가 없거나 유지비가 더 큰 경우 | Tauri UI + Rust 에이전트/SQLite |

두 경로의 API·데이터·동기화 규칙은 같다. Python 경로에서는 분석 로직을 모듈로 분리하고 IPC를 우선 사용한다. 로컬 FastAPI가 필요하면 127.0.0.1에만 바인딩하고 임의 포트·세션별 토큰·Origin/Host 검증을 적용한다. 모바일 접속을 위해 로컬 서버를 외부에 공개하지 않는다. Python 에이전트는 PyInstaller 등으로 별도 실행 파일로 패키징하고 Tauri sidecar로 함께 배포한다. 브라우저에 표시되는 UI에 로컬 인증 토큰을 노출하지 않도록 IPC 중계를 사용한다. 구체적 패키징 도구와 호환 버전은 기술 검증에서 확정한다.

- 공통 UI: React + TypeScript. 모바일 웹은 HTTPS 정적 호스팅, PWA 서비스 워커는 정적 파일 캐시에 집중한다.
- Windows: Tauri 2 + Rust, SQLite. UI 렌더러가 SQL·프로세스를 임의 실행하지 못하도록 좁은 IPC 명령만 노출한다.
- 클라우드: Supabase Auth/PostgreSQL, 제한된 RPC 또는 Edge Function API, private Storage(첨부 도입 시).
- 캘린더: 서버 전용 OAuth 콜백과 지속 작업 워커. 실행시간 제한이 있는 함수만 사용할 경우 짧은 작업·리스·재시도로 분할한다.
- 클라우드 역할 확대: 공유 대화의 저장·전달 역할에 OAuth 비밀 보관과 승인 후 캘린더 등록을 추가한 제안이다. 이 구성에서는 PC가 꺼져도 기존 후보 등록이 가능하지만 서버 워커 배포·모니터링·토큰 관리가 필요하다. 등록을 PC로 옮기는 대안은 이 운영 부담을 줄일 수 있으나 PC 종료 중 등록도 대기하게 된다. 본 설계의 기본안은 클라우드 등록이다.
- 공통 패키지: JSON Schema, API 타입, 상태 전이, 날짜 검증. SQLite와 PostgreSQL SQL은 별도 마이그레이션으로 관리한다.

## 4. PC 꺼짐·오프라인 동작

| 상황 | 저장·조회·수정 | AI 분석 | 일정 등록 |
|---|---|---|---|
| PC 꺼짐, 모바일 온라인 | 클라우드에서 정상 동작 | 요청만 큐에 대기 | 기존 후보 승인 후 서버가 등록 |
| PC 켜짐, 앱/에이전트 종료 | 모바일 정상, PC 동기화 없음 | 대기 | 서버 작업 가능 |
| PC 온라인, 에이전트 실행 | 양방향 동기화 | 로그인·한도 정상일 때 가능 | 승인 후 서버 실행 |
| PC 오프라인 | 캐시 조회, SQLite에 편집 보존 | 원격 모델 통신 필요하여 대기 | 오프라인에서는 새 승인 불가 |
| 모바일 오프라인 | 이미 캐시된 자료만 조회·편집, IndexedDB 보존 | 요청은 로컬 대기 | 승인 버튼 비활성화 |
| 절전·최대 절전·로그아웃 | 모바일 클라우드 기능 유지 | PC 분석 중단/리스 만료 후 재처리 | 서버 작업 가능 |

모바일의 최초 접속·로그인은 온라인이 필요하다. 브라우저 저장소 삭제·용량 회수 시 미전송 자료가 사라질 수 있으므로 저장 상태와 내보내기를 제공한다. 모바일 브라우저의 종료 후 백그라운드 동기화는 보장하지 않는다. PC 전원 켜기만으로 분석을 보장하지 않으며 사용자 로그인, 자동 시작 설정, 인터넷, CLI 인증이 필요하다.

### 모바일 작성 후 PC가 가져오는 순서

1. 모바일이 사용자 JWT로 저장 API를 호출한다.
2. 서버가 RLS/소유권·버전을 검사하고 회의록, 불변 revision, 변경 로그를 같은 트랜잭션으로 저장한다.
3. PC 앱 시작 시 SQLite의 마지막 커서로 변경 목록을 요청한다.
4. 미전송 편집과 비교하여 캐시를 갱신하거나 충돌을 보존한다.
5. PC가 분석 작업을 원자적으로 claim하고 해당 revision의 스냅샷을 분석한다.
6. 결과 업로드 후 모바일은 알림 또는 재조회로 결과를 확인한다. PC가 모바일에 직접 접속할 필요는 없다.

## 5. 데이터 권위 및 편집 규칙

| 데이터 | 권위와 보존 규칙 |
|---|---|
| 서버 승인 회의록·후보·승인·작업 상태 | PostgreSQL이 기준 |
| 미전송 편집 | 해당 기기의 outbox가 유일본일 수 있음. 서버 캐시로 덮어쓰지 않음 |
| SQLite의 서버 사본 | 재생성 가능한 캐시. dirty 레코드는 예외 |
| AI 원시 출력 | 검증 전 임시 데이터. 검증된 결과도 사용자 원문을 수정하지 않음 |
| Google 실제 이벤트 | 등록 후 이벤트 존재·내용은 Google이 기준. 로컬 매핑은 추적용 |

클라우드 저장 성공 응답 전에는 ‘동기화 완료’를 표시하지 않는다. 로컬 저장 성공과 클라우드 저장 성공을 따로 표시한다. 계정 전환 시 기기 저장소를 사용자별로 분리하고 미전송 자료 처리 선택을 제공한다.

## 6. 자동·수동 양방향 동기화

동기화 대상에는 회의록 외에 사용자 편집 요약·결정사항, 독립 할 일, 일정 후보가 포함된다. 이들에도 동일한 outbox·version·충돌·tombstone 규칙을 적용한다.

### 로컬 구성

SQLite/IndexedDB에 `server_snapshot`, `local_draft`, `outbox`, `sync_state`, `conflicts`를 둔다. outbox는 `operation_id`, `entity_id`, `base_version`, `base_revision_id`, `patch`, `created_local_at`, `state`, `attempt_count`를 보존한다. 로컬 편집 저장과 outbox 생성은 같은 트랜잭션이다. 같은 엔터티의 편집은 전송 전에 합칠 수 있지만 이미 전송한 operation_id의 payload는 변경하지 않는다.

### 트리거와 순서

- 시작·포그라운드 복귀·네트워크 복구 시 동기화한다. 편집 후 1~3초 디바운스, 실행 중 60초 보정 폴링을 기본값으로 제안한다.
- Realtime은 ‘변경이 있을 수 있음’ 알림이다. 누락·순서 변경을 전제로 항상 변경 API로 복구한다.
- 동기화는 기기당 한 번만 실행한다. 변경 pull → 로컬 3자 비교 → 엔터티별 순서대로 push → 최종 pull 순서다.
- 사용자가 누르는 ‘지금 동기화’도 동일 엔진을 즉시 실행한다. 충돌 해결이나 AI 한도를 우회하지 않는다.
- 429/5xx/네트워크 오류는 지수 백오프와 jitter, Retry-After를 적용한다. 401은 토큰 갱신 후 재시도하고 실패하면 로그인 대기한다. 403은 중단, 409는 충돌 처리한다.

### 변경 커서와 삭제

`updated_at > 마지막시각`만으로 변경을 조회하지 않는다. 같은 시각·기기 시계 차이·삭제 누락 문제가 있다. 사용자별 change feed와 opaque cursor를 제공한다. 서버는 사용자별 카운터 행을 잠근 뒤 seq를 할당하고 변경 로그를 같은 트랜잭션에서 기록하여 커밋 역전으로 변경을 건너뛰지 않게 한다. 일반 sequence의 증가 순서가 커밋 순서라는 가정은 금지한다.

페이지는 스냅샷 상한까지 읽고 페이지 적용과 커서 저장을 로컬 트랜잭션으로 묶는다. 삭제는 `deleted_at` tombstone으로 전파한다. 초기 보존 정책은 90일 제안이며 기간 만료 커서는 `410 CURSOR_EXPIRED`로 전체 재동기화를 요구한다. 전체 재동기화도 미전송 편집을 먼저 별도로 보존한다.

## 7. version / revision / updated_at와 충돌

- `version`: 엔터티별 서버 정수. 최초 1, 성공한 변경마다 +1. 낙관적 잠금에 사용한다.
- `revision_id`: 불변 스냅샷 UUID. 본문 이력·분석 입력·승인 출처를 식별한다.
- `updated_at`: 서버 UTC 시각. 표시·운영 참고용이며 동기화 커서나 충돌 승자의 기준이 아니다.
- 날짜 값은 UTC instant와 IANA time zone을 구분한다. 회의 현지 날짜와 시간대도 저장한다.

```sql
-- 아래 갱신, revision, change log, 멱등 응답 저장은 하나의 서버 트랜잭션
UPDATE meetings
SET title = :title, body = :body,
    version = version + 1, revision_id = :new_revision_id,
    updated_at = now()
WHERE id = :id AND user_id = auth.uid()
  AND version = :base_version AND deleted_at IS NULL
RETURNING *;
```

갱신 0건은 소유권 확인 후 존재하지 않음/삭제/버전 충돌을 구분한다. 본문 충돌 UI는 base·내 편집·서버 최신을 보여준다. 서로 다른 필드는 3자 비교로 자동 병합할 수 있으나 같은 본문 필드는 기본 수동 병합한다. 해결 시 최신 서버 version으로 새 변경을 제출하고 그사이 다시 바뀌면 다시 충돌 처리한다. ‘내 내용 사용’도 새 revision이며 이력을 삭제하지 않는다.

삭제 대 수정 충돌은 자동 복원하지 않는다. 사용자가 삭제 유지 또는 새 ID로 복사 복원을 선택한다. 동시 편집 예: 두 기기가 version 7을 읽고 PC가 8로 저장했다면 모바일의 base_version 7 요청은 409다.

## 8. 인증·RLS·권한

Supabase Auth를 공통 로그인으로 사용한다. Windows 로그인은 시스템 브라우저와 PKCE, 등록된 콜백을 사용한다. 토큰은 Windows Credential Manager/DPAPI로 보호한다. 모바일 토큰 저장 방식은 XSS 위험을 고려해 선택하며 서버 중계 시 HttpOnly·Secure·SameSite 쿠키와 CSRF 방어를 적용한다.

모든 사용자 테이블에 RLS를 활성화하고 `user_id = auth.uid()`로 접근을 제한한다. 자식 테이블도 소유권 정책과 `(parent_id, user_id)` 복합 FK로 다른 사용자 자료와 연결할 수 없게 한다. Supabase는 Auth와 RLS를 함께 사용한 접근 통제를 지원한다. [공식 RLS 문서](https://supabase.com/docs/guides/database/postgres/row-level-security)

```sql
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY meetings_read ON meetings FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
-- 쓰기는 일반 클라이언트의 직접 UPDATE/INSERT 권한을 회수하고
-- 인증·버전·이력·change feed를 함께 처리하는 제한된 RPC로만 허용한다.
```

읽기 RLS만으로 업무 상태 변경을 안전하게 만들 수는 없다. 승인 상태, lease, version, user_id, 서버 시간은 임의 수정할 수 없도록 열 권한과 API를 제한한다. SECURITY DEFINER RPC가 필요하면 고정 search_path, 명시적 auth.uid 검사, PUBLIC 실행 권한 회수, 최소 역할을 적용한다. 서버 service-role은 RLS를 우회할 수 있으므로 exe·모바일 번들에 넣지 않는다. 워커는 매 작업 소유권과 승인 레코드를 재검사한다. Private Storage는 사용자 경로 정책과 짧은 signed URL을 사용한다.

## 9. Claude Code 구독형 CLI 분석

### 실행 및 제약

사용자가 Windows에 Claude Code를 별도 설치하고 자신의 지원 구독으로 로그인한다. 앱은 설치 경로·버전·실행 가능한 인증 상태를 확인하고 일반 사용자 권한으로 프로세스를 실행한다. 지원 Windows 구성과 요구조건은 [공식 설치 문서](https://code.claude.com/docs/en/setup), 구독 로그인 및 인증 우선순위는 [공식 인증 문서](https://code.claude.com/docs/en/authentication)를 기준으로 확인한다.

`claude -p` 비대화형 호출과 구조화 출력이 제공되지만, 구독 로그인·할당량·정책에 의존한다. 현재 문서상 `--bare`는 구독 인증을 읽지 않으므로 구독 경로에 적용하지 않는다. API 키 환경변수가 의도치 않은 과금 경로를 선택하지 않는지 확인한다. [프로그램 실행 문서](https://code.claude.com/docs/en/headless)

이 기능은 개인 PC의 사용자 소유 CLI를 연결하는 설계다. 구독을 무제한 API나 여러 사용자용 서버 자격증명으로 취급하지 않는다. 배포 전에 해당 플랜·이용약관·자동화 허용 범위를 확인하고 구독 세션을 서버에 복제하지 않는다. 한도 초과·재인증·네트워크 장애 시 작업을 대기시키며 유료 API로 자동 전환하지 않는다. 다중 사용자 SaaS 또는 가용성 보장이 필요하면 별도 동의를 받은 공식 API 공급자로 교체한다.

### 분석 파이프라인

1. 사용자가 ‘분석 실행’(initial) 또는 ‘재분석’(rerun)을 누르고 확인하면 클라우드에 작업을 만든다. 같은 회의록에 대기·실행 중 작업이 있으면 새로 만들지 않고 그 작업을 돌려준다(중복 클릭). initial은 같은 원문에 완료된 분석이 있으면 다시 만들지 않는다. 실행 단위는 `meeting_id + source_revision_id + analyzer_config_hash + run_no`다. 앱 시작·저장·동기화는 작업을 만들지 않는다.
2. PC가 claim RPC로 작업을 획득. 서버가 lease_token, lease_until, attempt를 발급.
3. 원문 스냅샷과 회의 기준 날짜·시간대만 다운로드. 현재 편집 중인 텍스트를 혼합하지 않음.
4. 앱 소유의 고정 작업 폴더에서 CLI 실행. 원문은 stdin으로 전달하고 shell=false, 인자 배열을 사용.
5. 일반 실행 모드가 읽는 사용자 설정·hooks·MCP·프로젝트 파일을 사전 점검한다. 회의 자료에서 설정 파일을 생성하지 않는다. 분석에는 파일 편집·셸·네트워크 도구를 허용하지 않는 구성을 지원 버전에서 검증한다. 도구 차단을 보장할 수 없으면 해당 버전의 자동 실행을 중단한다. 권한 우회 플래그는 금지한다.
6. JSON envelope, 내부 오류, schema, 길이, 날짜·시간대·종료시각을 검증. CLI 성공 코드만으로 결과 성공을 판정하지 않음.
7. 로컬 결과와 업로드 outbox를 먼저 원자 저장한 후 결과 API 호출. 통신 실패 시 분석을 다시 하지 않고 업로드부터 재시도.
8. 서버는 lease와 source_revision을 검사한다. 원문이 바뀌었으면 결과를 `stale`로 보존하고 최신 분석으로 표시하지 않음.

초기 제한 제안: 기기 동시 분석 1개, 작업 timeout 5분, heartbeat 30초, lease 120초. 긴 작업은 갱신하며 만료된 lease의 결과는 거절한다. 결과 저장·작업 완료는 멱등 처리한다.

실패(한도 초과, 로그인 만료, CLI 오류, 출력 검증 실패, 리스 만료, 원문 변경)는 `failed` 상태와 `error_code`로 남기고 화면에 사유를 보여준다. 서버·에이전트는 실패 작업을 자동으로 다시 대기시키지 않으며 사용자가 ‘재시도’를 눌러야 같은 작업이 다시 대기한다. 모바일에서 누른 요청은 ‘이 PC에서 분석 실행’을 허용한 PC 앱이 켜져 있을 때 처리된다. 이는 이미 누른 버튼을 처리하는 것이며 PC 앱이 새 분석을 만드는 것이 아니다.

### 분석 결과 스키마

```json
{
  "schema_version": 1,
  "summary": "회의 요약",
  "decisions": ["결정 사항"],
  "action_items": [{"text":"자료 전달", "assignee":null, "due_date":null}],
  "event_candidates": [{
    "title":"후속 회의",
    "start_local":null,
    "end_local":null,
    "time_zone":"Asia/Seoul",
    "all_day":false,
    "evidence":"다음 주에 다시 논의",
    "needs_confirmation":true
  }]
}
```

‘다음 주’처럼 시각이 불명확하면 임의의 날짜·시간을 확정하지 않는다. 원문 근거를 붙이고 확인 대상으로 남긴다. 자연어 안의 지시·링크·명령은 분석 대상 데이터이며 실행 지시가 아니다. 원문 외 추론을 사실로 채우지 않는다.

### 분석 결과 편집과 재분석 보호

`analysis_results`는 검증된 AI 출력의 불변 기록이다. 사용자가 편집하는 요약·결정사항은 회의별 `meeting_notes`에 별도로 저장하고 PC/모바일에서 동일하게 편집한다. `meeting_notes`는 version, revision_id, source_result_id, source_revision_id를 가지며 수정 이력은 `meeting_note_revisions`에 남긴다. 사용자 편집은 회의 원문 revision을 바꾸지 않는다.

최초 분석은 편집본이 없을 때만 초기 편집본을 생성한다. 재분석은 새 AI 결과를 만들고 기존 사용자 편집본을 그대로 유지한다. 사용자가 ‘새 결과 적용’을 선택하면 기존 편집본과 새 결과를 비교하고 base_version 검사 후 새 편집 revision을 만든다. 수동 병합도 가능하다. 원문이 바뀌면 기존 편집본을 삭제하지 않고 ‘이전 원문 기준’으로 표시한다. 일정 후보는 편집된 요약이 아닌 원문 revision에 연결하며 일정 후보의 수정·승인은 10장의 별도 절차를 따른다.

할 일은 분석 시 독립 `action_items` 레코드로 생성한다. 동일 결과 재전송 시 `(source_result_id, source_item_key)`로 중복을 막는다. 재분석에서 나온 할 일은 새 제안으로 분류하고 기존 할 일과 비교해 사용자가 추가·연결·무시하도록 한다. 완료 여부·담당자·수정된 기한을 AI가 덮어쓰거나 비슷한 문장이라는 이유로 자동 병합하지 않는다. 할 일은 `proposed → todo → in_progress → done` 또는 `cancelled`로 관리하고 완료 시각은 서버가 기록한다. 개인 MVP의 담당자는 표시 문자열이며 계정 권한이나 조직 공유를 뜻하지 않는다. 날짜만 정해진 기한은 date로, 시각이 정해진 기한은 UTC instant + time_zone으로 구분한다. 할 일 기한만으로 Google 일정을 생성하지 않으며 별도 후보 검토·승인이 필요하다.

## 10. Google Calendar OAuth와 승인 후 등록

권장 흐름은 클라우드 web-server OAuth다. 모바일/PC는 인증된 연결 시작 URL을 열고 서버는 사용자 세션에 묶인 일회성 state를 검증한다. 고정 HTTPS redirect URI와 authorization-code 교환을 사용하고 지원 구성에 맞춰 PKCE를 적용한다. refresh token과 client secret은 서버 비밀 저장소에만 둔다. 상세 절차는 [Google OAuth 문서](https://developers.google.com/identity/protocols/oauth2/web-server)를 따른다.

권한은 실제 기능에 필요한 최소 scope를 선택한다. 사용자 소유 캘린더만 대상으로 하면 `calendar.events.owned` 적용 가능성을 검토하고 공유 캘린더까지 쓰는 경우 `calendar.events` 필요성을 검토한다. 선택 UI에 캘린더 목록이 필요하면 별도의 목록 읽기 권한을 검토한다. 테스트 모드·공개 배포·scope에 따른 검증 요구와 토큰 만료 조건을 배포 체크리스트에서 확인한다. [공식 scope 목록](https://developers.google.com/workspace/calendar/api/auth)

### 상태와 승인 불변성

`needs_review → approved → registering → registered`

거절은 `rejected`, 등록 실패(인증 만료 포함)는 `failed` + `last_error_code`다. 원문 변경(`stale`)은 저장 상태가 아니라 후보의 source_revision_id와 회의록 현재 revision을 비교해 계산한다. 후보 수정 시 새 content_version을 만들고 이전 승인을 무효화하며 대기 중인 등록 작업을 취소한다. 승인 레코드는 후보 content_version, source_revision_id, 전체 payload hash, calendar_id, approved_at을 고정한다. 승인 요청은 화면에 보인 version·payload_hash와 현재 후보가 같을 때만 받는다. 미확정 시간, stale 후보, 삭제된 회의록, Google 미연결 상태는 승인할 수 없다.

등록은 사용자가 ‘승인하고 캘린더 등록’을 누르고 확인 단계에서 ‘등록’을 눌렀을 때 그 요청을 처리하는 Edge Function(`calendar-register`)이 바로 수행한다. 실패한 등록은 자동 재시도하지 않고 ‘재시도’(`calendar-retry`)로만 다시 실행한다. 별도 cron·상시 워커는 두지 않는다.

등록 처리기는 Google 요청 직전에 이 값을 재검증하고 승인된 payload 그대로 보낸다. 등록 중 수정·취소는 동시성 잠금으로 제한하고 이미 Google에 전달된 경우 후속 변경/삭제 작업으로 처리한다. 등록 후 회의록이 바뀌어도 Google 일정을 자동 수정하지 않으며 변경 후보와 재승인을 요구한다. 참석자 초대와 알림 전송은 별도 명시적 선택 없이는 추가하지 않는다.

### 중복 및 불확실한 응답

승인 ID마다 Google 규칙에 맞는 결정적 event ID를 만든다(예: UUID 하이픈 제거값; 지원 문자·길이 검증). 네트워크 timeout 후에는 해당 ID로 조회하고 승인 식별자를 비교한다. 존재하면 성공 복구, 없으면 같은 ID로 재시도한다. 충돌한 이벤트의 소유 매핑을 검증하지 않고 성공으로 취급하지 않는다. `calendar_id + google_event_id`와 approval_id에 unique 제약을 둔다.

시간 지정 일정은 RFC3339와 timeZone을 사용하고 종일 일정은 date 및 배타적 종료일을 사용한다. Google 등록은 `events.insert`를 사용한다. [공식 이벤트 생성 문서](https://developers.google.com/workspace/calendar/api/guides/create-events)

Google에서 사용자가 수정·삭제한 경우 감지용 수동 재확인을 우선 제공하고 ‘외부 변경됨’을 표시한다. 향후 watch/syncToken 도입은 별도 설계한다. 연결 해제 시 토큰 폐기·대기 등록 취소, 이미 생성된 일정 삭제 여부는 사용자 선택으로 둔다.

## 11. 데이터 모델

모든 사용자 데이터에 `user_id UUID NOT NULL`을 둔다. UUID는 클라이언트 생성 가능하나 소유권·서버 상태 필드는 서버가 결정한다. 아래는 논리 모델이며 실행 가능한 전체 DDL은 구현 단계에서 마이그레이션으로 작성한다.

| 테이블 | 주요 필드 / 제약 |
|---|---|
| meetings | id, user_id, title, body, meeting_at, time_zone, version, revision_id, created_at, updated_at, deleted_at |
| meeting_revisions | id, meeting_id, user_id, version, immutable_snapshot, body_hash, created_at; unique(meeting_id, version) |
| meeting_notes | id, meeting_id, user_id, summary, decisions, source_result_id, source_revision_id, version, revision_id, updated_at, deleted_at; unique(meeting_id) |
| meeting_note_revisions | id, note_id, user_id, version, immutable_snapshot, created_at; unique(note_id, version) |
| action_items | id, meeting_id, user_id, source_result_id(수동 생성 시 null), source_item_key, source_revision_id, text, assignee_label, due_date, due_at, time_zone, status, completed_at, version, updated_at, deleted_at; 결과 항목별 unique, due_date/due_at 동시 사용 금지 |
| analysis_jobs | id, meeting_id, source_revision_id, config_hash, run_no, status(queued/running/failed/completed/cancelled), device_id, lease_token_hash, lease_until, attempt, error_code; (입력 구성, run_no) unique, 회의록당 대기·실행 작업 1개 |
| analysis_results | id, job_id, user_id, source_revision_id, schema_version, validated_payload, engine_version, prompt_version, input_hash, stale, created_at; unique(job_id) |
| event_candidates | id, result_id, user_id, version, content_version, payload, source_revision_id, status, last_error_code, updated_at, deleted_at |
| event_approvals | id, candidate_id, candidate_content_version, user_id, source_revision_id, payload_snapshot, payload_hash, calendar_id, approved_at, revoked_at; 내용 버전당 유효 승인 1개 |
| calendar_jobs | id, approval_id, candidate_id, user_id, status(queued/running/succeeded/failed/cancelled), lease_until, attempts, last_error_code; unique(approval_id) |
| calendar_links | id, approval_id, user_id, calendar_id, google_event_id, etag, html_link, external_state; 매핑 unique |
| oauth_connections | id, user_id, provider, account_reference, scopes, token_secret_reference, status; 클라이언트 토큰 읽기 금지 |
| devices | id, user_id, display_name, capabilities, last_seen_at, revoked_at |
| change_feed | user_id, seq, entity_type, entity_id, entity_version, operation, snapshot/tombstone; PK(user_id, seq) |
| operation_receipts | user_id, operation_id, request_hash, response_status, response_payload, created_at; 복합 unique |
| audit_events | id, user_id, action, entity_id, request_id, device_id, created_at; 본문·토큰 기록 금지 |

모든 mutable 공유 엔터티에 version·updated_at을 적용한다. 승인/이력은 불변 레코드로 취급한다. 분석 입력 FK는 정확한 revision을 가리키며 부모 소유권을 복합 FK로 검증한다. lease·상태 인덱스, 사용자별 change seq, 사용자별 updated_at 조회 인덱스를 둔다. 계정 삭제 시 OAuth 폐기, 클라우드 삭제, 기기 캐시 삭제 안내 및 백업 만료 정책을 함께 수행한다.

## 12. API 계약

아래 URL은 앱의 논리 API 계약이다. Supabase가 자동으로 이 경로를 제공한다는 뜻은 아니며 Edge Function 또는 RPC 어댑터로 구현한다. 모든 호출은 HTTPS, 사용자 JWT, request_id를 사용한다. 쓰기에는 `Idempotency-Key`를 요구한다. 서버가 user_id를 JWT에서 결정한다.

| 메서드 / 경로 | 요청 | 응답·규칙 |
|---|---|---|
| POST /v1/meetings | id, title, body, meeting_at, time_zone | 201, version 1, revision_id |
| GET /v1/meetings | q, date_from, date_to, page_token, limit≤100 | 제목·본문 검색, items, next_page_token |
| GET /v1/meetings/{id}/notes | 없음 | 편집 요약·결정사항, 원본 결과 참조 |
| PATCH /v1/meetings/{id}/notes | base_version, patch | 새 편집 revision / 409 |
| POST /v1/meetings/{id}/notes/apply-result | base_version, result_id, selected_fields | 선택한 결과 적용, 새 revision |
| GET /v1/action-items | meeting_id, assignee_label, status, page_token | 사용자 할 일 목록 |
| POST /v1/action-items | id, meeting_id, text, assignee_label, due_date 또는 due_at, time_zone | 수동 할 일 생성 |
| PATCH /v1/action-items/{id} | base_version, patch | 담당자·기한·상태 수정 / 409 |
| DELETE /v1/action-items/{id} | base_version | tombstone |
| PATCH /v1/meetings/{id} | base_version, patch | 200 최신 사본 / 409 충돌 |
| DELETE /v1/meetings/{id} | base_version | tombstone + 새 version |
| GET /v1/sync/changes | cursor, limit≤200 | changes, next_cursor, has_more, snapshot_upper_bound |
| GET /v1/sync/snapshot | page_token | 전체 서버 사본·tombstone 기준점 |
| POST /v1/analysis/jobs | meeting_id, source_revision_id, mode(initial/rerun) | 202 job / 중복 시 기존 job |
| POST /v1/analysis/jobs/{id}/retry | 없음 | 실패 작업만 다시 대기 (‘재시도’ 버튼) |
| POST /v1/analysis/claim | device_id, capabilities | 200 job + lease / 204 없음 |
| POST /v1/analysis/jobs/{id}/heartbeat | lease_token | 갱신된 lease_until |
| POST /v1/analysis/jobs/{id}/result | lease_token, source_revision_id, payload, metadata | 200 완료 / 409 만료 lease |
| POST /v1/analysis/jobs/{id}/failure | lease_token, error_code | failed (자동 재시도 없음) |
| PATCH /v1/event-candidates/{id} | base_version, patch | 새 version, 승인 무효화 |
| POST /v1/event-candidates/{id}/approve | base_version, source_revision_id, payload_hash, calendar_id | 202 approval_id + calendar_job_id |
| GET /v1/calendar/jobs/{id} | 없음 | 상태, event 링크, 조치 사항 |
| POST /v1/calendar/jobs/{id}/retry | 없음 | 실패한 등록만 다시 실행 (‘재시도’ 버튼) |
| POST /v1/google/connect | return_target 식별자 | 허용된 OAuth 시작 URL |
| GET /v1/google/callback | code, state | 서버 교환 후 허용된 화면으로 이동 |
| DELETE /v1/google/connection | 없음 | 토큰 폐기 및 큐 취소 결과 |

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "다른 기기에서 수정되었습니다.",
    "request_id": "uuid",
    "current_version": 8,
    "current_revision_id": "uuid"
  }
}
```

400 검증 실패, 401 인증, 403 권한, 404 대상 없음, 409 충돌/키 재사용/만료 lease, 410 커서 만료, 413 크기 제한, 429 한도, 503 일시 장애를 구분한다. 다른 사용자 레코드의 존재·본문을 오류에 노출하지 않는다.

동일 키·동일 요청은 원래 응답을 반환하고 동일 키·다른 요청은 409다. 멱등 영수증 보존은 최소 outbox 재시도 기간 이상으로 정하며 기간 초과 작업은 자동 재전송하지 않고 재조정한다. claim은 DB 트랜잭션/행 잠금으로 원자 수행한다. 결과 저장·후보 생성·job 완료·change feed 생성도 같은 트랜잭션이다. 사용자 취소와 완료 경합에 대한 허용 상태 전이를 서버에서 강제한다.

## 13. Windows 실행 파일 패키징·백그라운드

- Tauri 배포로 서명된 Windows 설치 실행 파일과 필요 시 MSI를 만든다. ‘설치 exe’와 ‘앱 exe’를 구분한다. WebView2와 지원 CPU/OS를 설치 검사한다.
- Python 재사용 경로에서는 에이전트 실행 파일과 의존성을 함께 패키징하고 sidecar 시작·종료·상태 검사·버전 호환을 검증한다. 로컬 FastAPI를 선택했다면 외부 포트 공개 없이 인증된 loopback 접근만 허용하는지 검사한다.
- Claude Code는 앱에 무단 포함하지 않고 별도 설치·로그인 안내 및 진단을 제공한다. CLI 자동 업데이트 후 기능 검사로 호환되지 않는 자동 분석을 중지한다.
- 앱은 단일 인스턴스로 실행하고 창 닫기는 사용자 설정에 따라 트레이 최소화 또는 완전 종료한다. 종료와 백그라운드 유지 상태를 명확히 표시한다.
- 기본 백그라운드는 동일 사용자의 트레이 에이전트다. 로그인 시 자동 시작은 명시적 설정으로 등록한다. UI와 에이전트 간 로컬 IPC는 사용자 ACL과 고정 명령으로 제한한다.
- Windows 서비스/LocalSystem은 MVP에서 사용하지 않는다. 사용자 CLI 인증 접근과 세션 차이 때문이다. 작업 스케줄러를 추가하더라도 같은 사용자로 실행하고 다중 실행을 막는다.
- 절전 복귀 시 인증/네트워크를 다시 확인하고 변경 pull, lease 재조정을 수행한다. 꺼진 PC를 앱이 스스로 켜지는 것으로 설명하지 않는다.
- `%LOCALAPPDATA%`의 앱 전용 사용자 폴더에 캐시·로그를 보관한다. SQLite WAL과 마이그레이션 전 백업, DB 잠금·디스크 부족 복구를 구현한다.
- 업데이트 패키지와 메타데이터 서명을 검증하고 실패 시 기존 앱으로 복귀한다. 제거 시 로컬 자료 보존/삭제 선택을 제공한다.

## 14. 보안·운영·비용

회의 본문이 Anthropic에 전송된다는 사실과 클라우드 저장 위치를 첫 사용 시 고지하고 사용자가 분석 허용을 선택하게 한다. 민감한 회의록은 분석 제외 가능하게 한다. TLS, CSP, 안전한 Markdown 렌더링, 외부 URL 검증을 적용한다. 본문·AI 출력 HTML을 신뢰하지 않는다.

SQLite는 기본적으로 암호화되지 않는다. OS 계정 ACL·디스크 암호화를 기본 전제로 안내하고 강화 옵션은 검증된 DB 암호화와 키 저장소를 사용한다. 토큰을 SQLite·로그·오류 리포트·exe에 평문 저장하지 않는다. DPAPI는 같은 로그인 사용자의 악성코드까지 차단하는 수단은 아니다.

로그는 request_id·작업 상태·처리시간 위주로 남긴다. 원문/응답 임시 파일은 최소화하고 CLI 세션 기록까지 포함한 보존·삭제 범위를 확인한다. 백업과 복원은 정기 검증하고 클라우드 DB 복원에 첨부 객체·비밀 저장소 복원도 필요한지 구분한다.

운영 지표는 미전송 건수, sync 오류율, 가장 오래된 대기 작업, lease 만료, 분석 실패, 중복 등록 복구, OAuth 만료다. 개인 MVP라도 장애 알림과 실패 작업 재시도 화면을 제공한다. Supabase·호스팅·스토리지 비용과 구독 사용량은 별개이며 무료 플랜/구독만으로 상시 가용성을 보장하지 않는다. 가격·용량은 배포 시점에 다시 산정한다.

## 15. 로드맵과 완료 기준

| 단계 | 구현 범위 | 통과 기준 |
|---|---|---|
| 0. 기술 검증 | 기존 FastAPI 코드 재사용 평가, 에이전트 경로 결정, Windows CLI 구독 비대화형 실행, 도구 차단, 구조화 출력, OAuth 개발 환경 | 재사용/신규 선택 근거 기록, 실제 계정 샘플 검증, 미지원 시 API 대안 결정 |
| 1. 데이터 기반 | Auth, RLS, 모델, 버전 RPC, 변경 로그, 백업 | 교차 사용자 접근 차단, 원자적 변경 |
| 2. 클라이언트 | 검색·편집 요약·독립 할 일, PC·모바일 CRUD, SQLite/IndexedDB, outbox, 자동/수동 sync, 충돌 UI | PC 꺼짐 저장·재접속·오프라인 편집 복구, 재분석 편집 보호 |
| 3. AI | 큐·claim·리스·결과 업로드·stale 표시 | 중단 복구와 원문 변경 시 잘못된 승인 차단 |
| 4. Calendar | OAuth, 후보 검토·승인, 멱등 등록 워커 | 승인 없는 등록 0건, timeout 재시도 중복 0건 |
| 5. 배포 | 서명 설치, 트레이, 업데이트, 진단·삭제 정책 | 깨끗한 Windows 설치 및 복구 시나리오 통과 |
| 후속 | 첨부/OCR, 조직 권한, API 분석 공급자, 외부 일정 변경 감지 | 별도 데이터·권한·비용 설계 승인 |

기간은 인력과 기술 검증 결과를 보고 산정한다. 서버 동기화와 충돌 해결을 분석 기능보다 먼저 안정화한다.

## 16. 기존 설계 변경점과 추가 제안

공유 대화에서 확인한 기존 구성과 변경 내용을 먼저 정리한다. 실제 코드와 첨부 설계서 본문의 상세 구현은 미확인이다.

| 대화에서 확인한 기존 내용 | v2.1 변경·유지 |
|---|---|
| FastAPI + SQLite + Claude Code | FastAPI/Python 재사용 검토, 신규 구현 시 Tauri/Rust 제안. SQLite는 캐시/outbox로 역할 변경 |
| PC 로컬 웹 서버에 모바일 접속 | 모바일 독립 웹 + 클라우드 직접 저장·조회·수정 |
| PC 종료 중 모바일 사용 불가 | 모바일 기능 유지, PC 분석만 대기 |
| PC Claude Code 구독형 분석 | 유지, 클라우드 큐·lease·결과 업로드 보완 |
| 이전 회의 검색 | 유지, 온라인 전체 검색과 오프라인 캐시 검색 구분 |
| 요약·결정사항·담당자별 할 일 | 유지, 편집본·독립 할 일·재분석 보호 추가 |
| Google OAuth·승인 후 등록·중복 방지 | 유지, 서버 OAuth/등록 워커와 승인 snapshot 추가 제안 |
| 클라우드 저장·전달 | 캘린더 등록 워커까지 역할 확장 제안 |

아래는 기존 파일 확보 후 추가 점검할 조건이며 기존 설계의 결함으로 단정하지 않는다.

| 기존 설계에서 확인할 조건 | v2 반영 내용 |
|---|---|
| PC 로컬 저장만 사용한다면 | PostgreSQL 공유 기준 + SQLite 로컬 캐시/outbox로 변경 |
| 모바일이 PC 서버에 접속한다면 | 모바일이 클라우드에 직접 접근, PC 전원과 독립 |
| 저장 즉시 PC에서 동기 분석한다면 | 저장·분석 요청·분석 실행을 분리한 지속 큐 도입 |
| 클라우드가 구독 CLI를 실행한다면 | 사용자 Windows 분석 에이전트로 이동 |
| timestamp로 덮어쓴다면 | base_version + 불변 revision + 변경 커서 도입 |
| 원문을 AI 요약으로 대체한다면 | 원문·분석 결과·후보를 별도 저장 |
| 일정 추출 즉시 등록한다면 | 후보 검토·수정·버전 고정 승인 후 워커 등록 |
| Google 토큰을 exe에 저장한다면 | 서버 OAuth 비밀 저장소로 이동 |
| 관리자 키로 모든 기기가 접근한다면 | 사용자 JWT·RLS·제한 RPC로 변경 |
| exe만 배포하면 완료라면 | 웹 호스팅·DB 마이그레이션·서버 워커·CLI 사전조건까지 배포 범위 확장 |

기존 데이터 이관은 백업 → 드라이런 → 사용자 매핑 → UUID·최초 revision 생성 → 건수/해시 대조 → 기기 캐시 초기화 순서로 수행한다. 기존 Google event ID가 있으면 매핑을 유지하고 다시 등록하지 않는다. 이관 실패 시 읽기 전용 원본과 백업으로 복귀한다.

## 17. 테스트 케이스

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| S01 | PC 종료 중 모바일 신규·수정 | 클라우드 저장, 다음 PC 실행 후 동일 내용 |
| S02 | PC 오프라인 편집 후 앱 강제 종료 | 재시작 후 outbox 보존, 온라인 복구 |
| S03 | 같은 version을 두 기기에서 수정 | 한 건 성공, 나머지 409, 원문 유실 없음 |
| S04 | 서로 다른 필드 편집 | 3자 비교 규칙에 따른 병합, 새 revision |
| S05 | 삭제와 오프라인 수정 경합 | tombstone 유지, 사용자 복원 선택 |
| S06 | 응답 유실 후 동일 쓰기 재시도 | version 한 번 증가, 동일 응답 복구 |
| S07 | Realtime 누락·역순·중복 | 보정 pull로 완전 복구 |
| S08 | 페이지 중 앱 종료·커서 만료 | 마지막 적용 지점 재개 또는 안전한 전체 재동기화 |
| S09 | 서버 트랜잭션 커밋 순서 경합 | change feed 누락 없음 |
| E01 | 요약·결정사항 두 기기 동시 수정 | version 충돌 표시, 양쪽 편집 보존 |
| E02 | 사용자 편집 후 재분석·새 결과 적용 | 기존 편집 보존, 명시적 적용 시 새 revision |
| E03 | 할 일 완료 후 재분석·중복 결과 업로드 | 완료 상태 보존, 동일 결과 항목 중복 없음 |
| E04 | 오프라인 담당자·기한·상태 수정 | outbox 복구 및 충돌 처리 |
| F01 | 한국어 제목·본문·날짜 범위 검색 | 소유 자료만 반환, 삭제 자료 제외 |
| F02 | 오프라인 캐시·미전송 편집 검색 | 제한 범위 표시, 로컬 최신 편집 반영 |
| A01 | PC 두 대가 같은 작업 claim | 활성 lease 하나만 부여 |
| A02 | 분석 중 절전·종료 | lease 만료 후 재처리, 늦은 결과 거절 |
| A03 | 분석 중 회의록 수정 | 결과 stale, 새 분석 필요, 승인 차단 |
| A04 | JSON 오류·잘못된 날짜·내부 오류 | 결과 실패 표시, 일정 생성/등록 없음 |
| A05 | 구독 한도·로그인 만료·CLI 변경 | 실패 사유(RATE_LIMITED/AUTH_REQUIRED/CLI_UNSUPPORTED) 표시, 자동 재시도 없음 |
| A06 | 결과 생성 후 인터넷 단절 | 로컬 보존 후 업로드 재시도, 불필요 재분석 없음 |
| A07 | 본문에 명령 실행 지시 삽입 | 도구 실행·파일 유출 없음 |
| C01 | Google 연결만 하고 후보 미승인 | 이벤트 등록 없음 |
| C02 | 승인 직전/직후 후보 수정 | 오래된 승인 차단 또는 후속 변경 절차 |
| C03 | Google 등록 성공 후 응답 timeout | 동일 ID 조회 복구, 중복 없음 |
| C04 | OAuth state 재사용·변조 | 연결 거절, 다른 사용자 연결 불가 |
| C05 | refresh token 폐기·권한 부족 | 재연결 안내, 무한 재시도 없음 |
| C06 | 종일·DST·자정 경계·종료 이전 시작 | 올바른 시간대 또는 검증 실패 |
| C07 | Google에서 이벤트 수정·삭제 | 외부 변경 표시, 임의 재생성 없음 |
| R01 | 사용자 A JWT로 B의 모든 API/객체 접근 | 조회·수정·claim·승인·Storage 모두 차단 |
| R02 | 직접 DB로 version/status/user_id 조작 | 권한 차단, RPC 검증 우회 불가 |
| R03 | 로그·번들·SQLite 비밀 점검 | service-role/Google secret/평문 토큰/API 키 없음 |
| M01 | 앱 시작·회의록 저장·동기화 | 분석 작업·캘린더 등록 작업이 생기지 않음 |
| M02 | ‘분석 실행’·‘승인하고 캘린더 등록’ 연속·동시 클릭 | 작업·승인 1건, 같은 결과 반환 |
| M03 | 분석·등록 실패 후 대기 | 자동 재실행 없음, ‘재시도’ 버튼으로만 재실행 |
| M04 | 실행 중·완료·실패 | 각 상태와 실패 사유가 화면에 표시됨 |
| P01 | 깨끗한 Windows, CLI/WebView2 없음 | 설치 조건과 복구 안내, 앱 비정상 종료 없음 |
| P02 | 업데이트 실패·SQLite 마이그레이션 실패 | 이전 버전·백업으로 복귀 |
| P03 | 모바일 탭 종료·저장소 삭제 | 미전송 한계 안내, 온라인 완료 자료 복구 |
| P04 | 로그아웃/계정 전환/디스크 부족 | 사용자 간 캐시 노출 없음, 미전송 유실 방지 |

테스트는 순수 검증 단위 테스트, 실제 PostgreSQL/RLS 통합 테스트, 가짜 CLI·Google 장애 주입, 실제 테스트 캘린더 E2E로 구분한다. 마지막에는 실제 Windows PC + 모바일 + PC 전원 종료 시나리오를 검증한다. 테스트를 작성했다는 사실과 실행·통과 결과를 구분해서 기록한다.

## 18. Claude Code 개발 지시문

아래 내용을 개발 프로젝트의 초기 작업 지시로 사용한다. 이 설계서를 실제 저장소에 함께 제공한다.

```text
AI 회의록·캘린더 연동 프로그램을 이 설계서 v2.2 기준으로 구현하라.
먼저 기존 저장소/설계/데이터를 읽고 실제로 확인한 사실과 가정을 구분하라.
기존 설계 원문이 없으면 원문과 비교했다고 주장하지 말라.

기술 구성:
- React + TypeScript 공통 UI, 모바일 PWA, Windows Tauri + SQLite. 기존 Python/FastAPI 코드 재사용 가치를 먼저 평가하고 Python 또는 Rust 에이전트를 선택한다.
- Supabase Auth/PostgreSQL/RLS, 제한 RPC 또는 서버 API.
- Windows 사용자 소유 Claude Code CLI 분석 어댑터.
- 서버 Google Calendar OAuth 및 사용자 승인 요청 시 실행하는 등록 처리기.

순서:
1. 구현 전 미확정 결정과 작은 수직 기능 단위 작업 목록을 작성한다.
2. 데이터 마이그레이션, RLS, 버전 쓰기, 변경 feed, 멱등 영수증을 먼저 구현한다.
3. PC/모바일 CRUD, 이전 회의 검색, 편집 요약·결정사항, 독립 할 일, 로컬 outbox, 자동/수동 동기화와 충돌 UI를 구현한다.
4. 분석 lease 큐, stdin 실행, 도구 제한, JSON 검증, stale·업로드 재시도를 구현한다.
5. 후보 승인 snapshot과 Google 중복 방지 등록을 구현한다.
6. 서명 설치·트레이·사용자 자동 시작·업데이트·진단을 구현한다.

절대 규칙:
- 20장의 디렉터리 책임을 준수하고 경로는 중앙 resolver로 관리한다. 개인 PC 절대경로, 비밀값, 실행 데이터를 소스 코드에 넣지 않는다. 구조 변경 시 파일 역할표와 운영 문서를 함께 갱신한다.
- 재분석으로 사용자 요약·결정사항·할 일 완료 상태를 덮어쓰지 않는다. 새 결과 적용은 명시적 선택과 버전 검사를 요구한다.
- 미전송 로컬 편집을 서버 캐시로 덮어쓰지 않는다.
- updated_at만으로 충돌 해결하거나 일반 sequence를 커밋 순서로 가정하지 않는다.
- source_revision_id가 없는 분석 결과를 최신 결과로 사용하지 않는다.
- 사용자 승인 없는 Google 이벤트 등록, 수정, 초대 전송을 하지 않는다.
- 후보 변경 후 이전 승인을 재사용하지 않는다.
- service-role, Google secret, 구독 토큰을 클라이언트에 포함하지 않는다.
- shell 문자열에 회의록을 넣지 않는다. 권한 우회 옵션을 사용하지 않는다.
- 구독 CLI에 --bare를 적용하지 않는다. 실제 버전의 인증/플래그/도구 차단을 검증한다.
- 한도 초과 시 유료 API로 자동 전환하지 않는다.
- 원문과 AI 출력은 신뢰하지 않는 데이터로 처리한다.

산출물:
앱·서버 코드, SQL 마이그레이션/RLS, API 계약, 환경변수 예제(값 없음),
Windows 설치/복구 안내, 운영·백업 절차, 장애 주입 테스트와 실제 실행 결과.
설정되지 않은 외부 서비스는 mock과 실제 구현을 명확히 구분한다.
구현 완료 보고에는 변경 파일, 실행한 검증, 미검증 환경과 남은 제약을 기록한다.
```

## 19. 배포 전 최종 결정 목록

- 기존 설계서·구현 존재 여부 확인 및 상세 대조.
- 실제 FastAPI/Python 코드의 재사용 여부와 Windows 에이전트 구현 경로 확정.
- 개인 전용인지 다중 사용자인지 확정. 초기 데이터 모델은 사용자별 독립 자료 기준.
- CLI 구독 자동 실행의 플랜·약관·버전 호환성 검증.
- 웹 도메인, OAuth redirect URI, Google 공개 배포 검증 및 최소 scope 확정.
- 데이터 지역, 보존 기간, 백업·복구 목표, 분석 전송 동의 문구 확정.
- installer 서명 인증서와 업데이트 배포 경로 확정.

위 항목 중 외부 계정·배포 환경이 필요한 내용은 실제 운영 전 확인해야 한다. 이 문서는 구현 설계이며 서비스 설치·OAuth 등록·테스트 실행 완료를 의미하지 않는다.

## 20. 유지보수를 위한 파일·경로 설계

### 20.1 기본 원칙

아래 구조는 개발 시 만들 권장 경로이며 현재 구현된 파일 목록이 아니다. 저장소 루트는 개발자가 선택한다. `C:\Users\특정사용자\...` 같은 절대경로를 코드에 넣지 않는다. 소스·배포물·사용자 데이터·비밀정보를 분리하고 개발/테스트/운영 환경은 DB·OAuth 설정·로컬 데이터 경로까지 구분한다.

기능 수정 시 UI, 업무 규칙, 저장소 접근, 외부 서비스 어댑터를 구분해 찾을 수 있게 한다. 같은 업무 규칙을 Python과 Rust에 각각 구현하지 않으며 Phase 0에서 선택한 에이전트 경로 하나를 사용한다.

### 20.2 저장소 폴더 구조

```text
meeting-assistant/                         # 저장소 루트
├─ README.md                              # 설치·개발 시작·문서 위치
├─ AGENTS.md                              # 개발 규칙·검증 명령·금지 사항
├─ .gitignore                             # 비밀·DB·로그·배포물 제외
├─ .env.example                           # 비밀값 없는 환경변수 목록
├─ apps/
│  ├─ web/                                # 모바일 PWA 진입점·라우팅
│  │  ├─ src/app/
│  │  ├─ src/platform/                     # IndexedDB·서비스 워커 어댑터
│  │  └─ public/                          # 공개 정적 파일만
│  └─ desktop/
│     ├─ src/app/                         # Windows 화면 진입점
│     ├─ src/platform/                    # Tauri IPC 클라이언트
│     └─ src-tauri/
│        ├─ tauri.conf.json               # 창·번들·sidecar 설정
│        ├─ capabilities/                 # 최소 IPC 권한
│        └─ src/
│           ├─ commands/                  # 허용된 IPC 진입점
│           ├─ paths.rs                   # OS 경로 resolver
│           └─ agent/                     # Rust 선택 시 분석·동기화 에이전트
├─ packages/
│  ├─ ui/src/                             # 공통 화면·컴포넌트
│  │  └─ features/                        # meetings/notes/tasks/calendar/settings
│  ├─ contracts/                          # JSON Schema·API 타입·오류 코드
│  └─ client-core/src/                    # 공통 클라이언트 동기화·충돌 규칙
├─ agents/
│  └─ windows-python/                     # Python 재사용 선택 시에만 사용
│     ├─ pyproject.toml
│     └─ src/meeting_agent/
│        ├─ main.py                       # 에이전트 시작·종료
│        ├─ paths.py                      # OS 경로 resolver
│        ├─ analysis/                     # CLI 호출·결과 검증
│        ├─ sync/                         # 로컬 outbox·복구
│        └─ local_api/                    # 필요할 때만 loopback FastAPI
├─ server/
│  (calendar-worker는 v2.3에서 supabase/functions/_shared로 옮김)
├─ supabase/
│  ├─ config.toml                         # 로컬 개발 설정
│  ├─ migrations/                         # PostgreSQL DDL·RLS·RPC
│  ├─ functions/                          # 인증된 API·OAuth 콜백
│  └─ tests/                              # RLS·트랜잭션 통합 테스트
├─ storage/
│  └─ sqlite/migrations/                  # PC 캐시 전용 마이그레이션
├─ prompts/
│  └─ meeting-analysis/v1/                # 분석 지시문·출력 schema 참조
├─ tests/
│  ├─ integration/                        # 동기화·에이전트·장애 주입
│  ├─ e2e/                                # PC/모바일 업무 흐름
│  └─ fixtures/                           # 개인정보 없는 테스트 자료
├─ scripts/                               # 개발·검증·릴리스 자동화
├─ docs/
│  ├─ design.md                           # 최신 설계서
│  ├─ file-map.md                         # 폴더·파일 책임 및 수정 위치
│  ├─ api.md                              # API 계약
│  ├─ configuration.md                    # 환경변수·로컬 경로
│  ├─ operations.md                       # 배포·백업·장애 복구
│  └─ adr/                                # 기술 선택 근거·변경 기록
└─ dist/                                  # 빌드 산출물, Git 제외
```

계약 schema는 `packages/contracts`가 단일 원본이다. TypeScript/Python/Rust 검증 코드는 필요 시 여기서 생성하고 생성 파일에 직접 수정하지 않는다. `prompts`에 schema 사본을 만들어 별도로 유지하지 않는다. UI는 DB·CLI를 직접 호출하지 않고 platform/API 어댑터를 통해 접근한다. Rust 경로와 Python 경로의 선택 근거는 `docs/adr/0001-windows-agent.md`에 기록한다.

### 20.3 수정할 기능에 따른 파일 위치

| 수정 대상 | 우선 확인할 위치 | 함께 확인할 항목 |
|---|---|---|
| 회의록 작성·검색 화면 | packages/ui/src/features/meetings/ | 검색 API·캐시 범위 |
| 요약·결정사항 편집 | packages/ui/src/features/notes/ | version·편집 이력·재분석 보호 |
| 담당자별 할 일 | packages/ui/src/features/tasks/ | action_items 계약·상태 전이 |
| 동기화·충돌 UI/엔진 | packages/client-core/src/ 및 기기별 platform/ | outbox·커서·서버 RPC |
| CLI 실행·timeout | 선택한 Windows agent의 analysis 모듈 | 도구 제한·리스·출력 검증 |
| 분석 지시문 | prompts/meeting-analysis/ | prompt_version·출력 계약·회귀 자료 |
| 일정 검토 화면 | packages/ui/src/features/calendar/ | 승인 payload·candidate version |
| Google OAuth | supabase/functions/의 OAuth 모듈 | state·callback·서버 비밀 설정 |
| 실제 일정 등록·중복 복구 | supabase/functions/_shared/ (handlers.ts, google.ts) | approval snapshot·event ID |
| PostgreSQL·RLS | supabase/migrations/ | 계약·change feed·권한 테스트 |
| SQLite 구조 | storage/sqlite/migrations/ | 캐시 이전·outbox 보존·복원 |
| exe 설치·트레이·IPC | apps/desktop/src-tauri/ | 서명·권한·sidecar·자동 시작 |

### 20.4 Windows 실행 데이터 경로

제품 내부 이름은 `MeetingAssistant`, 환경 식별자는 `development`, `test`, `production`으로 제안한다. 실제 경로는 OS API로 LocalAppData를 조회해 구성한다. 사용자 SID나 이메일을 폴더 이름으로 쓰지 않고 Supabase 사용자 UUID로 계정별 저장소를 분리한다.

```text
%LOCALAPPDATA%/MeetingAssistant/<environment>/
├─ settings.json                          # 비밀 없는 기기 설정·경로 형식 버전
├─ accounts/<user_uuid>/
│  ├─ db/cache.sqlite3                    # 캐시·draft·outbox·sync_state
│  ├─ backups/                            # 마이그레이션 전 일관된 DB 백업
│  ├─ analysis/jobs/<job_uuid>/            # 필요 시 사용하는 임시 분석 자료
│  ├─ exports/                            # 사용자가 요청한 내보내기 기본 위치
│  └─ logs/                               # 계정 범위 작업 진단 로그
├─ logs/                                  # 로그인 전 시작·업데이트 진단 로그
└─ tmp/                                   # 정리 가능한 비민감 임시 자료
```

앱 설치 경로는 설치 관리자가 정하고 읽기 전용 자원으로 취급한다. 앱 exe 옆, 소스 폴더, 현재 작업 폴더에 DB·토큰·로그를 저장하지 않는다. SQLite의 `-wal`·`-shm` 파일은 DB와 같은 디렉터리에 생길 수 있으므로 같은 보호 정책을 적용한다. 실행 중 단순 파일 복사로 백업하지 않고 SQLite backup API 등 일관된 스냅샷 방식으로 생성한다. outbox를 포함한 DB는 단순 캐시라는 이유로 자동 삭제하지 않는다.

Supabase 토큰은 Windows 보안 저장소에 제품·환경·사용자 UUID를 포함한 식별자로 저장한다. Google secret/refresh token은 서버 비밀 저장소에만 둔다. Claude Code 인증 경로는 앱이 지정·복제·이동하지 않고 공식 CLI가 관리하도록 한다.

### 20.5 경로·설정 관리 계약

중앙 resolver는 `data_root`, `account_root(user_id)`, `db_path`, `log_dir`, `backup_dir`, `analysis_job_dir(job_id)`를 제공한다. Tauri UI에는 필요한 상태만 반환하고 임의 파일 경로 접근 명령을 노출하지 않는다. UUID 입력은 형식을 검증하고 사용자 텍스트를 파일명으로 사용하지 않는다. 경로를 정규화한 후 대상이 허용된 root 안에 있는지 확인하며 `..`·심볼릭 링크·junction을 이용한 경로 이탈을 차단한다.

| 설정 | 관리 위치 | 규칙 |
|---|---|---|
| 환경·클라우드 URL·공개 클라이언트 키 | 환경별 빌드/배포 설정 | 공개 키도 RLS 전제, 서버 비밀과 구분 |
| service-role·Google secret·토큰 암호화 키 | 서버 비밀 관리 시스템 | 클라이언트 설정·Git·로그에 금지 |
| 트레이·자동 시작·동기화 설정 | settings.json | 설정 schema version과 원자적 저장 |
| 계정별 캐시·outbox | 중앙 resolver의 db_path | 사용자·환경 분리 |
| 개발/테스트 데이터 경로 재정의 | 테스트 실행 설정 | 운영 환경에서 임의 환경변수 덮어쓰기 금지 |
| 사용자 내보내기 경로 | OS 파일 저장 대화상자 | 명시적으로 선택한 위치만 사용 |

`.env.example`은 변수 이름·용도·필수 여부만 담는다. 개발 `.env.local`과 실제 비밀 파일은 Git에서 제외한다. `.gitignore`에는 `.env*`(예제 예외), `*.sqlite3`, `*.sqlite3-wal`, `*.sqlite3-shm`, `logs/`, 임시 분석 자료, 빌드 산출물을 포함하되 마이그레이션 SQL과 테스트 fixture는 제외하지 않는다. 무시 규칙만 믿지 않고 릴리스 전 비밀·개인자료 포함 여부를 검사한다.

### 20.6 경로 변경·복구·문서 유지

MVP에서는 데이터 저장 경로를 고정하고 설정 화면의 ‘데이터 폴더 열기’, ‘진단 정보 내보내기’, ‘백업 만들기’를 제공한다. 진단에는 토큰·회의 본문을 포함하지 않는다. 데이터 폴더 이동은 후속 기능이며 탐색기에서 임의 이동을 권장하지 않는다.

이동 기능을 구현한다면 에이전트 중지 → 미전송 건수·DB 백업 확인 → 새 경로 권한·공간 검사 → 일관된 복사 → 무결성·건수 검증 → 설정 원자 변경 → 재시작 확인 순서로 처리한다. 실패 시 기존 경로로 복귀하고 성공 확인 전 원본을 삭제하지 않는다. OneDrive/공유 네트워크 폴더에 활성 SQLite를 두어 클라우드 동기화를 대신하지 않는다.

마이그레이션 파일은 순번/시간 접두어와 설명을 붙이며 적용한 파일을 수정하지 않고 새 파일을 추가한다. 예: `202610170001_create_meetings.sql`, SQLite `0001_initial.sql`. DB schema version·API schema version·prompt_version·앱 버전은 각각 관리한다. 폴더·파일 이동은 `docs/file-map.md`와 관련 ADR·설정 예제를 함께 갱신한다.

### 20.7 경로 관련 완료 기준

- 사용자 이름에 한글·공백이 있는 Windows, 서로 다른 Windows 계정, 개발/운영 병행 실행에서 경로가 분리된다.
- 다른 계정의 DB·로그가 조회되지 않으며 로그아웃 시 열려 있는 DB·IPC 핸들을 정리한다.
- 읽기 전용 설치 경로에서도 실행되고 디스크 부족·파일 잠금 오류가 미전송 데이터 유실로 이어지지 않는다.
- 경로 이탈·junction 공격·손상된 settings.json·DB 마이그레이션 실패를 검증한다.
- 로그 정리와 임시 폴더 정리가 outbox·업로드 대기 결과를 삭제하지 않는다. 결과가 DB/outbox에 보존됐는지 확인한 뒤 임시 자료만 정리한다.
- 저장소 checkout·설치 exe·진단 내보내기에 실제 토큰·운영 DB·회의 본문이 들어가지 않는다.
