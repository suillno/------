-- Phase 1 데이터 기반: meetings, meeting_revisions, change_feed, 사용자별 seq 카운터, operation_receipts.
-- 설계 근거: docs/design.md 6·7·8·11·12장.
--
-- 원칙
-- * 클라이언트(authenticated)는 meetings / meeting_revisions를 RLS로 읽기만 한다.
-- * 쓰기는 아래 SECURITY DEFINER RPC로만 한다. RPC가 인증, 멱등 영수증, 버전 검사,
--   revision, change feed를 하나의 트랜잭션에서 처리한다.
-- * change feed seq는 사용자별 카운터 행을 잠근 뒤 할당한다. 같은 사용자의 쓰기 트랜잭션은
--   카운터 행에서 직렬화되므로 커밋된 seq는 항상 빈틈없는 접두사가 된다.
--   일반 sequence의 증가 순서를 커밋 순서로 가정하지 않는다.
-- * 오류는 PostgREST의 sqlstate 'PGRST'로 올려 HTTP 상태와 본문 code를 지정한다.

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- ───────────────────────── 테이블 ─────────────────────────

create table public.meetings (
  id                  uuid primary key,
  user_id             uuid not null references auth.users (id) on delete cascade,
  title               text not null check (char_length(title) between 1 and 300),
  body                text not null check (octet_length(body) <= 1000000),
  meeting_at          timestamptz not null,
  -- 회의 현지 날짜. meeting_at을 time_zone으로 환산한 값이며 RPC가 계산한다.
  meeting_local_date  date not null,
  time_zone           text not null,
  version             integer not null check (version >= 1),
  revision_id         uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (id, user_id)
);

create index meetings_user_updated_idx on public.meetings (user_id, updated_at desc);
create index meetings_user_local_date_idx on public.meetings (user_id, meeting_local_date desc);

create table public.meeting_revisions (
  id                  uuid primary key,
  meeting_id          uuid not null,
  user_id             uuid not null,
  version             integer not null check (version >= 1),
  immutable_snapshot  jsonb not null,
  body_hash           text not null,
  created_at          timestamptz not null default now(),
  unique (meeting_id, version),
  unique (id, meeting_id, user_id),
  -- 다른 사용자의 회의에 revision을 연결할 수 없도록 복합 FK로 소유권을 고정한다.
  foreign key (meeting_id, user_id) references public.meetings (id, user_id) on delete cascade
);

-- meetings.revision_id는 항상 같은 회의·사용자의 실제 revision을 가리킨다.
-- RPC가 meetings 행을 먼저 쓰고 revision을 나중에 쓰므로 커밋 시점에 검사한다.
alter table public.meetings
  add constraint meetings_current_revision_fk
  foreign key (revision_id, id, user_id)
  references public.meeting_revisions (id, meeting_id, user_id)
  deferrable initially deferred;

create table app_private.user_change_counters (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  last_seq            bigint not null default 0 check (last_seq >= 0),
  -- 이 seq 이하의 feed는 정리되었다. 이보다 작은 커서는 410 CURSOR_EXPIRED.
  pruned_through_seq  bigint not null default 0 check (pruned_through_seq >= 0)
);

create table app_private.change_feed (
  user_id         uuid not null references auth.users (id) on delete cascade,
  seq             bigint not null check (seq >= 1),
  entity_type     text not null check (entity_type in ('meeting')),
  entity_id       uuid not null,
  entity_version  integer not null,
  operation       text not null check (operation in ('upsert', 'delete')),
  -- upsert는 전체 서버 사본, delete는 tombstone(id, version, revision_id, deleted_at)
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, seq)
);

create index change_feed_created_idx on app_private.change_feed (created_at);

create table app_private.operation_receipts (
  user_id           uuid not null references auth.users (id) on delete cascade,
  operation_id      uuid not null,
  request_hash      text not null,
  response_status   integer not null,
  response_payload  jsonb not null,
  created_at        timestamptz not null default now(),
  primary key (user_id, operation_id)
);

create index operation_receipts_created_idx on app_private.operation_receipts (created_at);

-- ───────────────────────── 권한·RLS ─────────────────────────

alter table public.meetings enable row level security;
alter table public.meeting_revisions enable row level security;
alter table app_private.user_change_counters enable row level security;
alter table app_private.change_feed enable row level security;
alter table app_private.operation_receipts enable row level security;

-- Supabase 기본 권한(anon/authenticated에 ALL)을 회수하고 읽기만 다시 부여한다.
revoke all on table public.meetings, public.meeting_revisions from public, anon, authenticated;
grant select on table public.meetings, public.meeting_revisions to authenticated;
revoke all on all tables in schema app_private from public, anon, authenticated;

create policy meetings_read on public.meetings
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy meeting_revisions_read on public.meeting_revisions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ───────────────────────── 내부 함수 ─────────────────────────

-- API 오류. PostgREST는 message(JSON)를 응답 본문으로, detail의 status를 HTTP 상태로 쓴다.
-- code는 packages/contracts/src/errors.ts와 같은 이름을 쓴다.
-- PostgREST는 details에 문자열만 받으므로 추가 정보(current_version 등)는 JSON 문자열로 넣는다.
create function app_private.api_error(
  p_code text, p_status integer, p_message text, p_details jsonb default '{}'::jsonb
) returns void
language plpgsql
set search_path = ''
as $$
begin
  raise sqlstate 'PGRST' using
    message = jsonb_strip_nulls(jsonb_build_object(
      'code', p_code, 'message', p_message,
      'details', case when p_details = '{}'::jsonb then null else p_details::text end
    ))::text,
    detail = jsonb_build_object('status', p_status, 'headers', '{}'::jsonb)::text;
end;
$$;

create function app_private.require_uid() returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app_private.api_error('UNAUTHENTICATED', 401, '로그인이 필요합니다.');
  end if;
  return v_uid;
end;
$$;

-- 요청 내용 해시. jsonb 텍스트 표현은 키 순서가 정규화되어 있다.
create function app_private.request_hash(p_operation text, p_args jsonb) returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_operation || ':' || p_args::text, 'UTF8')), 'hex');
$$;

-- 멱등 영수증 확인. 같은 키·같은 요청이면 저장된 응답을, 같은 키·다른 요청이면 409.
-- 처음 보는 키면 null을 돌려준다. 같은 키의 동시 요청은 advisory lock으로 직렬화한다.
create function app_private.receipt_begin(p_uid uuid, p_operation_id uuid, p_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_hash text;
  v_payload jsonb;
begin
  if p_operation_id is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'operation_id가 필요합니다.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_uid::text || ':' || p_operation_id::text, 0));

  select request_hash, response_payload into v_hash, v_payload
  from app_private.operation_receipts
  where user_id = p_uid and operation_id = p_operation_id;

  if not found then
    return null;
  end if;
  if v_hash <> p_hash then
    perform app_private.api_error('IDEMPOTENCY_KEY_REUSED', 409,
      '같은 operation_id로 다른 요청을 보냈습니다.');
  end if;
  return v_payload;
end;
$$;

create function app_private.receipt_store(
  p_uid uuid, p_operation_id uuid, p_hash text, p_status integer, p_payload jsonb
) returns void
language sql
set search_path = ''
as $$
  insert into app_private.operation_receipts
    (user_id, operation_id, request_hash, response_status, response_payload)
  values (p_uid, p_operation_id, p_hash, p_status, p_payload);
$$;

-- 사용자 카운터 행을 잠그고 다음 seq를 받아 change feed에 기록한다.
-- 카운터 행 잠금은 트랜잭션 끝까지 유지되므로 같은 사용자의 seq 할당·커밋 순서가 일치한다.
create function app_private.append_change(
  p_uid uuid, p_entity_type text, p_entity_id uuid, p_entity_version integer,
  p_operation text, p_payload jsonb
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  insert into app_private.user_change_counters as c (user_id, last_seq)
  values (p_uid, 1)
  on conflict (user_id) do update set last_seq = c.last_seq + 1
  returning c.last_seq into v_seq;

  insert into app_private.change_feed
    (user_id, seq, entity_type, entity_id, entity_version, operation, payload)
  values (p_uid, v_seq, p_entity_type, p_entity_id, p_entity_version, p_operation, p_payload);

  return v_seq;
end;
$$;

create function app_private.meeting_json(m public.meetings) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select to_jsonb(m) - 'user_id';
$$;

create function app_private.meeting_tombstone(m public.meetings) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'version', m.version, 'revision_id', m.revision_id,
    'updated_at', m.updated_at, 'deleted_at', m.deleted_at
  );
$$;

create function app_private.record_meeting_revision(m public.meetings) returns void
language sql
set search_path = ''
as $$
  insert into public.meeting_revisions
    (id, meeting_id, user_id, version, immutable_snapshot, body_hash)
  values (
    m.revision_id, m.id, m.user_id, m.version,
    jsonb_build_object(
      'title', m.title, 'body', m.body, 'meeting_at', m.meeting_at,
      'meeting_local_date', m.meeting_local_date, 'time_zone', m.time_zone,
      'deleted_at', m.deleted_at
    ),
    encode(sha256(convert_to(m.body, 'UTF8')), 'hex')
  );
$$;

-- 오프셋이 있는 RFC 3339 시각만 허용한다. 오프셋 없는 값은 세션 시간대로 해석되어 모호하다.
create function app_private.parse_instant(p_value text) returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null
     or p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' then
    perform app_private.api_error('VALIDATION_FAILED', 400,
      'meeting_at은 오프셋을 포함한 RFC 3339 시각이어야 합니다.');
  end if;
  return p_value::timestamptz;
exception
  when invalid_datetime_format or datetime_field_overflow then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'meeting_at 값이 올바르지 않습니다.');
end;
$$;

create function app_private.validate_meeting_fields(p_title text, p_body text, p_time_zone text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_title is null or char_length(p_title) < 1 or char_length(p_title) > 300 then
    perform app_private.api_error('VALIDATION_FAILED', 400, '제목은 1~300자여야 합니다.');
  end if;
  if p_body is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, '본문이 필요합니다.');
  end if;
  if octet_length(p_body) > 1000000 then
    perform app_private.api_error('PAYLOAD_TOO_LARGE', 413, '본문이 너무 큽니다.');
  end if;
  -- 약어(KST)나 POSIX 문자열이 아닌 IANA 이름만 허용한다.
  if p_time_zone is null
     or p_time_zone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$'
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'time_zone은 IANA 시간대 이름이어야 합니다.');
  end if;
end;
$$;

-- patch/delete 대상 잠금. 존재하지 않음(다른 사용자 소유 포함) / 삭제됨 / 버전 충돌을 구분한다.
create function app_private.lock_meeting_for_write(p_uid uuid, p_id uuid, p_base_version integer)
returns public.meetings
language plpgsql
set search_path = ''
as $$
declare
  v_row public.meetings;
begin
  if p_id is null or p_base_version is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'id와 base_version이 필요합니다.');
  end if;

  select * into v_row from public.meetings
  where id = p_id and user_id = p_uid
  for update;

  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '회의록을 찾을 수 없습니다.');
  end if;
  if v_row.deleted_at is not null then
    perform app_private.api_error('ENTITY_DELETED', 409, '삭제된 회의록입니다.',
      jsonb_build_object('current_version', v_row.version, 'current_revision_id', v_row.revision_id));
  end if;
  if v_row.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
      jsonb_build_object('current_version', v_row.version, 'current_revision_id', v_row.revision_id));
  end if;
  return v_row;
end;
$$;

create function app_private.decode_cursor(p_cursor text) returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_cursor is null then
    return 0;
  end if;
  if p_cursor !~ '^v1\.\d{1,18}$' then
    perform app_private.api_error('VALIDATION_FAILED', 400, '커서 형식이 올바르지 않습니다.');
  end if;
  return substr(p_cursor, 4)::bigint;
end;
$$;

create function app_private.encode_cursor(p_seq bigint) returns text
language sql
immutable
set search_path = ''
as $$
  select 'v1.' || p_seq::text;
$$;

-- 보존 기간이 지난 change feed를 지운다. 운영 스케줄러(service role)에서 호출한다.
-- 보존 기간 값은 미확정(로드맵)이며 호출하는 쪽이 정한다.
create function app_private.prune_change_feed(p_older_than interval) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_count bigint;
begin
  with deleted as (
    delete from app_private.change_feed
    where created_at < now() - p_older_than
    returning user_id, seq
  ), per_user as (
    select user_id, max(seq) as max_seq, count(*) as n from deleted group by user_id
  ), updated as (
    update app_private.user_change_counters c
    set pruned_through_seq = greatest(c.pruned_through_seq, p.max_seq)
    from per_user p
    where c.user_id = p.user_id
    returning p.n
  )
  select coalesce(sum(n), 0) into v_count from updated;
  return v_count;
end;
$$;

revoke all on all functions in schema app_private from public, anon, authenticated;

-- ───────────────────────── 공개 RPC (POST /rest/v1/rpc/...) ─────────────────────────

create function public.meeting_create(
  p_operation_id uuid,
  p_id uuid,
  p_title text,
  p_body text,
  p_meeting_at text,
  p_time_zone text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_at timestamptz;
  v_row public.meetings;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('meeting.create', jsonb_build_object(
    'id', p_id, 'title', p_title, 'body', p_body,
    'meeting_at', p_meeting_at, 'time_zone', p_time_zone));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_id is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'id가 필요합니다.');
  end if;
  perform app_private.validate_meeting_fields(p_title, p_body, p_time_zone);
  v_at := app_private.parse_instant(p_meeting_at);

  -- 다른 사용자의 ID인지 여부를 구분해 노출하지 않는다.
  if exists (select 1 from public.meetings where id = p_id) then
    perform app_private.api_error('ALREADY_EXISTS', 409, '이미 사용 중인 ID입니다.');
  end if;

  insert into public.meetings
    (id, user_id, title, body, meeting_at, meeting_local_date, time_zone, version, revision_id)
  values
    (p_id, v_uid, p_title, p_body, v_at, (v_at at time zone p_time_zone)::date, p_time_zone,
     1, gen_random_uuid())
  returning * into v_row;

  perform app_private.record_meeting_revision(v_row);
  v_resp := app_private.meeting_json(v_row);
  perform app_private.append_change(v_uid, 'meeting', v_row.id, v_row.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 201, v_resp);
  return v_resp;
end;
$$;

-- p_patch 허용 키: title, body, meeting_at, time_zone. 서버 관리 필드는 받지 않는다.
create function public.meeting_patch(
  p_operation_id uuid,
  p_id uuid,
  p_base_version integer,
  p_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_row public.meetings;
  v_title text;
  v_body text;
  v_tz text;
  v_at timestamptz;
  v_key text;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('meeting.patch', jsonb_build_object(
    'id', p_id, 'base_version', p_base_version, 'patch', p_patch));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '변경할 필드가 필요합니다.');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('title', 'body', 'meeting_at', 'time_zone') then
      perform app_private.api_error('VALIDATION_FAILED', 400, '수정할 수 없는 필드입니다.',
        jsonb_build_object('field', v_key));
    end if;
    if jsonb_typeof(p_patch -> v_key) <> 'string' then
      perform app_private.api_error('VALIDATION_FAILED', 400, '필드 값은 문자열이어야 합니다.',
        jsonb_build_object('field', v_key));
    end if;
  end loop;

  v_row := app_private.lock_meeting_for_write(v_uid, p_id, p_base_version);

  v_title := coalesce(p_patch ->> 'title', v_row.title);
  v_body := coalesce(p_patch ->> 'body', v_row.body);
  v_tz := coalesce(p_patch ->> 'time_zone', v_row.time_zone);
  perform app_private.validate_meeting_fields(v_title, v_body, v_tz);
  if p_patch ? 'meeting_at' then
    v_at := app_private.parse_instant(p_patch ->> 'meeting_at');
  else
    v_at := v_row.meeting_at;
  end if;

  update public.meetings
  set title = v_title,
      body = v_body,
      meeting_at = v_at,
      meeting_local_date = (v_at at time zone v_tz)::date,
      time_zone = v_tz,
      version = version + 1,
      revision_id = gen_random_uuid(),
      updated_at = now()
  where id = v_row.id and user_id = v_uid and version = p_base_version and deleted_at is null
  returning * into v_row;

  perform app_private.record_meeting_revision(v_row);
  v_resp := app_private.meeting_json(v_row);
  perform app_private.append_change(v_uid, 'meeting', v_row.id, v_row.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- tombstone + 새 version. 삭제도 revision을 남겨 version과 revision이 1:1로 대응한다.
create function public.meeting_delete(
  p_operation_id uuid,
  p_id uuid,
  p_base_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_row public.meetings;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('meeting.delete', jsonb_build_object(
    'id', p_id, 'base_version', p_base_version));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_row := app_private.lock_meeting_for_write(v_uid, p_id, p_base_version);

  update public.meetings
  set version = version + 1,
      revision_id = gen_random_uuid(),
      updated_at = now(),
      deleted_at = now()
  where id = v_row.id and user_id = v_uid and version = p_base_version and deleted_at is null
  returning * into v_row;

  perform app_private.record_meeting_revision(v_row);
  v_resp := app_private.meeting_tombstone(v_row);
  perform app_private.append_change(v_uid, 'meeting', v_row.id, v_row.version, 'delete', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- GET /v1/sync/changes. STABLE 함수 안의 조회는 같은 스냅샷을 보므로 카운터와 feed가 일관된다.
create function public.sync_changes(p_cursor text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_after bigint;
  v_last bigint := 0;
  v_pruned bigint := 0;
  v_changes jsonb;
  v_count integer;
  v_next bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'limit은 1~200이어야 합니다.');
  end if;
  v_after := app_private.decode_cursor(p_cursor);

  select last_seq, pruned_through_seq into v_last, v_pruned
  from app_private.user_change_counters where user_id = v_uid;
  v_last := coalesce(v_last, 0);
  v_pruned := coalesce(v_pruned, 0);

  if v_after < v_pruned then
    perform app_private.api_error('CURSOR_EXPIRED', 410, '전체 재동기화가 필요합니다.');
  end if;
  if v_after > v_last then
    perform app_private.api_error('VALIDATION_FAILED', 400, '알 수 없는 커서입니다.');
  end if;

  select coalesce(jsonb_agg(c order by c.seq), '[]'::jsonb), count(*), max(c.seq)
  into v_changes, v_count, v_next
  from (
    select seq, entity_type, entity_id, entity_version, operation, payload
    from app_private.change_feed
    where user_id = v_uid and seq > v_after
    order by seq
    limit p_limit + 1
  ) c;

  if v_count > p_limit then
    v_changes := v_changes - p_limit;  -- 초과 확인용 마지막 1건 제거
    v_next := (v_changes -> (p_limit - 1) ->> 'seq')::bigint;
  end if;

  return jsonb_build_object(
    'changes', v_changes,
    'next_cursor', app_private.encode_cursor(coalesce(v_next, v_after)),
    'has_more', v_count > p_limit,
    'snapshot_upper_bound', app_private.encode_cursor(v_last)
  );
end;
$$;

-- GET /v1/sync/snapshot. 첫 페이지에서 받은 cursor는 스냅샷 시작 시점의 seq다.
-- 페이지를 읽는 동안 바뀐 엔터티는 이후 sync_changes(cursor)로 다시 받는다.
-- 클라이언트는 엔터티별로 더 큰 version만 적용하므로 중복 적용해도 안전하다.
-- tombstone(deleted_at이 있는 행)도 포함한다.
create function public.sync_snapshot(p_page_token text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_cursor_seq bigint;
  v_after_id uuid;
  v_items jsonb;
  v_count integer;
  v_last_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'limit은 1~200이어야 합니다.');
  end if;

  if p_page_token is null then
    select last_seq into v_cursor_seq
    from app_private.user_change_counters where user_id = v_uid;
    v_cursor_seq := coalesce(v_cursor_seq, 0);
  elsif p_page_token ~ '^v1\.\d{1,18}\.[0-9a-f-]{36}$' then
    v_cursor_seq := split_part(p_page_token, '.', 2)::bigint;
    v_after_id := split_part(p_page_token, '.', 3)::uuid;
  else
    perform app_private.api_error('VALIDATION_FAILED', 400, 'page_token 형식이 올바르지 않습니다.');
  end if;

  select coalesce(jsonb_agg(app_private.meeting_json(m) order by m.id), '[]'::jsonb), count(*)
  into v_items, v_count
  from (
    select * from public.meetings
    where user_id = v_uid and (v_after_id is null or id > v_after_id)
    order by id
    limit p_limit + 1
  ) m;

  if v_count > p_limit then
    v_items := v_items - p_limit;
  end if;
  v_last_id := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'id')::uuid;

  return jsonb_build_object(
    'items', v_items,
    'has_more', v_count > p_limit,
    'next_page_token', case when v_count > p_limit
      then 'v1.' || v_cursor_seq::text || '.' || v_last_id::text end,
    'cursor', app_private.encode_cursor(v_cursor_seq)
  );
end;
$$;

-- 공개 RPC는 로그인 사용자만 실행한다(기본 PUBLIC/anon 실행 권한 회수).
revoke all on function public.meeting_create(uuid, uuid, text, text, text, text) from public, anon;
revoke all on function public.meeting_patch(uuid, uuid, integer, jsonb) from public, anon;
revoke all on function public.meeting_delete(uuid, uuid, integer) from public, anon;
revoke all on function public.sync_changes(text, integer) from public, anon;
revoke all on function public.sync_snapshot(text, integer) from public, anon;
grant execute on function public.meeting_create(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.meeting_patch(uuid, uuid, integer, jsonb) to authenticated;
grant execute on function public.meeting_delete(uuid, uuid, integer) to authenticated;
grant execute on function public.sync_changes(text, integer) to authenticated;
grant execute on function public.sync_snapshot(text, integer) to authenticated;
