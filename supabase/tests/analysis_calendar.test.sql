-- 수동 분석·재분석·재시도, 편집본 보호, 일정 후보 승인·무효화, 캘린더 등록 작업 상태.
-- docs/design.md 17장 A01~A04, E02, C01, C02, C06, R01, R02 및 AGENTS.md 수동 실행 규칙.
-- psql 변수(\gset)로 작업 ID·리스 토큰을 다음 단계에 넘긴다.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- 화면이 받는 후보별 payload_hash (meeting_analysis_state 응답에서 ID로 찾는다)
create function pg_temp.cand_hash(p_id uuid) returns text language sql as $$
  select x ->> 'payload_hash'
  from public.event_candidates c,
       jsonb_array_elements(public.meeting_analysis_state(c.meeting_id) -> 'candidates') x
  where c.id = p_id and x ->> 'id' = p_id::text
$$;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'a2@test.invalid'),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'b2@test.invalid');

select '{"schema_version":1,"summary":"요약1","decisions":["결정1"],
  "action_items":[{"text":"자료 공유","assignee":"이영희","due_date":"2026-10-23"}],
  "event_candidates":[
    {"title":"디자인 리뷰","start_local":"2026-10-20T15:00:00","end_local":"2026-10-20T16:00:00",
     "time_zone":"Asia/Seoul","all_day":false,"evidence":"다음 주 화요일 3시","needs_confirmation":false},
    {"title":"후속 회의","start_local":null,"end_local":null,"time_zone":"Asia/Seoul","all_day":false,
     "evidence":"다음 주에 다시","needs_confirmation":true}]}' as payload1,
  '{"schema_version":1,"summary":"요약2","decisions":["결정2"],"action_items":[],
  "event_candidates":[{"title":"재분석 후보","start_local":"2026-10-21","end_local":"2026-10-21",
     "time_zone":"Asia/Seoul","all_day":true,"evidence":"수요일 종일","needs_confirmation":false}]}' as payload2,
  '{"engine_version":"claude-code test","prompt_version":"meeting-analysis/v1","input_hash":"h"}' as meta
\gset

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

select public.meeting_create(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', '주간회의', '원문',
  '2026-10-16T10:00:00+09:00', 'Asia/Seoul') ->> 'revision_id' as rev1
\gset

-- ───────── 수동 실행 ─────────
select is((select count(*)::int from public.analysis_jobs), 0, '회의록 저장만으로 분석 작업이 생기지 않는다');

select public.analysis_request('d0000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-0000000000a1',
  :'rev1', 'initial') ->> 'id' as job1
\gset
select is((select status from public.analysis_jobs where id = :'job1'), 'queued', '분석 실행 버튼은 대기 작업을 만든다');
select is(
  (select r ->> 'id' || '/' || (r ->> 'deduplicated')
   from public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', :'rev1', 'initial') r),
  :'job1' || '/true', '중복 클릭(다른 operation_id)은 같은 작업을 돌려준다');
select is(
  public.analysis_request('d0000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-0000000000a1',
    :'rev1', 'initial') ->> 'id',
  :'job1', '같은 operation_id 재전송은 원래 응답을 돌려준다');
select is((select count(*)::int from public.analysis_jobs), 1, '중복 클릭해도 작업은 하나다');
select throws_like(
  format($f$ select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', %L, 'initial') $f$,
    gen_random_uuid()),
  '%"STALE_SOURCE"%', '화면의 revision이 최신이 아니면 실행을 거절한다');
select throws_like(
  format($f$ select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', %L, 'auto') $f$, :'rev1'),
  '%"VALIDATION_FAILED"%', 'mode는 initial/rerun만 허용한다');

-- ───────── claim / lease ─────────
select r -> 'job' ->> 'id' as claimed1, r ->> 'lease_token' as tok1, r -> 'input' ->> 'body' as input_body
from public.analysis_claim('pc-1') r
\gset
select is(:'claimed1'::text, :'job1', 'PC가 대기 작업을 가져간다');
select is(:'input_body'::text, '원문', 'claim은 원문 revision 스냅샷을 준다');
select is(public.analysis_claim('pc-2'), null, 'A01 다른 PC는 같은 작업을 가져가지 못한다');
select ok(public.analysis_heartbeat(:'job1', :'tok1') ? 'lease_until', 'heartbeat로 리스를 연장한다');
select throws_like(
  format($f$ select public.analysis_heartbeat(%L, 'wrong') $f$, :'job1'),
  '%"LEASE_EXPIRED"%', '다른 리스 토큰은 거절한다');
select throws_like(
  format($f$ select public.analysis_submit_result(%L, %L, %L, '{"schema_version":2}', %L) $f$,
    :'job1', :'tok1', :'rev1', :'meta'),
  '%"VALIDATION_FAILED"%', 'A04 schema가 다른 결과는 거절한다');

select public.analysis_submit_result(:'job1', :'tok1', :'rev1', :'payload1', :'meta') as submit1
\gset
select is((:'submit1'::jsonb) ->> 'note_created', 'true', '최초 분석은 편집본을 만든다');
select is((:'submit1'::jsonb) ->> 'candidate_count', '2', '일정 후보를 만든다');
select is(public.analysis_submit_result(:'job1', :'tok1', :'rev1', :'payload1', :'meta') ->> 'replayed', 'true',
  'A06 같은 리스로 다시 업로드하면 저장된 결과를 돌려준다');
select is((select count(*)::int from public.analysis_results), 1, '업로드 재시도로 결과가 중복되지 않는다');

-- ───────── 편집본 보호 (E02) ─────────
select is(public.meeting_notes_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', 1,
  '{"summary":"사용자 수정"}') ->> 'version', '2', '사용자가 요약을 수정한다');
select is(
  public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', :'rev1', 'initial') ->> 'id',
  :'job1', '분석 실행은 완료된 같은 원문 분석을 반복하지 않는다');

select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', :'rev1', 'rerun') ->> 'id' as job2
\gset
select is((select run_no from public.analysis_jobs where id = :'job2'), 2, '재분석 버튼은 새 실행을 만든다');
select r ->> 'lease_token' as tok2 from public.analysis_claim('pc-1', :'job2') r
\gset
select is(public.analysis_submit_result(:'job2', :'tok2', :'rev1', :'payload2', :'meta') ->> 'note_created', 'false',
  'E02 재분석은 편집본을 새로 만들지 않는다');
select is((select summary from public.meeting_notes), '사용자 수정', 'E02 재분석 결과가 사용자 편집을 덮어쓰지 않는다');
select is(
  public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a1') -> 'latest_result' -> 'payload' ->> 'summary',
  '요약2', '화면은 최신 AI 결과를 따로 보여준다');

select (select id from public.analysis_results where job_id = :'job2') as result2
\gset
select throws_like(
  format($f$ select public.meeting_notes_apply_result(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', 1, %L, '{summary}') $f$, :'result2'),
  '%"VERSION_CONFLICT"%', '새 결과 적용도 버전 검사를 한다');
select is(
  public.meeting_notes_apply_result(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', 2, :'result2', '{summary}')
    ->> 'summary',
  '요약2', '사용자가 고른 필드만 새 결과로 적용한다');
select is((select decisions from public.meeting_notes), '["결정1"]'::jsonb, '고르지 않은 필드는 유지한다');

-- ───────── 실패와 재시도 (자동 재실행 없음) ─────────
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', :'rev1', 'rerun') ->> 'id' as job3
\gset
select r ->> 'lease_token' as tok3 from public.analysis_claim('pc-1') r
\gset
select is(public.analysis_submit_failure(:'job3', :'tok3', 'RATE_LIMITED') ->> 'status', 'failed', '실패를 기록한다');
select is(public.analysis_claim('pc-1'), null, '실패한 작업은 자동으로 다시 실행되지 않는다');
select is(public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a1') -> 'job' ->> 'status', 'failed',
  '화면에 실패 상태를 보여준다');
select is(public.analysis_retry(gen_random_uuid(), :'job3') ->> 'status', 'queued', '재시도 버튼으로만 다시 대기한다');
select is(public.analysis_retry(gen_random_uuid(), :'job3') ->> 'deduplicated', 'true', '재시도 중복 클릭은 무시된다');
select throws_like(
  format($f$ select public.analysis_retry(gen_random_uuid(), %L) $f$, :'job1'),
  '%"INVALID_STATE"%', '완료된 작업은 재시도할 수 없다');

-- A02 리스 만료
select r ->> 'lease_token' as tok3b from public.analysis_claim('pc-1') r
\gset
reset role;
update public.analysis_jobs set lease_until = now() - interval '1 second' where id = :'job3';
set local role authenticated;
select throws_like(
  format($f$ select public.analysis_submit_result(%L, %L, %L, %L, %L) $f$, :'job3', :'tok3b', :'rev1', :'payload1', :'meta'),
  '%"LEASE_EXPIRED"%', 'A02 만료된 리스의 결과는 거절한다');
select is(
  public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a1') -> 'job' ->> 'error_code', 'LEASE_EXPIRED',
  'A02 리스 만료는 실패로 보인다');
select is(public.analysis_claim('pc-1'), null, 'A02 리스 만료 작업도 자동으로 다시 실행되지 않는다');

-- ───────── 일정 후보 승인 ─────────
select c.id as c1, c.version as c1v, pg_temp.cand_hash(c.id) as c1h
from public.event_candidates c join public.analysis_results r on r.id = c.result_id
where r.job_id = :'job1' and c.item_index = 0
\gset
select c.id as c2, c.version as c2v from public.event_candidates c join public.analysis_results r on r.id = c.result_id
where r.job_id = :'job1' and c.item_index = 1
\gset

select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, %L) $f$, :'c1', :'c1v', :'c1h'),
  '%"GOOGLE_AUTH_REQUIRED"%', 'Google 연결 없이는 승인·등록하지 않는다');
reset role;
insert into app_private.oauth_connections (user_id, provider, scopes, refresh_token_ciphertext, status)
values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'google', '{calendar.events.owned}', 'ciphertext', 'active');
set local role authenticated;

select is((select count(*)::int from public.calendar_jobs), 0, 'C01 연결만 하고 승인하지 않으면 등록 작업이 없다');
select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, 'other-hash') $f$, :'c1', :'c1v'),
  '%"PAYLOAD_CHANGED"%', '확인한 내용(hash)과 다르면 승인하지 않는다');
select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, %L) $f$,
    :'c2', :'c2v', pg_temp.cand_hash(:'c2')),
  '%"VALIDATION_FAILED"%', '날짜 미확정 후보는 승인할 수 없다');

select r ->> 'approval_id' as appr1, r -> 'calendar_job' ->> 'id' as cjob1
from public.candidate_approve(gen_random_uuid(), :'c1', :'c1v', :'c1h') r
\gset
select is((select status from public.event_candidates where id = :'c1'), 'approved', '승인 버튼으로 승인된다');
select is((select status from public.calendar_jobs where id = :'cjob1'), 'queued', '승인과 함께 등록 작업이 생긴다');
select is(
  (select r ->> 'approval_id' || '/' || (r ->> 'deduplicated')
   from public.candidate_approve(gen_random_uuid(), :'c1', :'c1v', :'c1h') r),
  :'appr1' || '/true', '승인 중복 클릭은 같은 승인을 돌려준다');
select is((select count(*)::int from public.event_approvals), 1, '중복 클릭해도 승인은 하나다');

-- C02 후보 수정 → 승인 무효화
select version as c1v2 from public.event_candidates where id = :'c1'
\gset
select is(
  public.candidate_patch(gen_random_uuid(), :'c1', :'c1v2', '{"title":"디자인 리뷰 (수정)"}') ->> 'status',
  'needs_review', 'C02 후보를 수정하면 다시 검토 상태가 된다');
select isnt((select revoked_at from public.event_approvals where id = :'appr1'), null, 'C02 이전 승인을 무효화한다');
select is((select status from public.calendar_jobs where id = :'cjob1'), 'cancelled', 'C02 이전 등록 작업을 취소한다');
select is((select content_version from public.event_candidates where id = :'c1'), 2, '내용 버전이 오른다');
select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, %L) $f$, :'c1', :'c1v', :'c1h'),
  '%"VERSION_CONFLICT"%', 'C02 수정 전 화면으로 승인하면 거절한다');

select version as c1v3, pg_temp.cand_hash(id) as c1h3 from public.event_candidates where id = :'c1'
\gset
select r -> 'calendar_job' ->> 'id' as cjob2 from public.candidate_approve(gen_random_uuid(), :'c1', :'c1v3', :'c1h3') r
\gset
select isnt(:'cjob2'::text, :'cjob1', '수정 후에는 새로 승인해야 새 등록 작업이 생긴다');

-- C06 존재하지 않는 시각
select is(public.candidate_patch(gen_random_uuid(), :'c2', :'c2v',
  '{"time_zone":"America/New_York","start_local":"2026-03-08T02:30","end_local":"2026-03-08T03:30"}') ->> 'needs_confirmation',
  null, '날짜를 고치면 payload가 갱신된다');
select is((select payload ->> 'needs_confirmation' from public.event_candidates where id = :'c2'), 'false',
  '사용자가 날짜를 고치면 확인 필요 표시를 내린다');
select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, %L) $f$, :'c2',
    (select version from public.event_candidates where id = :'c2'),
    pg_temp.cand_hash(:'c2')),
  '%"VALIDATION_FAILED"%', 'C06 일광 절약 시간 전환으로 없는 시각은 승인하지 않는다');
select throws_like(
  format($f$ select public.candidate_patch(gen_random_uuid(), %L, %s, '{"start_local":"2026-02-30T10:00"}') $f$, :'c2',
    (select version from public.event_candidates where id = :'c2')),
  '%"VALIDATION_FAILED"%', '존재하지 않는 날짜는 거절한다');

-- ───────── 서버 전용 함수 차단 (R02) ─────────
select throws_ok(format($f$ select public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000a1', %L) $f$, :'cjob2'),
  '42501', null, 'R02 사용자는 등록 워커 함수를 실행할 수 없다');
select throws_ok($$ select public.svc_oauth_connection_get('aaaaaaaa-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'R02 사용자는 토큰 암호문을 읽을 수 없다');
select throws_ok($$ select * from app_private.oauth_connections $$, '42501', null, 'R02 OAuth 연결 테이블을 직접 읽을 수 없다');
select throws_ok($$ select lease_token_hash from public.calendar_jobs $$, '42501', null, 'R02 리스 토큰 해시 열은 읽을 수 없다');
select throws_ok($$ insert into public.event_approvals (candidate_id, candidate_content_version, user_id, source_revision_id,
    payload_snapshot, payload_hash, calendar_id) values (gen_random_uuid(), 1, auth.uid(), gen_random_uuid(), '{}', 'h', 'primary') $$,
  '42501', null, 'R02 승인 레코드를 직접 만들 수 없다');
select is(public.google_connection_status() ->> 'connected', 'true', '연결 상태는 RPC로만 본다');
select ok(not (public.google_connection_status() ? 'refresh_token_ciphertext'), '연결 상태에 토큰이 없다');

-- ───────── 등록 작업 처리 (Edge Function이 service_role로 호출) ─────────
reset role;
set local role service_role;
select r ->> 'lease_token' as ctok, r ->> 'ok' as cok, r -> 'payload' ->> 'title' as ctitle
from public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000a1', :'cjob2') r
\gset
select is(:'cok'::text, 'true', '승인된 작업을 가져간다');
select is(:'ctitle'::text, '디자인 리뷰 (수정)', '승인한 snapshot을 그대로 보낸다');
select is(public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000a1', :'cjob2') ->> 'error_code', 'JOB_IN_PROGRESS',
  '진행 중인 등록은 중복 실행하지 않는다');
select is(public.svc_calendar_job_claim('bbbbbbbb-0000-4000-8000-0000000000b2', :'cjob2') ->> 'error_code', 'NOT_FOUND',
  '다른 사용자 작업은 처리하지 않는다');
reset role;
set local role authenticated;
select is((select status from public.event_candidates where id = :'c1'), 'registering', '등록 중 상태를 보여준다');
select throws_like(
  format($f$ select public.candidate_patch(gen_random_uuid(), %L, %s, '{"title":"x"}') $f$, :'c1',
    (select version from public.event_candidates where id = :'c1')),
  '%"CANDIDATE_LOCKED"%', '등록 중에는 후보를 수정할 수 없다');

reset role;
set local role service_role;
select is(public.svc_calendar_job_fail(:'cjob2', :'ctok', 'GOOGLE_ERROR', 'HTTP 500') ->> 'status', 'failed', '등록 실패를 기록한다');
reset role;
set local role authenticated;
select is((select status from public.event_candidates where id = :'c1'), 'failed', '후보에 실패를 표시한다');
select is(public.calendar_job_request_retry(gen_random_uuid(), :'cjob2') ->> 'status', 'queued', '재시도 버튼으로 다시 대기한다');

reset role;
set local role service_role;
select r ->> 'lease_token' as ctok2 from public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000a1', :'cjob2') r
\gset
select is(public.svc_calendar_job_complete(:'cjob2', :'ctok2', replace(:'cjob2', '-', ''), 'https://calendar.test/e', 'etag')
  ->> 'status', 'succeeded', '등록 완료를 기록한다');
select is(public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000a1', :'cjob2') ->> 'error_code', 'ALREADY_SUCCEEDED',
  '완료된 작업은 다시 등록하지 않는다');
reset role;
set local role authenticated;
select is((select status from public.event_candidates where id = :'c1'), 'registered', '후보가 등록 완료가 된다');
select is((select x -> 'link' ->> 'html_link'
  from jsonb_array_elements(public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a1') -> 'candidates') x
  where x ->> 'id' = :'c1'),
  'https://calendar.test/e', '등록 결과 링크를 보여준다');
select is(public.calendar_job_request_retry(gen_random_uuid(), :'cjob2') ->> 'deduplicated', 'true', '완료 후 재시도는 무시된다');

-- ───────── R01 교차 사용자 ─────────
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', :'rev1', 'rerun') ->> 'id' as job4
\gset
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
select throws_like(
  format($f$ select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a1', %L, 'rerun') $f$, :'rev1'),
  '%"NOT_FOUND"%', 'R01 B는 A의 회의록 분석을 요청할 수 없다');
select is(public.analysis_claim('pc-b'), null, 'R01 B의 PC는 A의 작업을 가져가지 못한다');
select throws_like($$ select public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a1') $$,
  '%"NOT_FOUND"%', 'R01 B는 A의 분석 상태를 볼 수 없다');
select throws_like(format($f$ select public.candidate_approve(gen_random_uuid(), %L, 1, 'h') $f$, :'c1'),
  '%"NOT_FOUND"%', 'R01 B는 A의 후보를 승인할 수 없다');
select throws_like(format($f$ select public.calendar_job_request_retry(gen_random_uuid(), %L) $f$, :'cjob2'),
  '%"NOT_FOUND"%', 'R01 B는 A의 등록 작업을 재시도할 수 없다');
select is((select count(*)::int from public.analysis_jobs) + (select count(*)::int from public.event_candidates), 0,
  'R01 B는 A의 작업·후보를 읽을 수 없다');
select is(public.google_connection_status() ->> 'connected', 'false', 'R01 B에게는 A의 Google 연결이 없다');

-- ───────── A03 분석 중 원문 변경 ─────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select public.meeting_create(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a2', '두 번째', '원문',
  '2026-10-16T10:00:00+09:00', 'Asia/Seoul') ->> 'revision_id' as m2rev1
\gset
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a2', :'m2rev1', 'initial') ->> 'id' as m2job
\gset
select r ->> 'lease_token' as m2tok from public.analysis_claim('pc-1', :'m2job') r
\gset
select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a2', 1, '{"body":"분석 중 수정"}') ->> 'revision_id' as m2rev2
\gset
select is(public.analysis_submit_result(:'m2job', :'m2tok', :'m2rev1', :'payload1', :'meta') ->> 'stale', 'true',
  'A03 분석 중 원문이 바뀌면 결과를 stale로 보관한다');
select is((select count(*)::int from public.event_candidates where meeting_id = 'cccccccc-0000-4000-8000-0000000000a2'), 0,
  'A03 stale 결과로는 일정 후보를 만들지 않는다');
select is((select count(*)::int from public.meeting_notes where meeting_id = 'cccccccc-0000-4000-8000-0000000000a2'), 0,
  'A03 stale 결과로는 편집본을 만들지 않는다');
select is(public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000a2') -> 'latest_result' ->> 'stale', 'true',
  'A03 화면에 이전 원문 기준임을 표시한다');

select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a2', :'m2rev2', 'rerun') ->> 'id' as m2job2
\gset
select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000a2', 2, '{"body":"다시 수정"}') is not null as _ignore
\gset
select is(public.analysis_claim('pc-1', :'m2job2'), null, '대기 중 원문이 바뀐 작업은 분석하지 않는다');
select is((select error_code from public.analysis_jobs where id = :'m2job2'), 'SOURCE_CHANGED', '원문 변경으로 실패를 표시한다');

select * from finish();
rollback;
