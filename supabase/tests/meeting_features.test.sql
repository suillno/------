-- 2026-10-19 기능: 영구 삭제(D), 추가 요청사항(I), 목적지(L), 요약 목록(S), 원본 링크용 meeting_id(O).
-- docs/plans/2026-10-19-meeting-features.md 9장.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create function pg_temp.cand_hash(p_id uuid) returns text language sql as $$
  select x ->> 'payload_hash'
  from public.event_candidates c,
       jsonb_array_elements(public.meeting_analysis_state(c.meeting_id) -> 'candidates') x
  where c.id = p_id and x ->> 'id' = p_id::text
$$;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'f1@test.invalid'),
  ('bbbbbbbb-0000-4000-8000-0000000000f2', 'f2@test.invalid');

select '{"schema_version":2,"summary":"요약 v2","decisions":["결정"],"action_items":[],
  "event_candidates":[
    {"title":"강사 미팅","start_local":"2026-10-19T19:00","end_local":"2026-10-19T20:00","time_zone":"Asia/Seoul",
     "all_day":false,"evidence":"월요일 오후 7시 교대역","needs_confirmation":false,"location":"교대역","location_uncertain":false},
    {"title":"후속 회의","start_local":"2026-10-21T10:00","end_local":"2026-10-21T11:00","time_zone":"Asia/Seoul",
     "all_day":false,"evidence":"강남이나 판교 어딘가","needs_confirmation":false,"location":"강남","location_uncertain":true},
    {"title":"온라인 점검","start_local":"2026-10-22T09:00","end_local":"2026-10-22T09:30","time_zone":"Asia/Seoul",
     "all_day":false,"evidence":"목요일 9시 점검","needs_confirmation":false,"location":null,"location_uncertain":false}]}' as p2,
  '{"engine_version":"test","prompt_version":"meeting-analysis/v2","input_hash":"h"}' as meta
\gset

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated"}', true);

select public.meeting_create(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1', '강사 미팅 회의', '원문 본문 비밀X',
  '2026-10-18T10:00:00+09:00', 'Asia/Seoul') ->> 'revision_id' as rev
\gset

-- ───────── I: 추가 요청사항 ─────────
select throws_like(
  format($f$ select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1', %L, 'initial', %L) $f$,
    :'rev', repeat('가', 2001)),
  '%"VALIDATION_FAILED"%', 'I 요청사항 2000자 초과는 거절한다');
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1', :'rev', 'initial',
  '  장소가 나오면 꼭 표시해 줘  ') ->> 'id' as job
\gset
select is((select user_instructions from public.analysis_jobs where id = :'job'), '장소가 나오면 꼭 표시해 줘',
  'I02 요청사항을 작업(분석 이력)에 보관한다(앞뒤 공백 정리)');
select r -> 'input' ->> 'user_instructions' as claimed_instr, r -> 'input' ->> 'body' as claimed_body, r ->> 'lease_token' as tok
from public.analysis_claim('pc-f') r
\gset
select is(:'claimed_instr'::text, '장소가 나오면 꼭 표시해 줘', 'I02 claim은 요청사항을 따로 준다');
select is(:'claimed_body'::text, '원문 본문 비밀X', 'I02 원문은 body로 따로 준다');
select is(public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000f1') -> 'job' ->> 'user_instructions',
  '장소가 나오면 꼭 표시해 줘', 'I03 화면은 직전 요청사항을 읽을 수 있다');
select is((select config_hash from public.analysis_jobs where id = :'job'), 'meeting-analysis/v2', '새 분석은 v2 구성');

-- ───────── L: schema v2 목적지 ─────────
select throws_like(
  format($f$ select public.analysis_submit_result(%L, %L, %L, %L, %L) $f$, :'job', :'tok', :'rev',
    replace(:'p2', '"location":null,"location_uncertain":false', '"location":null'), :'meta'),
  '%"VALIDATION_FAILED"%', 'L v2 후보에 location_uncertain이 빠지면 거절한다');
select throws_like(
  format($f$ select public.analysis_submit_result(%L, %L, %L, %L, %L) $f$, :'job', :'tok', :'rev',
    replace(:'p2', '"schema_version":2', '"schema_version":1'), :'meta'),
  '%"VALIDATION_FAILED"%', 'L v1 결과에는 location을 넣을 수 없다');
select is(public.analysis_submit_result(:'job', :'tok', :'rev', :'p2', :'meta') ->> 'candidate_count', '3', 'v2 결과를 받는다');
select is((select schema_version from public.analysis_results where job_id = :'job'), 2, '결과의 schema_version을 기록한다');

select c.id as c_loc, c.version as c_loc_v from public.event_candidates c where c.meeting_id = 'cccccccc-0000-4000-8000-0000000000f1' and c.item_index = 0
\gset
select c.id as c_unc, c.version as c_unc_v from public.event_candidates c where c.meeting_id = 'cccccccc-0000-4000-8000-0000000000f1' and c.item_index = 1
\gset
select c.id as c_none from public.event_candidates c where c.meeting_id = 'cccccccc-0000-4000-8000-0000000000f1' and c.item_index = 2
\gset
select is((select payload ->> 'location' from public.event_candidates where id = :'c_loc'), '교대역', 'L02 원문의 목적지를 보관한다');
select is((select payload -> 'location' from public.event_candidates where id = :'c_none'), 'null'::jsonb, 'L01 목적지 없는 일정은 null');

reset role;
insert into app_private.oauth_connections (user_id, provider, scopes, refresh_token_ciphertext, status)
values ('aaaaaaaa-0000-4000-8000-0000000000f1', 'google', '{calendar.events.owned}', 'ciphertext', 'active');
set local role authenticated;

select throws_like(
  format($f$ select public.candidate_approve(gen_random_uuid(), %L, %s, %L) $f$, :'c_unc', :'c_unc_v', pg_temp.cand_hash(:'c_unc')),
  '%목적지를 확인%', 'L03 목적지가 불명확하면 승인을 거절한다');
select is(public.candidate_patch(gen_random_uuid(), :'c_unc', :'c_unc_v', '{"location":"  판교역  "}') -> 'payload' ->> 'location_uncertain',
  'false', 'L 사용자가 목적지를 확인·수정하면 확인 필요를 내린다');
select is((select payload ->> 'location' from public.event_candidates where id = :'c_unc'), '판교역', '목적지 앞뒤 공백 정리');
select is(public.candidate_patch(gen_random_uuid(), :'c_unc', (select version from public.event_candidates where id = :'c_unc'),
  '{"location":""}') -> 'payload' -> 'location', 'null'::jsonb, 'L 빈 목적지는 삭제(null)로 저장한다');
select throws_like(
  format($f$ select public.candidate_patch(gen_random_uuid(), %L, %s, %L) $f$, :'c_loc', :'c_loc_v', json_build_object('location', repeat('가', 201))),
  '%"VALIDATION_FAILED"%', '목적지는 200자 이하');

select r -> 'calendar_job' ->> 'id' as cjob, r ->> 'approval_id' as appr
from public.candidate_approve(gen_random_uuid(), :'c_loc', :'c_loc_v', pg_temp.cand_hash(:'c_loc')) r
\gset
select is((select payload_snapshot ->> 'location' from public.event_approvals where id = :'appr'), '교대역', 'L02 승인 snapshot에 목적지가 고정된다');

-- O: 등록 처리기는 원본 링크용 meeting_id를 받는다
reset role;
set local role service_role;
select is(public.svc_calendar_job_claim('aaaaaaaa-0000-4000-8000-0000000000f1', :'cjob') ->> 'meeting_id',
  'cccccccc-0000-4000-8000-0000000000f1', 'O 등록 처리기에 회의 UUID를 준다');

-- ───────── D04: 등록 진행 중에는 삭제 거절 ─────────
reset role;
set local role authenticated;
select throws_like(
  $$ select public.meeting_purge(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1',
       (select version from public.meetings where id = 'cccccccc-0000-4000-8000-0000000000f1')) $$,
  '%"JOB_IN_PROGRESS"%', 'D04 캘린더 등록 중에는 삭제하지 않는다');

reset role;
-- 등록 완료 상태로 만든다(테스트용 직접 조작)
update public.calendar_jobs set status = 'succeeded', lease_until = null where id = :'cjob';
insert into public.calendar_links (approval_id, candidate_id, user_id, calendar_id, google_event_id, html_link)
values (:'appr', :'c_loc', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'primary', 'evt1', 'https://calendar.test/e');
update public.event_candidates set status = 'registered' where id = :'c_loc';
set local role authenticated;

-- ───────── S: 요약 목록 ─────────
select is(jsonb_array_length(public.meeting_summaries()), 1, 'S01 분석 결과가 있는 회의만 목록에 나온다');
select public.meeting_create(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f2', '분석 안 한 회의', '본문',
  '2026-10-18T11:00:00+09:00', 'Asia/Seoul') is not null as _x
\gset
select is(jsonb_array_length(public.meeting_summaries()), 1, 'S 결과 없는 회의는 제외한다');
select is(public.meeting_summaries() -> 0 ->> 'summary_preview', '요약 v2', 'S 요약 미리보기');
select is(public.meeting_summaries() -> 0 ->> 'stale', 'false', 'S 최신 원문 기준');
select is(public.meeting_summaries() -> 0 ->> 'has_user_notes', 'true', 'S 편집본 존재 표시');
select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1',
  (select version from public.meetings where id = 'cccccccc-0000-4000-8000-0000000000f1'), '{"body":"수정된 본문"}') is not null as _y
\gset
select is(public.meeting_summaries() -> 0 ->> 'stale', 'true', 'S03 원문이 바뀌면 이전 원문 기준으로 표시한다');

-- ───────── D06: 다른 사용자 ─────────
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000f2","role":"authenticated"}', true);
select throws_like($$ select public.meeting_purge(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1', 1) $$,
  '%"NOT_FOUND"%', 'D06 남의 회의는 삭제할 수 없다');
select is(jsonb_array_length(public.meeting_summaries()), 0, 'S 남의 요약은 보이지 않는다');

-- ───────── D02·D03: 영구 삭제 ─────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
select throws_like($$ select public.meeting_purge(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000f1', 1) $$,
  '%"VERSION_CONFLICT"%', 'D 오래된 화면으로 삭제하면 다시 확인하게 한다');
select (select version from public.meetings where id = 'cccccccc-0000-4000-8000-0000000000f1') as mver
\gset
select public.meeting_purge('d0000000-0000-4000-8000-0000000000f9', 'cccccccc-0000-4000-8000-0000000000f1', :mver) as purged
\gset
select is((:'purged'::jsonb) ->> 'registered_events_kept', '1', 'D03 Google에 등록된 일정 수를 알려준다(일정은 유지)');
select is(public.meeting_purge('d0000000-0000-4000-8000-0000000000f9', 'cccccccc-0000-4000-8000-0000000000f1', :mver),
  :'purged'::jsonb, 'D 같은 operation_id 재전송은 같은 응답');
select is((select count(*)::int from public.meetings where id = 'cccccccc-0000-4000-8000-0000000000f1'), 0, 'D02 회의록이 지워진다');

reset role;
select is((select count(*)::int from public.meeting_revisions where meeting_id = 'cccccccc-0000-4000-8000-0000000000f1')
  + (select count(*)::int from public.analysis_jobs where meeting_id = 'cccccccc-0000-4000-8000-0000000000f1')
  + (select count(*)::int from public.analysis_results where meeting_id = 'cccccccc-0000-4000-8000-0000000000f1')
  + (select count(*)::int from public.meeting_notes where meeting_id = 'cccccccc-0000-4000-8000-0000000000f1')
  + (select count(*)::int from public.event_candidates where meeting_id = 'cccccccc-0000-4000-8000-0000000000f1')
  + (select count(*)::int from public.event_approvals where id = :'appr')
  + (select count(*)::int from public.calendar_jobs where id = :'cjob')
  + (select count(*)::int from public.calendar_links where approval_id = :'appr'), 0,
  'D02 원문 이력·분석 작업·결과·편집본·후보·승인·등록 작업·링크가 모두 지워진다');
select is((select count(*)::int from app_private.change_feed
           where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1' and payload::text like '%원문 본문 비밀X%'), 0,
  'D02 변경 기록에 지운 회의 본문이 남지 않는다');
select is((select count(*)::int from app_private.operation_receipts
           where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1' and response_payload::text like '%원문 본문 비밀X%'), 0,
  'D02 영수증에 지운 회의 본문이 남지 않는다');
select is((select operation from app_private.change_feed where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1'
           order by seq desc limit 1), 'purge', 'D 다른 기기가 받을 purge 기록을 남긴다');
select is((select count(*)::int from public.meetings where id = 'cccccccc-0000-4000-8000-0000000000f2'), 1, '다른 회의는 남는다');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated"}', true);
select is(jsonb_array_length(public.meeting_summaries()), 0, 'S04 삭제된 회의는 요약 목록에서 사라진다');
select throws_like($$ select public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000f1') $$,
  '%"NOT_FOUND"%', 'O03 삭제된 회의를 열면 NOT_FOUND(안내 화면)');

select * from finish();
rollback;
