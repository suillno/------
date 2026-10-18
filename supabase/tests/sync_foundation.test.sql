-- Phase 1 데이터 기반 통합 테스트 (docs/design.md 17장 R01, R02, S03, S06, S08 일부).
-- 실행: npm run db:test
begin;
create extension if not exists pgtap with schema extensions;

select plan(38);

-- 테스트 사용자 A, B
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@test.invalid'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b@test.invalid');

-- ───────── R02: anon·authenticated 직접 조작 차단 ─────────
set local role anon;
select throws_ok(
  $$ select public.meeting_create(gen_random_uuid(), gen_random_uuid(), 't', 'b',
       '2026-10-16T10:00:00+09:00', 'Asia/Seoul') $$,
  '42501', null, 'R02 anon은 RPC를 실행할 수 없다');
select throws_ok($$ select * from public.meetings $$, '42501', null,
  'R02 anon은 meetings를 읽을 수 없다');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok(
  $$ insert into public.meetings (id, user_id, title, body, meeting_at, meeting_local_date,
       time_zone, version, revision_id)
     values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 't', 'b', now(),
       current_date, 'Asia/Seoul', 1, gen_random_uuid()) $$,
  '42501', null, 'R02 authenticated는 meetings에 직접 INSERT할 수 없다');
select throws_ok($$ update public.meetings set version = 99 $$, '42501', null,
  'R02 authenticated는 meetings를 직접 UPDATE할 수 없다');
select throws_ok($$ delete from public.meetings $$, '42501', null,
  'R02 authenticated는 meetings를 직접 DELETE할 수 없다');
select throws_ok($$ insert into public.meeting_revisions (id, meeting_id, user_id, version,
       immutable_snapshot, body_hash)
     values (gen_random_uuid(), gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 1,
       '{}', 'x') $$,
  '42501', null, 'R02 authenticated는 revision을 직접 만들 수 없다');
select throws_ok($$ select * from app_private.change_feed $$, '42501', null,
  'R02 authenticated는 change_feed를 직접 읽을 수 없다');
select throws_ok($$ select * from app_private.operation_receipts $$, '42501', null,
  'R02 authenticated는 영수증을 직접 읽을 수 없다');
select throws_ok(
  $$ select app_private.append_change('aaaaaaaa-0000-4000-8000-000000000001', 'meeting',
       gen_random_uuid(), 1, 'upsert', '{}') $$,
  '42501', null, 'R02 authenticated는 내부 함수를 실행할 수 없다');

-- ───────── 생성 ─────────
select is(
  (public.meeting_create('11111111-0000-4000-8000-000000000001',
     'cccccccc-0000-4000-8000-000000000001', '주간회의', '원문 v1',
     '2026-10-16T23:30:00Z', 'Asia/Seoul') ->> 'version')::int,
  1, '생성하면 version 1');
select is(
  (select meeting_local_date from public.meetings
   where id = 'cccccccc-0000-4000-8000-000000000001'),
  '2026-10-17'::date, '회의 현지 날짜는 time_zone 기준으로 계산한다');
select is(
  (select count(*)::int from public.meeting_revisions
   where meeting_id = 'cccccccc-0000-4000-8000-000000000001' and version = 1),
  1, '생성하면 revision 1이 생긴다');
select is(
  (select revision_id from public.meetings where id = 'cccccccc-0000-4000-8000-000000000001'),
  (select id from public.meeting_revisions
   where meeting_id = 'cccccccc-0000-4000-8000-000000000001' and version = 1),
  'meetings.revision_id는 현재 revision을 가리킨다');

-- 입력 검증
select throws_like(
  $$ select public.meeting_create(gen_random_uuid(), gen_random_uuid(), 't', 'b',
       '2026-10-16T10:00:00+09:00', 'KST') $$,
  '%"VALIDATION_FAILED"%', 'IANA 이름이 아닌 시간대는 거절한다');
select throws_like(
  $$ select public.meeting_create(gen_random_uuid(), gen_random_uuid(), 't', 'b',
       '2026-10-16T10:00:00', 'Asia/Seoul') $$,
  '%"VALIDATION_FAILED"%', '오프셋 없는 시각은 거절한다');
select throws_like(
  $$ select public.meeting_create(gen_random_uuid(), gen_random_uuid(), '', 'b',
       '2026-10-16T10:00:00+09:00', 'Asia/Seoul') $$,
  '%"VALIDATION_FAILED"%', '빈 제목은 거절한다');

-- ───────── R01: 교차 사용자 차단 ─────────
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.meetings where id = 'cccccccc-0000-4000-8000-000000000001'),
  0, 'R01 B는 A의 회의록을 읽을 수 없다');
select is(
  (select count(*)::int from public.meeting_revisions
   where meeting_id = 'cccccccc-0000-4000-8000-000000000001'),
  0, 'R01 B는 A의 revision을 읽을 수 없다');
select throws_like(
  $$ select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 1,
       '{"title":"탈취"}') $$,
  '%"NOT_FOUND"%', 'R01 B가 A의 회의록을 수정하면 NOT_FOUND');
select throws_like(
  $$ select public.meeting_delete(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 1) $$,
  '%"NOT_FOUND"%', 'R01 B가 A의 회의록을 삭제하면 NOT_FOUND');
select is(
  jsonb_array_length(public.sync_changes() -> 'changes'),
  0, 'R01 B의 change feed에 A의 변경이 없다');
select is(
  jsonb_array_length(public.sync_snapshot() -> 'items'),
  0, 'R01 B의 snapshot에 A의 회의록이 없다');

-- ───────── S06: 멱등 재시도 ─────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  (public.meeting_patch('22222222-0000-4000-8000-000000000001',
     'cccccccc-0000-4000-8000-000000000001', 1, '{"body":"원문 v2"}') ->> 'version')::int,
  2, '수정하면 version 2');
select is(
  (public.meeting_patch('22222222-0000-4000-8000-000000000001',
     'cccccccc-0000-4000-8000-000000000001', 1, '{"body":"원문 v2"}') ->> 'version')::int,
  2, 'S06 같은 operation_id 재시도는 원래 응답을 돌려준다');
select is(
  (select version from public.meetings where id = 'cccccccc-0000-4000-8000-000000000001'),
  2, 'S06 재시도해도 version은 한 번만 증가한다');
select throws_like(
  $$ select public.meeting_patch('22222222-0000-4000-8000-000000000001',
       'cccccccc-0000-4000-8000-000000000001', 1, '{"body":"다른 내용"}') $$,
  '%"IDEMPOTENCY_KEY_REUSED"%', 'S06 같은 키·다른 요청은 409');

-- ───────── S03: 동시 수정 충돌 ─────────
select throws_like(
  $$ select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 1,
       '{"body":"모바일 편집"}') $$,
  '%"VERSION_CONFLICT"%', 'S03 오래된 base_version은 409');
select is(
  (select body from public.meetings where id = 'cccccccc-0000-4000-8000-000000000001'),
  '원문 v2', 'S03 충돌한 요청은 서버 원문을 바꾸지 않는다');
select throws_like(
  $$ select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 2,
       '{"version":"99"}') $$,
  '%"VALIDATION_FAILED"%', 'R02 patch로 서버 관리 필드를 바꿀 수 없다');

-- ───────── 삭제 tombstone ─────────
select is(
  (public.meeting_delete('33333333-0000-4000-8000-000000000001',
     'cccccccc-0000-4000-8000-000000000001', 2) ->> 'version')::int,
  3, '삭제는 tombstone과 새 version을 만든다');
select throws_like(
  $$ select public.meeting_patch(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 3,
       '{"body":"오프라인 수정"}') $$,
  '%"ENTITY_DELETED"%', 'S05 삭제된 회의록 수정은 ENTITY_DELETED로 구분한다');
select results_eq(
  $$ select version from public.meeting_revisions
     where meeting_id = 'cccccccc-0000-4000-8000-000000000001' order by version $$,
  $$ values (1), (2), (3) $$,
  'version마다 불변 revision이 하나씩 있다');

-- ───────── change feed / snapshot ─────────
select is(
  (select jsonb_agg(jsonb_build_array(c -> 'seq', c -> 'operation', c -> 'entity_version'))
   from jsonb_array_elements(public.sync_changes() -> 'changes') c),
  '[[1,"upsert",1],[2,"upsert",2],[3,"delete",3]]'::jsonb,
  'feed는 생성·수정·삭제를 빈틈없는 seq로 기록하고 재시도·충돌은 기록하지 않는다');
select is(
  public.sync_changes(null, 2) - 'changes',
  '{"has_more":true,"next_cursor":"v1.2","snapshot_upper_bound":"v1.3"}'::jsonb,
  'limit보다 많으면 has_more와 다음 커서를 준다');
select is(
  public.sync_changes('v1.2', 2) - 'changes',
  '{"has_more":false,"next_cursor":"v1.3","snapshot_upper_bound":"v1.3"}'::jsonb,
  '다음 커서부터 나머지를 읽는다');
select throws_like($$ select public.sync_changes('v1.99') $$, '%"VALIDATION_FAILED"%',
  '아직 없는 커서는 거절한다');
select is(
  (select jsonb_build_object('cursor', s -> 'cursor',
     'deleted', (s -> 'items' -> 0 ->> 'deleted_at') is not null)
   from public.sync_snapshot() s),
  '{"cursor":"v1.3","deleted":true}'::jsonb,
  'snapshot은 tombstone을 포함하고 시작 시점 커서를 준다');

-- ───────── S08: 커서 만료 ─────────
reset role;
select app_private.prune_change_feed(interval '-1 second');
set local role authenticated;
select throws_like($$ select public.sync_changes('v1.0') $$, '%"CURSOR_EXPIRED"%',
  'S08 정리된 구간의 커서는 CURSOR_EXPIRED');

select * from finish();
rollback;
