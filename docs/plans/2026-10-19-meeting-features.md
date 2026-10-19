# 계획: 회의록 영구 삭제 · 분석 추가 요청사항 · 목적지/지도 링크 · 원본 회의록 링크 · Joplin 공유 · 요약 목록

- 상태: **구현 진행** (2026-10-19)
- 범위: 기존 기능 설명은 반복하지 않고 바뀌는 부분만 적는다. 유지 규칙: 버튼으로만 실행, 사용자 승인 후 등록, 중복 실행 방지(`SingleFlight` + operation_id 영수증), 실패는 ‘재시도’로만, 비밀값은 저장소·번들·로그 밖.
- 관련: [ADR 0003](../adr/0003-manual-execution.md), [mobile-android.md](mobile-android.md), [roadmap.md](../roadmap.md)

## 0. 전체 변경 범위

| 영역 | 변경 |
|---|---|
| DB | 새 마이그레이션 `20261019090000_meeting_features.sql` 1개(이미 적용한 파일은 수정하지 않음) |
| Edge Function | `calendar-register`·`calendar-retry` 이벤트 본문(장소·지도 링크·원본 링크), 새 함수 `open-meeting`(원본 회의록 링크 중계) |
| 계약 | 분석 결과 schema **v2**(일정 후보 `location`, `location_uncertain`), 후보 payload 필드, 작업의 `user_instructions` |
| PC 앱 | 삭제 버튼·확인창, 분석 요청사항 입력, 후보 목적지 확인·수정, 요약·결정사항 탭, `meetingassistant://` 딥링크 수신 |
| Rust 에이전트 | stdin에 요청사항을 원문과 분리해 전달, 지시문 v2, v2 출력 검증 |
| 안드로이드 앱 | 위 화면 + 요약 탭, Joplin 공유 수신(Kotlin), 딥링크 수신 |
| 문서 | design.md, ADR 0004(원본 링크 방식), api.md, file-map, roadmap |

## 1. 회의록 영구 삭제

### 동작
- PC·휴대폰 회의 상세 화면에 **삭제** 버튼(목록에는 두지 않는다, 2026-10-20 사용자 요청). 확인창에 다음을 표시하고 ‘영구 삭제’를 눌러야 실행한다.
  - “회의록과 분석 결과·요약 편집본·일정 후보가 모두 지워지며 되돌릴 수 없습니다.”
  - Google에 등록된 일정이 있으면 “Google 캘린더에 등록된 일정 N건은 그대로 남습니다(필요하면 캘린더에서 직접 지우세요).”
- 휴지통·복원·소프트 삭제 UI는 없다. 기존 `meeting_delete`(tombstone RPC)는 동기화 호환용으로 남기되 화면에서는 쓰지 않는다.

### 서버: `meeting_purge(p_operation_id, p_id, p_base_version)`
| 항목 | 처리 |
|---|---|
| 확인 | 소유자·version 검사(다른 기기가 먼저 고쳤으면 409로 다시 확인) |
| 진행 중 캘린더 등록 | `calendar_jobs.status = 'running'`이고 리스가 유효하면 `JOB_IN_PROGRESS`로 거절(몇 초 뒤 다시). Google에 반쯤 전달된 상태를 남기지 않기 위함 |
| 진행 중 분석 | 대기·실행 중 작업도 함께 지운다. PC가 나중에 결과를 올리면 `NOT_FOUND`(4xx)가 되어 에이전트가 로컬 저장본을 버린다(기존 동작) |
| 정리 범위 | `meetings` 행 삭제 → FK cascade로 `meeting_revisions`, `analysis_jobs`, `analysis_results`, `meeting_notes`·`meeting_note_revisions`, `event_candidates`, `event_approvals`, `calendar_jobs`, `calendar_links` 삭제 |
| 개인정보 잔존 | `change_feed`에서 이 회의와 하위 엔터티(편집본·후보·작업)의 과거 payload를 tombstone으로 덮어쓴다(seq는 유지). `operation_receipts` 중 이 회의 응답을 담은 행 삭제 |
| 다른 기기 반영 | change feed에 `operation = 'purge'` 1건 기록. 지금 화면은 목록을 다시 읽으므로 다음 새로고침에서 사라진다. 열려 있던 상세 화면은 조회가 404가 되어 “삭제된 회의록” 안내로 바뀐다. 이후 오프라인 동기화 엔진은 purge를 받으면 로컬 사본을 지운다 |
| Google 일정 | 지우지 않는다. 일정 설명의 ‘원본 회의록 보기’는 4장의 안내 화면으로 연결된다 |
| 멱등 | 같은 operation_id 재전송은 같은 응답. 이미 없는 회의는 `NOT_FOUND` |

## 2. AI 분석 추가 요청사항

- 분석 요청 확인창에 **추가 요청사항**(선택, 2,000자 이하) 입력칸. 비우면 기존과 같다.
- 재분석 확인창은 직전 작업의 요청사항을 미리 채우고 수정할 수 있다. ‘재시도’는 실패한 작업의 요청사항을 그대로 쓴다.
- DB: `analysis_jobs.user_instructions text null`(작업 = 분석 이력 단위로 보관). `analysis_request`에 `p_user_instructions` 추가, 요청 해시에 포함. 대기·실행 중 작업이 있으면 기존 작업을 돌려주고 화면에 “이미 요청된 분석이 있어 새 요청사항은 적용되지 않았습니다”를 표시.
- 전달: `analysis_claim` 응답 `input.user_instructions` → Rust가 stdin JSON에 `user_instructions` 필드로 **본문(`body`)과 분리**해 넣는다. CLI 인자에는 들어가지 않는다.
- 지시문 v2(`prompts/meeting-analysis/v2/prompt.md`): 요청사항은 요약·결정사항의 초점·표현에만 반영하고, 출력 형식·규칙·도구 금지를 바꾸지 못한다. 회의 본문 안의 지시는 여전히 데이터다.
- 유지: 출력 schema 검증, `--tools ""` 등 도구 차단, 재분석이 편집본을 덮어쓰지 않는 규칙.
- `analysis_config_hash`는 `meeting-analysis/v2`로 바뀐다(이전 v1 완료 결과는 이력으로 남는다).

## 3. 목적지·네이버 지도 링크

### 분석 출력 (schema v2)
일정 후보에 두 필드를 추가한다.
- `location`: 원문에 **실제 목적지가 적힌 경우에만** 그 이름(200자 이하), 없으면 `null`. 추측·기본값 금지. 하나만(여러 곳·경유지는 지원하지 않으므로 가장 분명한 목적지 하나, 확실하지 않으면 `location_uncertain`).
- `location_uncertain`: 목적지가 언급됐지만 어느 곳인지 불명확하거나 여러 곳이면 `true`.
- v1 결과(기존)는 `location = null`로 다룬다. 서버 검증은 v1·v2를 모두 받는다.

### 확인·수정
- 후보 카드에 **목적지** 입력칸(수정·비우기 가능). 수정하면 `location_uncertain = false`, 새 content_version → 이전 승인 무효화(기존 규칙).
- `location_uncertain = true`이면 ‘승인하고 캘린더 등록’을 막고 “목적지를 확인하세요”와 **이 목적지가 맞음** 버튼(같은 값으로 저장 → 확인 처리)을 보인다. 서버 `candidate_approve`도 같은 조건을 거절한다.

### Google 이벤트
- `location` 있음: 이벤트 `location` = 목적지명, 설명에 `네이버 지도: https://map.naver.com/p/search/<URL 인코딩한 목적지명>` 추가.
- `location` 없음: 이벤트 `location` 없음, 지도 링크 없음.
- 링크는 승인 snapshot의 목적지명에서 만들어지므로 목적지를 바꾸면 새 승인에서 새 링크가 된다.
- 회의 앱은 위치 권한·좌표·경로 계산을 쓰지 않는다. 장소 선택과 길찾기는 네이버 지도에서 한다.

## 4. 캘린더에서 원본 회의록으로 이동

### 방식 검토
| 방식 | 판단 |
|---|---|
| Android App Links(https 도메인 검증) | 우리 도메인에 `assetlinks.json`을 올려야 한다. 웹 호스팅이 없고 `*.supabase.co`는 우리 도메인이 아니어서 **불가** |
| 설명에 `meetingassistant://` 직접 넣기 | Google 캘린더가 사용자 정의 스킴을 링크로 만들지 않는 경우가 많아 **불안정** |
| **https 중계 + 사용자 정의 스킴 (추천)** | 설명에는 `https://<project>.supabase.co/functions/v1/open-meeting?m=<회의 UUID>`. 중계 함수가 안드로이드는 `intent://…#Intent;scheme=meetingassistant;package=app.meetingassistant.mobile;end`, PC는 `meetingassistant://meeting/<UUID>`로 넘긴다. 앱은 Tauri deep-link 플러그인으로 받는다 |

### 규칙
- 링크에는 회의 UUID만 넣는다. 본문·토큰 없음. 중계 함수는 DB를 조회하지 않아 회의 존재 여부도 드러내지 않는다(JWT 검사 없음, UUID 형식만 검사).
- 앱이 링크를 받으면: 로그인 상태면 그 회의 상세로 이동, 로그인 전이면 회의 ID를 기기에 잠시 보관했다가 로그인 후 이동.
- 권한은 로그인한 사용자의 RLS로 검사한다. 없거나 삭제됐거나 남의 회의면 “삭제됐거나 볼 수 없는 회의록입니다” 안내 화면.
- PC: deep-link 플러그인이 `meetingassistant` 스킴을 현재 사용자 레지스트리(HKCU)에 등록한다. 앱이 이미 떠 있으면 단일 인스턴스가 링크를 기존 창으로 넘긴다. 앱이 설치되지 않은 PC에서는 중계 함수의 텍스트 안내가 보인다.
- 3번 목적지와 별개로, 승인해서 등록하는 **모든 일정**에 ‘원본 회의록 보기’ 링크를 넣는다. 이미 등록된 일정은 고치지 않는다(자동 수정 금지 규칙).
- 링크 기본 주소는 서버 비밀 `GOOGLE_OAUTH_REDIRECT_URI`의 `/functions/v1/` 앞부분에서 만든다(새 비밀 없음).

## 5. Joplin 메모를 새 회의로 가져오기 (안드로이드)

- Joplin의 ‘공유’ 목록에 **회의 어시스턴트**가 보이도록 `ACTION_SEND` intent-filter(`text/plain`, `text/markdown`, `text/*`)를 MainActivity에 추가.
- 받는 값: `EXTRA_TEXT`(본문), `EXTRA_SUBJECT`(제목, 있으면), `EXTRA_STREAM`(파일로 공유된 .md/.txt → ContentResolver로 읽기, 1MB 제한). 이미지·첨부는 범위 밖이며 받으면 “텍스트만 가져올 수 있습니다” 안내.
- **실제 전달 형식 확인**: Joplin 버전마다 제목을 `EXTRA_SUBJECT`로 주는지 본문 첫 줄에 넣는지 다를 수 있다. 수신 값의 종류·길이만(내용 없이) 기록하는 확인 화면을 두고 사용자 기기에서 확인한 뒤 매핑을 고정한다.
- 보관: Kotlin이 받은 값을 SharedPreferences에 저장(앱 종료·로그인 전에도 유지). 화면(JS)은 WebView 브리지 `MeetingAssistantShare.take()`로 한 번 꺼내 기기 저장소의 작성 중 초안으로 옮긴다. 저장·취소하면 초안을 지운다.
- 화면: 새 회의 작성 화면을 열고 제목(없으면 빈칸)·본문을 채운다. **자동 저장·자동 분석 없음.**
- Markdown: 원문 그대로 저장. 작성 화면과 상세 화면에 **편집 / 미리보기** 전환. 미리보기는 `react-markdown`으로 React 요소만 만들고 HTML 원문을 렌더링하지 않는다(`<script>`·이벤트 속성·`javascript:` 링크 차단). 링크는 http/https만 허용.
- 양방향 동기화·기존 회의 병합 없음. PC Joplin은 공유 기능이 없어 범위 밖(복사·붙여넣기 시 같은 Markdown 미리보기는 PC에도 적용).

## 6. ‘요약·결정사항’ 탭 AI 요약 목록

- 새 RPC `meeting_summaries()`: 로그인 사용자의 회의별 **최신 분석 결과 1건**과 회의 제목·일시·시간대, 요약 앞부분(160자), 분석 완료 시각, `stale`(이전 원문 기준), 편집본 존재 여부. 결과가 없는 회의·삭제된 회의는 제외.
- PC ‘요약·결정사항’ 탭, 휴대폰에 **요약** 탭(하단 탭 4개). 탭을 열 때·화면에 다시 돌아올 때·분석 완료 신호를 받을 때 다시 읽는다(가져오기 버튼 없음).
- 항목 선택 → AI 원본 요약·결정사항(해당 결과의 요청사항 포함)과 **사용자 편집본**을 나눠 표시. 편집은 PC 회의 상세의 기존 편집 화면에서만 한다. 재분석은 이력·편집본을 보존하고 목록에는 최신 결과만 보인다.

## 7. 데이터 변경 요약 (새 마이그레이션)

| 대상 | 변경 |
|---|---|
| `app_private.change_feed` | operation에 `purge` 허용 |
| `analysis_jobs` | `user_instructions text null check (char_length <= 2000)`, authenticated select 열 권한 추가 |
| 함수 | `meeting_purge` 추가, `analysis_request` 시그니처 변경(요청사항), `analysis_claim`·`analysis_submit_result`·`validate_analysis_payload`·`validate_candidate_shape`·`candidate_patch`·`candidate_approve`·`svc_calendar_job_claim`(meeting_id 반환) 교체, `analysis_config_hash` v2, `meeting_summaries` 추가 |
| 후보 payload | `location`, `location_uncertain` 키 허용(v1 후보는 없는 키 = null/false) |

## 8. 구현 순서

1. 계약·DB 마이그레이션·pgTAP (1·2·3·6 서버 부분)
2. Edge Function: 이벤트 본문(장소·지도·원본 링크), `open-meeting`, vitest
3. Rust: stdin 요청사항, 지시문 v2, v2 검증, 테스트
4. PC·공통 화면: 삭제, 요청사항, 목적지, 요약 탭, Markdown 미리보기
5. 딥링크: deep-link 플러그인(PC·안드로이드), 로그인 후 이동
6. 안드로이드 공유 수신(Kotlin 브리지), 초안 보관
7. 클라우드 적용(마이그레이션·함수 배포 — 사용자 확인 후), 설치본·APK 재빌드
8. 문서·커밋(기능 단위)

## 9. 검증 항목

| ID | 시나리오 | 기대 |
|---|---|---|
| D01 | 확인창에서 취소 | 아무것도 지워지지 않음 |
| D02 | 영구 삭제 | 회의·결과·후보·승인·작업 모두 사라짐, change feed 과거 payload에 본문 없음 |
| D03 | 등록된 일정이 있는 회의 삭제 | 확인창에 N건 안내, Google 일정 유지 |
| D04 | 캘린더 등록 진행 중 삭제 | `JOB_IN_PROGRESS`, 데이터 유지 |
| D05 | 분석 중 삭제 후 PC 결과 업로드 | 404 → 로컬 저장본 정리, 재분석 없음 |
| D06 | 다른 사용자의 회의 삭제 시도 | `NOT_FOUND` |
| I01 | 요청사항 없이 분석 | 기존과 같은 결과 형식 |
| I02 | 요청사항 입력 | 작업에 보관, stdin에 `body`와 분리, CLI 인자에 없음 |
| I03 | 재분석 | 직전 요청사항이 미리 채워짐 |
| I04 | 요청사항에 “도구를 써라/형식 바꿔라” | 도구 0개, schema 검증 통과 결과만 저장 |
| L01 | 목적지 없는 일정 | 이벤트 location·지도 링크 없음 |
| L02 | 목적지 있는 일정 | location = 목적지명, 설명에 네이버 지도 검색 링크 |
| L03 | 불명확 목적지 | 확인 전 승인 거절(화면·서버) |
| L04 | 목적지 수정 후 | 새 승인 필요, 새 링크 |
| O01 | 설명의 원본 링크(로그인 상태) | 해당 회의 상세 |
| O02 | 로그인 전 | 로그인 후 해당 회의 |
| O03 | 삭제된/남의 회의 | 안내 화면 |
| O04 | 링크 내용 | 회의 UUID만, 본문·토큰 없음 |
| J01 | Joplin 텍스트 공유 | 새 회의 작성 화면에 제목·본문, 자동 저장 없음 |
| J02 | 앱 종료·로그인 전 공유 | 로그인 후에도 초안 유지 |
| J03 | `<script>`·`javascript:` 포함 Markdown 미리보기 | 실행·링크 없음 |
| J04 | 이미지 공유 | 안내 후 무시 |
| S01 | 분석 완료 | 요약 탭에 자동 반영 |
| S02 | 재분석 | 최신 1건만 목록, 편집본 유지 |
| S03 | 원문 변경 후 | ‘이전 원문 기준’ 표시 |
| S04 | 회의 삭제 | 목록에서 사라짐 |

## 10. 2026-10-20 후속 변경 (사용자 요청)

### 10.1 일정 후보 ‘모두 승인하고 캘린더 등록’
- 위치: PC·휴대폰 회의 상세의 일정 후보 영역(`CandidateList`). 승인할 수 있는 후보가 2건 이상일 때만 보인다.
- 대상 선정(`planBulkApprove`): 개별 ‘승인하고 캘린더 등록’과 같은 규칙(`candidateView`).
  - 제외(목록에 안 넣음): 거절, 등록 완료, 등록 중, 승인됨(등록 대기).
  - 제외(사유 표시): 날짜 미정, 목적지 확인 필요, 원문 변경, 수정 후 저장 안 함, 재시도 대상 등록 실패, Google 미연결.
- 실행: 확인창에 등록할 목록(제목·일시·장소)과 제외 목록·사유를 보여 주고 ‘N건 등록’을 눌러야 시작한다. 확인창·진행 중에는 카드의 수정·승인·거절을 막는다.
- 등록(`approveAllSequentially`): 후보마다 별도 operation_id로 기존 `calendar-register`를 차례로 호출한다. 하나가 실패해도 나머지는 계속하고, 실패 후보는 자동 재실행하지 않는다(개별 화면에서 확인 후 사용자가 다시 누름). 서버 변경 없음.
- 결과: 성공 건수, 실패 후보 이름·사유.

### 10.2 거절한 일정 숨김
- 회의 상세의 일정 후보 목록에서 `rejected` 후보를 보이지 않게 한다(`visibleCandidates`). 서버 기록은 그대로 둔다. 휴대폰 ‘일정 확인’ 목록은 원래 거절 후보를 포함하지 않는다.

### 10.3 Joplin 공유 제목
- 실제 기기 확인 결과 Joplin은 제목 자리에 노트 ID(32자리 16진수)를 보낸다. 제목이 비었거나 이 형식이면 본문 첫 줄(앞의 `#` 제거)을 제목으로 쓰고 본문에서 뺀다(`draftFromShare`).

### 10.4 화면
- 회의 목록의 삭제 버튼을 없애고 상세 화면에서만 삭제한다(1장 수정).
- PC 분석은 작업을 가져오는 즉시 화면을 ‘실행 중’으로 바꾼다.

### 10.5 검증
| ID | 시나리오 | 기대 결과 | 상태 |
|---|---|---|---|
| B01 | 승인 가능 후보 3건 + 거절 1건 + 목적지 확인 필요 1건 | 3건만 대상, 1건 제외 사유 표시, 거절은 목록에 없음 | 단위 테스트 |
| B02 | 중간 1건 실패 | 나머지 등록, 실패 1건 표시, 자동 재실행 없음 | 단위 테스트 |
| B03 | 후보 수정 후 저장 안 함 | 대상에서 제외(‘수정한 내용을 먼저 저장하세요’) | 단위 테스트 |
| B04 | 실제 Google 계정으로 모두 승인 | 각 일정 1건씩, 중복 없음 | 기기 확인 필요 |
| J05 | Joplin 노트 ID 제목 | 본문 첫 줄이 제목 | 단위 테스트, 기기 재확인 필요 |
