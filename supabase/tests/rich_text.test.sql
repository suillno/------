-- 2026-10-20 서식 표시·편집: 분석 기준 revision(C), 편집본 저장 한도(L), 글자색 팔레트(S).
-- docs/plans/2026-10-20-rich-text.md 10장. ‘서식만 바뀜’ 판정 자체는 Edge Function(공유 변환 코드)이 하므로
-- 여기서는 그 판정값(p_analysis_changed)을 받은 뒤의 서버 동작을 검사한다.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'e1@test.invalid');

select '{"schema_version":2,"summary":"요약","decisions":["결정"],"action_items":[],
  "event_candidates":[
    {"title":"리뷰","start_local":"2026-10-21T15:00","end_local":"2026-10-21T16:00","time_zone":"Asia/Seoul",
     "all_day":false,"evidence":"수요일 3시","needs_confirmation":false,"location":null,"location_uncertain":false}]}' as p2,
  '{"engine_version":"test","prompt_version":"meeting-analysis/v2","input_hash":"h"}' as meta
\gset

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated"}', true);

-- ───────── S: 글자색 팔레트 ─────────
select throws_like(
  $q$ select public.meeting_create(gen_random_uuid(), gen_random_uuid(), '색', '<span style="color:#123456">x</span>',
       '2026-10-20T10:00:00+09:00', 'Asia/Seoul') $q$,
  '%허용하지 않는 글자색%', 'S04 팔레트 밖 글자색은 본문 저장을 거절한다');

select public.meeting_create(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', '서식 회의',
  '**원문** <span style="color:#c92a2a">본문</span>', '2026-10-20T10:00:00+09:00', 'Asia/Seoul') as m1
\gset
select is((:'m1'::jsonb) ->> 'analysis_revision_id', (:'m1'::jsonb) ->> 'revision_id', 'C 새 회의는 분석 기준 revision = 현재 revision');
select (:'m1'::jsonb) ->> 'revision_id' as rev1
\gset

-- 분석 완료 → 후보 1건
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', :'rev1', 'initial') ->> 'id' as job1
\gset
select r ->> 'lease_token' as tok1 from public.analysis_claim('pc-e', :'job1') r
\gset
select public.analysis_submit_result(:'job1', :'tok1', :'rev1', :'p2', :'meta');

-- 같은 회의에 대기 중 작업(재분석)도 하나 둔다
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', :'rev1', 'rerun', '짧게') ->> 'id' as job2
\gset

-- ───────── C04: 서버 판정 경로는 사용자 JWT로 실행할 수 없다 ─────────
select throws_ok(
  format($f$ select public.svc_meeting_patch(%L, gen_random_uuid(), %L, 1, '{"body":"x"}', %L, false) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :'rev1'),
  '42501', null, 'C04 사용자 JWT로 svc_meeting_patch를 실행할 수 없다');
select throws_ok(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, 1, '{"summary":"x"}', 1, null) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1'),
  '42501', null, 'C04 사용자 JWT로 svc_meeting_notes_patch를 실행할 수 없다');

-- ───────── C01: 서식만 변경(서버 판정 analysis_changed=false) ─────────
reset role;
set local role service_role;
select public.svc_meeting_patch('aaaaaaaa-0000-4000-8000-0000000000e1', gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', 1,
  '{"body":"<u>원문</u> **본문**"}', :'rev1', false) as m2
\gset
select is(((:'m2'::jsonb) ->> 'version')::int, 2, 'C01 서식만 바꿔도 version은 오른다(충돌 검사용)');
select isnt((:'m2'::jsonb) ->> 'revision_id', :'rev1', 'C01 새 revision(이력)이 생긴다');
select is((:'m2'::jsonb) ->> 'analysis_revision_id', :'rev1', 'C01 분석 기준 revision은 그대로');
select is((select immutable_snapshot ->> 'body' from public.meeting_revisions where id = :'rev1'),
  '**원문** <span style="color:#c92a2a">본문</span>', 'C01 분석 당시 원문 스냅샷을 보존한다');

select throws_like(
  format($f$ select public.svc_meeting_patch(%L, gen_random_uuid(), %L, 2, '{"body":"y"}', gen_random_uuid(), false) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1'),
  '%"VERSION_CONFLICT"%', 'C01 판정에 쓴 분석 기준이 그 사이 바뀌었으면 충돌로 거절한다');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated"}', true);

select public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000e1') as st
\gset
select is((:'st'::jsonb) -> 'latest_result' ->> 'stale', 'false', 'C01 완료 결과는 원문 변경이 아니다');
select is((:'st'::jsonb) -> 'candidates' -> 0 ->> 'stale', 'false', 'C01 미등록 후보는 그대로 승인 가능');
select is((:'st'::jsonb) -> 'notes' ->> 'based_on_current_revision', 'true', 'C01 편집본도 현재 기준');
select is((:'st'::jsonb) -> 'meeting' ->> 'analysis_revision_id', :'rev1', 'C01 화면이 분석 기준 revision을 받는다');
select is((select (s ->> 'stale') from jsonb_array_elements(public.meeting_summaries()) s), 'false', 'C01 요약 목록도 최신 기준');

-- 대기 중 작업은 그대로 실행되고 결과도 최신 기준이다
select r ->> 'lease_token' as tok2, r -> 'input' ->> 'body' as body2 from public.analysis_claim('pc-e', :'job2') r
\gset
select isnt(:'tok2'::text, '', 'C01 대기 중 분석은 서식 편집 후에도 실행된다');
select is(:'body2'::text, '**원문** <span style="color:#c92a2a">본문</span>', 'C01 분석은 분석 기준 원문으로 한다');
select is(public.analysis_submit_result(:'job2', :'tok2', :'rev1', :'p2', :'meta') ->> 'stale', 'false',
  'C01 실행 중 분석 결과도 원문 변경이 아니다');

-- 이전 버전 앱은 현재 revision을 보낸다 → 받되 작업에는 분석 기준 revision을 기록한다
select public.analysis_request(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', ((:'m2'::jsonb) ->> 'revision_id')::uuid, 'rerun') ->> 'source_revision_id' as job3_src
\gset
select is(:'job3_src'::text, :'rev1', 'C01 현재 revision으로 요청해도 분석 기준 revision으로 기록한다');

-- ───────── C02: 실제 텍스트 변경 ─────────
-- 사용자 경로 meeting_patch는 항상 원문 변경(서버 판정 우회 불가)
select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', 2, '{"body":"<u>원문</u> **본문**"}') as m3
\gset
select is((:'m3'::jsonb) ->> 'analysis_revision_id', (:'m3'::jsonb) ->> 'revision_id', 'C02 사용자 경로 저장은 항상 원문 변경');
select is(public.meeting_analysis_state('cccccccc-0000-4000-8000-0000000000e1') -> 'candidates' -> 0 ->> 'stale', 'true',
  'C02 원문 변경 후 기존 후보는 승인할 수 없다');

reset role;
set local role service_role;
select public.svc_meeting_patch('aaaaaaaa-0000-4000-8000-0000000000e1', gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1', 3,
  '{"title":"제목 변경"}', ((:'m3'::jsonb) ->> 'analysis_revision_id')::uuid, true) as m4
\gset
select is((:'m4'::jsonb) ->> 'analysis_revision_id', (:'m4'::jsonb) ->> 'revision_id', 'C02 서버가 변경으로 판정하면 새 분석 기준');

-- ───────── L: 편집본 저장 한도 ─────────
select version as nv from public.meeting_notes where meeting_id = 'cccccccc-0000-4000-8000-0000000000e1'
\gset
select is((public.svc_meeting_notes_patch('aaaaaaaa-0000-4000-8000-0000000000e1', gen_random_uuid(), 'cccccccc-0000-4000-8000-0000000000e1',
  :nv, json_build_object('summary', repeat('가', 12000))::jsonb, 4000, null) ->> 'version')::int, :nv + 1,
  'L01 보이는 글자 4000·서식 포함 12000자는 저장한다');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, 4001, null) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1, '{"summary":"x"}'),
  '%보이는 글자 4000자%', 'L01 보이는 글자 4001자는 거절한다');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, 10, null) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1,
    json_build_object('summary', repeat('가', 12001))),
  '%"VALIDATION_FAILED"%', 'L01 서식 포함 12001자는 거절한다');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, null, '{1}') $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1, '{"decisions":["a","b"]}'),
  '%글자 수 정보가 맞지 않습니다%', 'L 결정사항 글자 수 정보 개수가 다르면 거절한다');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, null, '{1}') $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1,
    json_build_object('decisions', json_build_array(repeat('가', 3001)))),
  '%"VALIDATION_FAILED"%', 'L 결정사항 항목은 서식 포함 3000자까지');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, null, '{1001}') $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1, '{"decisions":["x"]}'),
  '%보이는 글자 1000자%', 'L 결정사항 항목은 보이는 글자 1000자까지');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, 1, null) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv + 1,
    '{"summary":"<span style=\"color:#000001\">x</span>"}'),
  '%허용하지 않는 글자색%', 'S04 편집본도 팔레트 밖 글자색을 거절한다');
select throws_like(
  format($f$ select public.svc_meeting_notes_patch(%L, gen_random_uuid(), %L, %s, %L, 1, null) $f$,
    'aaaaaaaa-0000-4000-8000-0000000000e1', 'cccccccc-0000-4000-8000-0000000000e1', :nv, '{"summary":"x"}'),
  '%"VERSION_CONFLICT"%', 'E01 편집본 base version이 다르면 충돌');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
select throws_like(
  format($f$ select public.meeting_notes_patch(gen_random_uuid(), %L, %s, %L) $f$,
    'cccccccc-0000-4000-8000-0000000000e1', :nv + 1, json_build_object('summary', repeat('가', 4001))),
  '%"VALIDATION_FAILED"%', 'L 사용자 경로는 지금 한도(4000자)를 유지한다');

-- ───────── 요약 목록: 편집본 우선 (20261020100000) ─────────
select is((select s ->> 'summary' from jsonb_array_elements(public.meeting_summaries()) s), repeat('가', 12000),
  'S 요약 목록은 편집본 요약 전체를 돌려준다(AI 원본보다 우선)');
select is((select (s ->> 'has_user_notes')::boolean from jsonb_array_elements(public.meeting_summaries()) s), true,
  'S 편집본 있음 표시');

select * from finish();
rollback;
