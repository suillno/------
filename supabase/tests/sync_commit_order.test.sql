-- S09: 서버 트랜잭션 커밋 순서 경합에서 change feed 누락이 없는지 확인한다.
-- 두 번째·세 번째 연결이 필요해 dblink로 같은 DB에 접속한다(로컬 전용).
-- 접속 정보는 Supabase CLI 로컬 DB의 공개 기본값이며 비밀값이 아니다. 원격 DB에서는 실행하지 않는다.
-- 컨테이너 루프백은 trust 인증이라 dblink가 거부하므로 테스트 세션이 접속한 서버 주소(scram)로 연결한다.
-- dblink 연결은 별도 트랜잭션이므로 전용 사용자 데이터를 커밋했다가 마지막에 삭제한다.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select plan(5);

select extensions.dblink_connect('c1', format('host=%s port=5432 dbname=postgres user=postgres password=postgres', host(inet_server_addr())));
select extensions.dblink_connect('c2', format('host=%s port=5432 dbname=postgres user=postgres password=postgres', host(inet_server_addr())));

-- 이전 실행이 중간에 실패했다면 남은 데이터를 지운다.
select extensions.dblink_exec('c1',
  $$ delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000009' $$);
select extensions.dblink_exec('c1',
  $$ insert into auth.users (id, email) values ('dddddddd-0000-4000-8000-000000000009', 's09@test.invalid') $$);

-- c1: 트랜잭션을 열고 회의록을 만든 뒤 커밋하지 않는다(seq 1과 카운터 행 잠금을 보유).
select extensions.dblink_exec('c1', $$ begin $$);
select extensions.dblink_exec('c1', $$ set local role authenticated $$);
select * from extensions.dblink('c1', $$ select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-4000-8000-000000000009","role":"authenticated"}', true) $$) as t(r text);
select * from extensions.dblink('c1', $$ select public.meeting_create(gen_random_uuid(),
  'eeeeeeee-0000-4000-8000-000000000001', 'c1 먼저 시작', 'b',
  '2026-10-16T10:00:00+09:00', 'Asia/Seoul')::text $$) as t(r text);

-- c2: 같은 사용자의 다른 쓰기를 비동기로 보낸다. 카운터 행 잠금에서 기다려야 한다.
select extensions.dblink_send_query('c2', $$
  begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"dddddddd-0000-4000-8000-000000000009","role":"authenticated"}', true);
  select public.meeting_create(gen_random_uuid(), 'eeeeeeee-0000-4000-8000-000000000002',
    'c2 나중에 시작', 'b', '2026-10-16T11:00:00+09:00', 'Asia/Seoul');
  commit;
$$);
select pg_sleep(0.5);

select is(extensions.dblink_is_busy('c2'), 1,
  'S09 같은 사용자의 두 번째 쓰기는 첫 트랜잭션 커밋까지 seq 할당을 기다린다');
select is(
  (select count(*)::int from app_private.change_feed
   where user_id = 'dddddddd-0000-4000-8000-000000000009'),
  0, 'S09 커밋 전 변경은 다른 세션에 보이지 않는다');

select extensions.dblink_exec('c1', $$ commit $$);
select * from extensions.dblink_get_result('c2') as t(r text);
select * from extensions.dblink_get_result('c2') as t(r text);

select results_eq(
  $$ select seq, entity_id from app_private.change_feed
     where user_id = 'dddddddd-0000-4000-8000-000000000009' order by seq $$,
  $$ values (1::bigint, 'eeeeeeee-0000-4000-8000-000000000001'::uuid),
            (2::bigint, 'eeeeeeee-0000-4000-8000-000000000002'::uuid) $$,
  'S09 seq 순서가 커밋 순서와 같고 빈틈이 없다');
select is(
  (select last_seq from app_private.user_change_counters
   where user_id = 'dddddddd-0000-4000-8000-000000000009'),
  2::bigint, 'S09 카운터는 마지막 seq와 같다');

select extensions.dblink_exec('c1',
  $$ delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000009' $$);
select is(
  (select count(*)::int from public.meetings
   where user_id = 'dddddddd-0000-4000-8000-000000000009'),
  0, '테스트 사용자 데이터를 정리했다');

select extensions.dblink_disconnect('c1');
select extensions.dblink_disconnect('c2');

select * from finish();
rollback;
