# API 계약

논리 API 계약의 기준은 [design.md 12장](design.md#12-api-계약)이다. 구현한 엔드포인트는 이 문서에 실제 경로, RPC 이름, 요청·응답 예시를 기록한다.

오류 코드 정의: `packages/contracts/src/errors.ts`. 상태 전이: `packages/contracts/src/status.ts` (클라이언트 검사는 UX용이며 서버가 같은 규칙을 강제해야 한다).

## 구현 현황

Supabase RPC(`POST /rest/v1/rpc/<이름>`, 사용자 JWT 필요)와 Edge Function(`POST /functions/v1/<이름>`)이다. 정의: [`20261017090000_sync_foundation.sql`](../supabase/migrations/20261017090000_sync_foundation.sql), [`20261018090000_analysis_calendar.sql`](../supabase/migrations/20261018090000_analysis_calendar.sql), [`supabase/functions/_shared/handlers.ts`](../supabase/functions/_shared/handlers.ts). 클라이언트 구현: `packages/client-core/src/api.ts`.

| 논리 엔드포인트 | RPC | 상태 |
|---|---|---|
| POST /v1/meetings | `meeting_create(p_operation_id, p_id, p_title, p_body, p_meeting_at, p_time_zone)` | ✅ pgTAP |
| PATCH /v1/meetings/{id} | `meeting_patch(p_operation_id, p_id, p_base_version, p_patch)` | ✅ pgTAP |
| DELETE /v1/meetings/{id} | `meeting_delete(p_operation_id, p_id, p_base_version)` | ✅ pgTAP |
| GET /v1/sync/changes | `sync_changes(p_cursor, p_limit)` | ✅ pgTAP |
| GET /v1/sync/snapshot | `sync_snapshot(p_page_token, p_limit)` | ✅ pgTAP |
| GET /v1/meetings (검색) | 없음. 현재는 `GET /rest/v1/meetings` RLS 읽기만 가능 | Phase 2 |
| POST /v1/analysis/jobs (‘분석 실행’·‘재분석’) | `analysis_request(p_operation_id, p_meeting_id, p_source_revision_id, p_mode)` mode = initial / rerun | ✅ pgTAP |
| POST /v1/analysis/jobs/{id}/retry (‘재시도’) | `analysis_retry(p_operation_id, p_job_id)` | ✅ pgTAP |
| POST /v1/analysis/claim | `analysis_claim(p_device_id, p_job_id?)` → job + lease_token + 원문 스냅샷 / null | ✅ pgTAP |
| POST …/heartbeat · /result · /failure | `analysis_heartbeat`, `analysis_submit_result`, `analysis_submit_failure` | ✅ pgTAP |
| 회의록 분석 화면 조회 | `meeting_analysis_state(p_meeting_id)` → job, latest_result, notes, candidates(payload_hash·stale·등록 상태) | ✅ pgTAP |
| PATCH /v1/meetings/{id}/notes | `meeting_notes_patch(p_operation_id, p_meeting_id, p_base_version, p_patch)` | ✅ pgTAP |
| POST /v1/meetings/{id}/notes/apply-result | `meeting_notes_apply_result(p_operation_id, p_meeting_id, p_base_version, p_result_id, p_fields)` | ✅ pgTAP |
| PATCH /v1/event-candidates/{id} | `candidate_patch(p_operation_id, p_id, p_base_version, p_patch)` — 승인 무효화 | ✅ pgTAP |
| 후보 거절 | `candidate_reject(p_operation_id, p_id, p_base_version)` | ✅ pgTAP |
| POST /v1/event-candidates/{id}/approve (‘승인하고 캘린더 등록’) | Edge Function `calendar-register` { operation_id, candidate_id, base_version, payload_hash } → 내부에서 `candidate_approve`(사용자 JWT) 후 등록 | ✅ vitest·통합 |
| POST /v1/calendar/jobs/{id}/retry (‘재시도’) | Edge Function `calendar-retry` { operation_id, job_id } | ✅ vitest |
| POST /v1/google/connect | Edge Function `google-oauth-start` { return_path } → { url } | ✅ vitest |
| GET /v1/google/callback | Edge Function `google-oauth-callback` (JWT 검사 없음, 일회용 state) | ✅ vitest·통합 |
| DELETE /v1/google/connection | Edge Function `google-disconnect` | ✅ vitest |
| Google 연결 상태 | `google_connection_status()` (토큰 없음) | ✅ pgTAP |

서버 전용(`service_role`만 실행): `svc_oauth_state_create`, `svc_oauth_state_consume`, `svc_oauth_connection_save/get/set_status`, `svc_calendar_job_claim/complete/fail`. 사용자 JWT로 호출하면 42501로 거절된다(pgTAP R02).

## 수동 실행 규칙 (ADR 0003)

- 분석 작업은 `analysis_request`·`analysis_retry`로만 생긴다. 회의록당 대기·실행 중 작업은 하나이고, 이미 있으면 `deduplicated: true`와 함께 그 작업을 돌려준다.
- 실패한 작업은 `failed` + `error_code`로 남는다. 서버는 자동으로 다시 대기시키지 않는다. 오류 코드 문구: `packages/contracts/src/views.ts`의 `JOB_ERROR_MESSAGES`.
- `candidate_approve`는 화면에 보인 `version`·`payload_hash`가 현재 후보와 같아야 한다. 같은 내용으로 이미 승인했으면 기존 승인을 돌려준다.
- `calendar-register` 응답: `{ approval_id, calendar_job_id, status: "succeeded" | "running" | "failed", error_code?, html_link? }`. Google 설정이 없으면 승인 전에 503.

## 공통 규칙

- `p_operation_id`가 `Idempotency-Key` 역할을 한다. 같은 키·같은 요청이면 저장된 응답을 그대로 돌려주고, 같은 키·다른 요청이면 409 `IDEMPOTENCY_KEY_REUSED`. 성공 응답만 영수증으로 저장한다(실패는 다시 보내도 같은 실패가 난다).
- 생성 ID는 클라이언트가 만든 UUID다. 소유자·version·revision_id·시각은 서버가 정한다.
- `meeting_at`은 오프셋을 포함한 RFC 3339(`2026-10-16T10:00:00+09:00`)만 받는다. `time_zone`은 IANA 이름만 받는다. `meeting_local_date`는 서버가 계산한다.
- `p_patch`에 허용되는 키는 `title`, `body`, `meeting_at`, `time_zone`이고 값은 문자열이다.
- 삭제는 tombstone이다. `deleted_at`이 채워지고 version이 1 오른다.
- `meetings`, `meeting_revisions` 테이블은 `GET /rest/v1/...`로 본인 행만 읽을 수 있다. 직접 INSERT/UPDATE/DELETE는 403이다.

## 오류 응답

PostgREST가 HTTP 상태를 정하고 본문은 아래 형태다. `details`는 JSON 문자열이며 없으면 null이다. 클라이언트는 `@meeting/client-core`의 `toApiError(status, body, requestId)`로 계약 `ApiError`로 바꾼다.

```json
// 409 (2026-10-17 로컬 PostgREST 16.4 실제 응답)
{
  "code": "VERSION_CONFLICT",
  "details": "{\"current_version\": 1, \"current_revision_id\": \"4937e641-...\"}",
  "hint": null,
  "message": "다른 기기에서 수정되었습니다."
}
```

| HTTP | code | 상황 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 필드 누락·형식 오류, 허용되지 않은 patch 키, 잘못된·미래 커서 |
| 401 | `UNAUTHENTICATED` | JWT 없음. anon 키만으로 RPC 호출 시 PostgREST가 401(42501)을 준다 |
| 404 | `NOT_FOUND` | 없거나 다른 사용자 소유 (둘을 구분하지 않는다) |
| 409 | `VERSION_CONFLICT` | `base_version` 불일치. details에 현재 version·revision_id |
| 409 | `ENTITY_DELETED` | tombstone 대상 수정·삭제. details에 현재 version |
| 409 | `ALREADY_EXISTS` | 생성 ID 중복 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 같은 operation_id·다른 요청 |
| 410 | `CURSOR_EXPIRED` | 정리된 구간의 커서. 전체 재동기화 필요 |
| 409 | `STALE_SOURCE` | 회의록 revision이 바뀌어 실행·승인·적용 불가 |
| 409 | `PAYLOAD_CHANGED` | 확인한 후보 내용(hash)과 현재 후보가 다름 |
| 409 | `CANDIDATE_LOCKED` | 등록 중·등록 완료 후보 수정·거절 |
| 409 | `GOOGLE_AUTH_REQUIRED` | Google 미연결 상태에서 승인 |
| 409 | `JOB_IN_PROGRESS` / `INVALID_STATE` | 진행 중 작업 / 허용되지 않는 상태 전이(예: 완료 작업 재시도) |
| 409 | `LEASE_EXPIRED` | 분석 리스 만료·다른 토큰 |
| 413 | `PAYLOAD_TOO_LARGE` | 본문 1,000,000바이트 초과 |
| 503 | `SERVICE_UNAVAILABLE` | Edge Function에 Google 비밀이 설정되지 않음 |

## 동기화 응답

```json
// sync_changes
{
  "changes": [
    {"seq": 1, "entity_type": "meeting", "entity_id": "…", "entity_version": 1,
     "operation": "upsert", "payload": { /* 전체 서버 사본 */ }},
    {"seq": 3, "operation": "delete", "payload": {"id": "…", "version": 3, "revision_id": "…",
     "updated_at": "…", "deleted_at": "…"}}
  ],
  "next_cursor": "v1.3",
  "has_more": false,
  "snapshot_upper_bound": "v1.3"
}

// sync_snapshot
{"items": [/* tombstone 포함 전체 사본, id 순 */], "has_more": false,
 "next_page_token": null, "cursor": "v1.3"}
```

- 커서는 불투명 문자열로 취급한다. 형식(`v1.<seq>`)에 의존하지 않는다.
- seq는 사용자별 카운터 행 잠금으로 할당하므로 커밋된 feed에는 빈틈이 없다(S09 테스트).
- 첫 동기화나 410을 받으면 `sync_snapshot`을 끝까지 읽은 뒤 첫 페이지의 `cursor`로 `sync_changes`를 이어 읽는다. 스냅샷을 읽는 동안 바뀐 엔터티가 다시 오므로 엔터티별로 더 큰 version만 적용한다. 전체 재동기화 전에 미전송 편집을 따로 보존한다.
- feed 정리는 `app_private.prune_change_feed(interval)`로 한다. 보존 기간(90일 제안)과 실행 스케줄은 미정이다.
