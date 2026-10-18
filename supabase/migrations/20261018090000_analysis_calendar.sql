-- 수동 분석 실행·재분석, 편집본 보호, 일정 후보 검토·승인, Google OAuth 연결, 캘린더 등록 작업.
-- 설계 근거: docs/design.md 9·10·11장, docs/adr/0003-manual-execution.md.
--
-- 실행 원칙 (AGENTS.md 절대 규칙)
-- * 분석 작업은 사용자가 '분석 실행'·'재분석'·'재시도'를 눌러 analysis_request / analysis_retry를
--   호출할 때만 생긴다. 서버·에이전트가 실패 작업을 자동으로 다시 대기열에 넣지 않는다.
-- * 캘린더 등록 작업은 candidate_approve('승인하고 캘린더 등록')와 calendar_job_request_retry('재시도')로만
--   생기거나 다시 대기한다. 후보 내용이 바뀌면 승인을 무효화하고 대기 작업을 취소한다.
-- * 재분석 결과는 새 analysis_results로만 저장하고 meeting_notes를 바꾸지 않는다.
--   결과를 편집본에 넣으려면 meeting_notes_apply_result를 명시적으로 호출해야 한다.

-- ───────────────────────── change feed 엔터티 확장 ─────────────────────────

alter table app_private.change_feed drop constraint change_feed_entity_type_check;
alter table app_private.change_feed add constraint change_feed_entity_type_check
  check (entity_type in ('meeting', 'meeting_note', 'analysis_job', 'event_candidate'));

-- ───────────────────────── 테이블 ─────────────────────────

create table public.analysis_jobs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  meeting_id          uuid not null,
  source_revision_id  uuid not null,
  config_hash         text not null,
  -- 같은 원문·구성에서 '재분석'을 누를 때마다 1씩 오른다.
  run_no              integer not null check (run_no >= 1),
  status              text not null
                      check (status in ('queued', 'running', 'failed', 'completed', 'cancelled')),
  version             integer not null default 1 check (version >= 1),
  device_id           text,
  lease_token_hash    text,
  lease_until         timestamptz,
  attempt             integer not null default 0 check (attempt >= 0),
  error_code          text,
  -- 화면의 "최신 작업" 정렬 기준. 같은 트랜잭션에서도 순서가 갈리도록 clock_timestamp()를 쓴다.
  requested_at        timestamptz not null default clock_timestamp(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz not null default now(),
  unique (meeting_id, source_revision_id, config_hash, run_no),
  unique (id, user_id),
  foreign key (meeting_id, user_id) references public.meetings (id, user_id) on delete cascade,
  foreign key (source_revision_id, meeting_id, user_id)
    references public.meeting_revisions (id, meeting_id, user_id) on delete cascade
);

-- 회의록당 대기·실행 중 작업은 하나뿐이다(중복 클릭·여러 기기 요청 방지).
create unique index analysis_jobs_one_active_idx on public.analysis_jobs (meeting_id)
  where status in ('queued', 'running');
create index analysis_jobs_user_queue_idx on public.analysis_jobs (user_id, requested_at)
  where status = 'queued';

create table public.analysis_results (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null unique,
  user_id             uuid not null,
  meeting_id          uuid not null,
  source_revision_id  uuid not null,
  schema_version      integer not null,
  validated_payload   jsonb not null,
  engine_version      text not null,
  prompt_version      text not null,
  input_hash          text not null,
  -- 결과 업로드 시점에 원문 revision이 바뀌었으면 true. 최신 결과로 쓰지 않는다.
  stale               boolean not null,
  created_at          timestamptz not null default clock_timestamp(),
  unique (id, meeting_id, user_id),
  foreign key (job_id, user_id) references public.analysis_jobs (id, user_id) on delete cascade,
  foreign key (source_revision_id, meeting_id, user_id)
    references public.meeting_revisions (id, meeting_id, user_id) on delete cascade
);

create table public.meeting_notes (
  id                  uuid primary key default gen_random_uuid(),
  meeting_id          uuid not null unique,
  user_id             uuid not null,
  summary             text not null check (char_length(summary) <= 4000),
  decisions           jsonb not null check (jsonb_typeof(decisions) = 'array'),
  source_result_id    uuid,
  source_revision_id  uuid,
  version             integer not null check (version >= 1),
  revision_id         uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (id, user_id),
  foreign key (meeting_id, user_id) references public.meetings (id, user_id) on delete cascade,
  foreign key (source_result_id, meeting_id, user_id)
    references public.analysis_results (id, meeting_id, user_id)
);

create table public.meeting_note_revisions (
  id                  uuid primary key,
  note_id             uuid not null,
  user_id             uuid not null,
  version             integer not null,
  immutable_snapshot  jsonb not null,
  created_at          timestamptz not null default now(),
  unique (note_id, version),
  foreign key (note_id, user_id) references public.meeting_notes (id, user_id) on delete cascade
);

create table public.event_candidates (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  meeting_id          uuid not null,
  result_id           uuid not null,
  item_index          integer not null check (item_index >= 0),
  source_revision_id  uuid not null,
  -- version: 모든 변경(상태 포함)마다 증가, 동기화·낙관적 잠금용
  -- content_version: 사용자가 내용을 바꿀 때만 증가, 승인이 고정하는 값
  version             integer not null check (version >= 1),
  content_version     integer not null check (content_version >= 1),
  payload             jsonb not null,
  status              text not null check (status in
                      ('needs_review', 'approved', 'registering', 'registered', 'failed', 'rejected')),
  last_error_code     text,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (result_id, item_index),
  unique (id, user_id),
  foreign key (result_id, meeting_id, user_id)
    references public.analysis_results (id, meeting_id, user_id) on delete cascade
);

create index event_candidates_meeting_idx on public.event_candidates (user_id, meeting_id);

create table public.event_approvals (
  id                         uuid primary key default gen_random_uuid(),
  candidate_id               uuid not null,
  candidate_content_version  integer not null,
  user_id                    uuid not null,
  source_revision_id         uuid not null,
  payload_snapshot           jsonb not null,
  payload_hash               text not null,
  calendar_id                text not null,
  approved_at                timestamptz not null default now(),
  revoked_at                 timestamptz,
  unique (id, user_id),
  foreign key (candidate_id, user_id) references public.event_candidates (id, user_id) on delete cascade
);

-- 후보 내용 버전마다 유효한 승인은 하나뿐이다. 거절로 무효화된 승인 뒤에는 다시 승인할 수 있다.
create unique index event_approvals_active_idx on public.event_approvals (candidate_id, candidate_content_version)
  where revoked_at is null;

create table public.calendar_jobs (
  id                  uuid primary key default gen_random_uuid(),
  approval_id         uuid not null unique,
  candidate_id        uuid not null,
  user_id             uuid not null,
  status              text not null
                      check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  lease_token_hash    text,
  lease_until         timestamptz,
  attempts            integer not null default 0,
  last_error_code     text,
  last_error_message  text check (char_length(last_error_message) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, user_id),
  foreign key (approval_id, user_id) references public.event_approvals (id, user_id) on delete cascade
);

create table public.calendar_links (
  id               uuid primary key default gen_random_uuid(),
  approval_id      uuid not null unique,
  candidate_id     uuid not null,
  user_id          uuid not null,
  calendar_id      text not null,
  google_event_id  text not null,
  html_link        text,
  etag             text,
  external_state   text not null default 'created',
  created_at       timestamptz not null default now(),
  unique (user_id, calendar_id, google_event_id),
  foreign key (approval_id, user_id) references public.event_approvals (id, user_id) on delete cascade
);

-- 서버 전용. 클라이언트는 google_connection_status()로 상태만 본다.
create table app_private.oauth_connections (
  user_id                   uuid not null references auth.users (id) on delete cascade,
  provider                  text not null check (provider = 'google'),
  account_email             text,
  scopes                    text[] not null default '{}',
  -- AES-GCM 암호문(base64). 키는 Edge Function 비밀 TOKEN_ENCRYPTION_KEY에만 있다.
  refresh_token_ciphertext  text,
  status                    text not null check (status in ('active', 'auth_required', 'revoked')),
  connected_at              timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (user_id, provider)
);

create table app_private.oauth_states (
  state_hash     text primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null check (provider = 'google'),
  code_verifier  text not null,
  return_path    text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- ───────────────────────── 권한·RLS ─────────────────────────

alter table public.analysis_jobs enable row level security;
alter table public.analysis_results enable row level security;
alter table public.meeting_notes enable row level security;
alter table public.meeting_note_revisions enable row level security;
alter table public.event_candidates enable row level security;
alter table public.event_approvals enable row level security;
alter table public.calendar_jobs enable row level security;
alter table public.calendar_links enable row level security;
alter table app_private.oauth_connections enable row level security;
alter table app_private.oauth_states enable row level security;

revoke all on table
  public.analysis_jobs, public.analysis_results, public.meeting_notes, public.meeting_note_revisions,
  public.event_candidates, public.event_approvals, public.calendar_jobs, public.calendar_links
  from public, anon, authenticated;
revoke all on table app_private.oauth_connections, app_private.oauth_states
  from public, anon, authenticated;

-- lease_token_hash는 클라이언트가 읽을 필요가 없으므로 열 단위로 제외한다.
grant select (id, user_id, meeting_id, source_revision_id, config_hash, run_no, status, version,
  device_id, lease_until, attempt, error_code, requested_at, started_at, finished_at, updated_at)
  on public.analysis_jobs to authenticated;
grant select (id, approval_id, candidate_id, user_id, status, lease_until, attempts,
  last_error_code, last_error_message, created_at, updated_at)
  on public.calendar_jobs to authenticated;
grant select on table public.analysis_results, public.meeting_notes, public.meeting_note_revisions,
  public.event_candidates, public.event_approvals, public.calendar_links to authenticated;

create policy analysis_jobs_read on public.analysis_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy analysis_results_read on public.analysis_results for select to authenticated
  using ((select auth.uid()) = user_id);
create policy meeting_notes_read on public.meeting_notes for select to authenticated
  using ((select auth.uid()) = user_id);
create policy meeting_note_revisions_read on public.meeting_note_revisions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy event_candidates_read on public.event_candidates for select to authenticated
  using ((select auth.uid()) = user_id);
create policy event_approvals_read on public.event_approvals for select to authenticated
  using ((select auth.uid()) = user_id);
create policy calendar_jobs_read on public.calendar_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy calendar_links_read on public.calendar_links for select to authenticated
  using ((select auth.uid()) = user_id);

-- ───────────────────────── 내부 함수 ─────────────────────────

create function app_private.analysis_config_hash() returns text
language sql immutable set search_path = ''
as $$ select 'meeting-analysis/v1'::text $$;

create function app_private.sha256_hex(p_value text) returns text
language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(p_value, 'UTF8')), 'hex') $$;

create function app_private.new_token() returns text
language sql volatile set search_path = ''
as $$ select encode(extensions.gen_random_bytes(32), 'hex') $$;

create function app_private.is_time_zone(p_value text) returns boolean
language sql stable set search_path = ''
as $$
  select p_value is not null
     and p_value ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$'
     and exists (select 1 from pg_catalog.pg_timezone_names where name = p_value);
$$;

create function app_private.payload_hash(p_payload jsonb) returns text
language sql immutable set search_path = ''
as $$ select app_private.sha256_hex(p_payload::text) $$;

create function app_private.job_json(j public.analysis_jobs) returns jsonb
language sql immutable set search_path = ''
as $$ select to_jsonb(j) - 'user_id' - 'lease_token_hash' $$;

create function app_private.calendar_job_json(j public.calendar_jobs) returns jsonb
language sql immutable set search_path = ''
as $$ select to_jsonb(j) - 'user_id' - 'lease_token_hash' $$;

create function app_private.note_json(n public.meeting_notes) returns jsonb
language sql immutable set search_path = ''
as $$ select to_jsonb(n) - 'user_id' $$;

create function app_private.candidate_json(c public.event_candidates) returns jsonb
language sql immutable set search_path = ''
as $$ select (to_jsonb(c) - 'user_id') || jsonb_build_object('payload_hash', app_private.payload_hash(c.payload)) $$;

create function app_private.require_string(p_value jsonb, p_field text, p_min integer, p_max integer, p_nullable boolean)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    if p_nullable then return; end if;
    perform app_private.api_error('VALIDATION_FAILED', 400, '필수 값이 없습니다.', jsonb_build_object('field', p_field));
  end if;
  if jsonb_typeof(p_value) <> 'string'
     or char_length(p_value #>> '{}') < p_min or char_length(p_value #>> '{}') > p_max then
    perform app_private.api_error('VALIDATION_FAILED', 400, '문자열 값이 올바르지 않습니다.', jsonb_build_object('field', p_field));
  end if;
end;
$$;

create function app_private.require_keys(p_obj jsonb, p_allowed text[], p_field text) returns void
language plpgsql immutable set search_path = ''
as $$
declare
  v_key text;
begin
  if p_obj is null or jsonb_typeof(p_obj) <> 'object' then
    perform app_private.api_error('VALIDATION_FAILED', 400, '객체가 필요합니다.', jsonb_build_object('field', p_field));
  end if;
  for v_key in select jsonb_object_keys(p_obj) loop
    if not v_key = any (p_allowed) then
      perform app_private.api_error('VALIDATION_FAILED', 400, '허용되지 않은 필드입니다.',
        jsonb_build_object('field', p_field || '.' || v_key));
    end if;
  end loop;
end;
$$;

-- 일정 후보 시각 형식. 종일은 YYYY-MM-DD, 시간 지정은 YYYY-MM-DDTHH:MM[:SS] (time_zone 기준 현지 시각).
create function app_private.validate_candidate_shape(p jsonb, p_field text) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_all_day boolean;
  v_key text;
  v_pattern text;
begin
  perform app_private.require_keys(p,
    array['title', 'start_local', 'end_local', 'time_zone', 'all_day', 'evidence', 'needs_confirmation', 'description'],
    p_field);
  perform app_private.require_string(p -> 'title', p_field || '.title', 1, 300, false);
  perform app_private.require_string(p -> 'evidence', p_field || '.evidence', 0, 2000, true);
  perform app_private.require_string(p -> 'description', p_field || '.description', 0, 2000, true);
  if jsonb_typeof(p -> 'all_day') is distinct from 'boolean'
     or jsonb_typeof(p -> 'needs_confirmation') is distinct from 'boolean' then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'all_day와 needs_confirmation은 boolean이어야 합니다.',
      jsonb_build_object('field', p_field));
  end if;
  if not app_private.is_time_zone(p ->> 'time_zone') then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'time_zone은 IANA 시간대 이름이어야 합니다.',
      jsonb_build_object('field', p_field || '.time_zone'));
  end if;
  v_all_day := (p ->> 'all_day')::boolean;
  v_pattern := case when v_all_day then '^\d{4}-\d{2}-\d{2}$'
                    else '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$' end;
  foreach v_key in array array['start_local', 'end_local'] loop
    if p -> v_key is not null and jsonb_typeof(p -> v_key) <> 'null' then
      if jsonb_typeof(p -> v_key) <> 'string' or (p ->> v_key) !~ v_pattern then
        perform app_private.api_error('VALIDATION_FAILED', 400, '날짜·시각 형식이 올바르지 않습니다.',
          jsonb_build_object('field', p_field || '.' || v_key));
      end if;
      begin
        perform (p ->> v_key)::timestamp;
      exception when others then
        perform app_private.api_error('VALIDATION_FAILED', 400, '존재하지 않는 날짜·시각입니다.',
          jsonb_build_object('field', p_field || '.' || v_key));
      end;
    end if;
  end loop;
end;
$$;

-- 승인 직전 검사. 시작·종료가 모두 있고, 종료가 시작보다 뒤이며, 시간대 전환으로 없는 시각이 아니어야 한다.
create function app_private.validate_candidate_registrable(p jsonb) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text := p ->> 'time_zone';
  v_start timestamp;
  v_end timestamp;
begin
  if (p ->> 'start_local') is null or (p ->> 'end_local') is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, '시작과 종료 일시를 확정해야 승인할 수 있습니다.');
  end if;
  v_start := (p ->> 'start_local')::timestamp;
  v_end := (p ->> 'end_local')::timestamp;
  if (p ->> 'all_day')::boolean then
    -- 종일 일정의 end_local은 마지막 날(포함)이다. Google에는 다음 날(배타적 종료)로 보낸다.
    if v_end < v_start then
      perform app_private.api_error('VALIDATION_FAILED', 400, '종료일이 시작일보다 앞설 수 없습니다.');
    end if;
    return;
  end if;
  if (v_end at time zone v_tz) <= (v_start at time zone v_tz) then
    perform app_private.api_error('VALIDATION_FAILED', 400, '종료 시각은 시작 시각보다 뒤여야 합니다.');
  end if;
  if ((v_start at time zone v_tz) at time zone v_tz) <> v_start
     or ((v_end at time zone v_tz) at time zone v_tz) <> v_end then
    perform app_private.api_error('VALIDATION_FAILED', 400, '해당 시간대에 존재하지 않는 시각입니다(일광 절약 시간 전환).');
  end if;
end;
$$;

-- 에이전트가 올린 분석 결과 검사. 에이전트도 같은 검사를 하지만 서버는 업로드를 신뢰하지 않는다.
create function app_private.validate_analysis_payload(p jsonb) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_item jsonb;
  v_i integer := 0;
begin
  perform app_private.require_keys(p,
    array['schema_version', 'summary', 'decisions', 'action_items', 'event_candidates'], 'payload');
  if p -> 'schema_version' is distinct from '1'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '지원하지 않는 schema_version입니다.');
  end if;
  perform app_private.require_string(p -> 'summary', 'payload.summary', 0, 4000, false);

  if jsonb_typeof(p -> 'decisions') is distinct from 'array' or jsonb_array_length(p -> 'decisions') > 50 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'decisions가 올바르지 않습니다.');
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'decisions') loop
    perform app_private.require_string(v_item, 'payload.decisions[]', 0, 1000, false);
  end loop;

  if jsonb_typeof(p -> 'action_items') is distinct from 'array' or jsonb_array_length(p -> 'action_items') > 100 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'action_items가 올바르지 않습니다.');
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'action_items') loop
    perform app_private.require_keys(v_item, array['text', 'assignee', 'due_date'], 'payload.action_items[]');
    perform app_private.require_string(v_item -> 'text', 'payload.action_items[].text', 1, 1000, false);
    perform app_private.require_string(v_item -> 'assignee', 'payload.action_items[].assignee', 0, 200, true);
    if jsonb_typeof(v_item -> 'due_date') = 'string' and (v_item ->> 'due_date') !~ '^\d{4}-\d{2}-\d{2}$' then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'due_date 형식이 올바르지 않습니다.');
    end if;
  end loop;

  if jsonb_typeof(p -> 'event_candidates') is distinct from 'array' or jsonb_array_length(p -> 'event_candidates') > 30 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'event_candidates가 올바르지 않습니다.');
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'event_candidates') loop
    perform app_private.validate_candidate_shape(v_item, 'payload.event_candidates[' || v_i || ']');
    if v_item ? 'description' then
      perform app_private.api_error('VALIDATION_FAILED', 400, '분석 결과에는 description을 넣지 않습니다.');
    end if;
    v_i := v_i + 1;
  end loop;
end;
$$;

create function app_private.record_note_revision(n public.meeting_notes) returns void
language sql set search_path = ''
as $$
  insert into public.meeting_note_revisions (id, note_id, user_id, version, immutable_snapshot)
  values (n.revision_id, n.id, n.user_id, n.version, jsonb_build_object(
    'summary', n.summary, 'decisions', n.decisions, 'source_result_id', n.source_result_id,
    'source_revision_id', n.source_revision_id, 'deleted_at', n.deleted_at));
$$;

-- 리스가 만료된 실행 중 분석 작업을 실패로 바꾼다. 자동으로 다시 대기시키지 않는다(사용자 '재시도' 필요).
create function app_private.expire_analysis_leases(p_uid uuid) returns void
language plpgsql set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  for v_job in
    update public.analysis_jobs
    set status = 'failed', error_code = 'LEASE_EXPIRED', finished_at = now(),
        version = version + 1, updated_at = now()
    where user_id = p_uid and status = 'running' and lease_until < now()
    returning *
  loop
    perform app_private.append_change(p_uid, 'analysis_job', v_job.id, v_job.version, 'upsert',
      app_private.job_json(v_job));
  end loop;
end;
$$;

-- 리스 토큰으로 실행 중 작업을 잠근다.
create function app_private.lock_analysis_lease(p_uid uuid, p_job_id uuid, p_lease_token text)
returns public.analysis_jobs
language plpgsql set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  select * into v_job from public.analysis_jobs
  where id = p_job_id and user_id = p_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '분석 작업을 찾을 수 없습니다.');
  end if;
  if v_job.status <> 'running' or v_job.lease_token_hash is distinct from app_private.sha256_hex(p_lease_token)
     or v_job.lease_until < now() then
    perform app_private.api_error('LEASE_EXPIRED', 409, '작업 리스가 만료되었거나 다른 기기가 가져갔습니다.');
  end if;
  return v_job;
end;
$$;

-- 후보 승인 무효화. 내용이 바뀌거나 거절되면 이전 승인을 재사용하지 않는다.
create function app_private.revoke_candidate_approvals(p_candidate_id uuid) returns void
language sql set search_path = ''
as $$
  with revoked as (
    update public.event_approvals set revoked_at = now()
    where candidate_id = p_candidate_id and revoked_at is null
    returning id
  )
  update public.calendar_jobs set status = 'cancelled', updated_at = now()
  where approval_id in (select id from revoked) and status in ('queued', 'failed');
$$;

create function app_private.lock_candidate(p_uid uuid, p_id uuid) returns public.event_candidates
language plpgsql set search_path = ''
as $$
declare
  v_c public.event_candidates;
begin
  select * into v_c from public.event_candidates where id = p_id and user_id = p_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '일정 후보를 찾을 수 없습니다.');
  end if;
  if v_c.deleted_at is not null then
    perform app_private.api_error('ENTITY_DELETED', 409, '삭제된 일정 후보입니다.',
      jsonb_build_object('current_version', v_c.version));
  end if;
  return v_c;
end;
$$;

create function app_private.touch_candidate(p_c public.event_candidates, p_status text, p_error text)
returns public.event_candidates
language plpgsql set search_path = ''
as $$
declare
  v_c public.event_candidates;
begin
  update public.event_candidates
  set status = p_status, last_error_code = p_error, version = version + 1, updated_at = now()
  where id = p_c.id
  returning * into v_c;
  perform app_private.append_change(v_c.user_id, 'event_candidate', v_c.id, v_c.version, 'upsert',
    app_private.candidate_json(v_c));
  return v_c;
end;
$$;

revoke all on all functions in schema app_private from public, anon, authenticated;

-- ───────────────────────── 분석 RPC (사용자) ─────────────────────────

-- '분석 실행'(p_mode = initial)·'재분석'(p_mode = rerun) 버튼.
-- 같은 회의록에 대기·실행 중 작업이 있으면 새로 만들지 않고 그 작업을 돌려준다.
-- initial은 같은 원문에 완료된 분석이 있으면 새로 만들지 않는다.
create function public.analysis_request(
  p_operation_id uuid, p_meeting_id uuid, p_source_revision_id uuid, p_mode text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_meeting public.meetings;
  v_job public.analysis_jobs;
  v_run integer;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('analysis.request', jsonb_build_object(
    'meeting_id', p_meeting_id, 'source_revision_id', p_source_revision_id, 'mode', p_mode));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  if p_mode is null or p_mode not in ('initial', 'rerun') then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'mode는 initial 또는 rerun이어야 합니다.');
  end if;

  select * into v_meeting from public.meetings where id = p_meeting_id and user_id = v_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '회의록을 찾을 수 없습니다.');
  end if;
  if v_meeting.deleted_at is not null then
    perform app_private.api_error('ENTITY_DELETED', 409, '삭제된 회의록입니다.');
  end if;
  if v_meeting.revision_id is distinct from p_source_revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '회의록이 바뀌었습니다. 최신 내용을 확인한 뒤 실행하세요.',
      jsonb_build_object('current_version', v_meeting.version, 'current_revision_id', v_meeting.revision_id));
  end if;

  perform app_private.expire_analysis_leases(v_uid);

  select * into v_job from public.analysis_jobs
  where meeting_id = p_meeting_id and status in ('queued', 'running');
  if found then
    v_resp := app_private.job_json(v_job) || '{"deduplicated": true}';
    perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
    return v_resp;
  end if;

  if p_mode = 'initial' then
    select * into v_job from public.analysis_jobs
    where meeting_id = p_meeting_id and source_revision_id = p_source_revision_id
      and config_hash = app_private.analysis_config_hash() and status = 'completed'
    order by run_no desc limit 1;
    if found then
      v_resp := app_private.job_json(v_job) || '{"deduplicated": true}';
      perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
      return v_resp;
    end if;
  end if;

  select coalesce(max(run_no), 0) + 1 into v_run from public.analysis_jobs
  where meeting_id = p_meeting_id and source_revision_id = p_source_revision_id
    and config_hash = app_private.analysis_config_hash();

  insert into public.analysis_jobs (user_id, meeting_id, source_revision_id, config_hash, run_no, status)
  values (v_uid, p_meeting_id, p_source_revision_id, app_private.analysis_config_hash(), v_run, 'queued')
  returning * into v_job;

  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));
  v_resp := app_private.job_json(v_job) || '{"deduplicated": false}';
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 202, v_resp);
  return v_resp;
end;
$$;

-- '재시도' 버튼. 실패한 작업만 다시 대기시킨다. 원문이 바뀌었으면 거절한다.
create function public.analysis_retry(p_operation_id uuid, p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_job public.analysis_jobs;
  v_meeting public.meetings;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('analysis.retry', jsonb_build_object('job_id', p_job_id));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  perform app_private.expire_analysis_leases(v_uid);

  select * into v_job from public.analysis_jobs where id = p_job_id and user_id = v_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '분석 작업을 찾을 수 없습니다.');
  end if;
  if v_job.status in ('queued', 'running') then
    v_resp := app_private.job_json(v_job) || '{"deduplicated": true}';
    perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
    return v_resp;
  end if;
  if v_job.status <> 'failed' then
    perform app_private.api_error('INVALID_STATE', 409, '실패한 작업만 재시도할 수 있습니다.');
  end if;

  select * into v_meeting from public.meetings where id = v_job.meeting_id and user_id = v_uid;
  if v_meeting.deleted_at is not null or v_meeting.revision_id <> v_job.source_revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '회의록이 바뀌었습니다. 다시 분석을 실행하세요.');
  end if;
  if exists (select 1 from public.analysis_jobs
             where meeting_id = v_job.meeting_id and status in ('queued', 'running')) then
    perform app_private.api_error('JOB_IN_PROGRESS', 409, '이 회의록의 다른 분석이 진행 중입니다.');
  end if;

  update public.analysis_jobs
  set status = 'queued', error_code = null, device_id = null, lease_token_hash = null, lease_until = null,
      started_at = null, finished_at = null, requested_at = clock_timestamp(), version = version + 1, updated_at = now()
  where id = v_job.id
  returning * into v_job;

  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));
  v_resp := app_private.job_json(v_job) || '{"deduplicated": false}';
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 202, v_resp);
  return v_resp;
end;
$$;

-- PC 에이전트가 사용자 요청으로 대기 중인 작업을 가져간다. 대기 작업이 없으면 null.
-- 원문이 바뀐 작업은 분석하지 않고 SOURCE_CHANGED로 실패 처리한다(구독 한도 낭비 방지).
create function public.analysis_claim(p_device_id text, p_job_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_job public.analysis_jobs;
  v_meeting public.meetings;
  v_rev public.meeting_revisions;
  v_token text;
begin
  if p_device_id is null or char_length(p_device_id) not between 1 and 100 then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'device_id가 올바르지 않습니다.');
  end if;
  perform app_private.expire_analysis_leases(v_uid);

  loop
    select * into v_job from public.analysis_jobs
    where user_id = v_uid and status = 'queued' and (p_job_id is null or id = p_job_id)
    order by requested_at, id
    limit 1
    for update skip locked;
    if not found then
      return null;
    end if;

    select * into v_meeting from public.meetings where id = v_job.meeting_id and user_id = v_uid;
    if v_meeting.deleted_at is null and v_meeting.revision_id = v_job.source_revision_id then
      exit;
    end if;

    update public.analysis_jobs
    set status = 'failed', error_code = 'SOURCE_CHANGED', finished_at = now(), version = version + 1, updated_at = now()
    where id = v_job.id returning * into v_job;
    perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));
    if p_job_id is not null then
      return null;
    end if;
  end loop;

  v_token := app_private.new_token();
  update public.analysis_jobs
  set status = 'running', device_id = p_device_id, lease_token_hash = app_private.sha256_hex(v_token),
      lease_until = now() + interval '120 seconds', attempt = attempt + 1, started_at = now(),
      version = version + 1, updated_at = now()
  where id = v_job.id
  returning * into v_job;
  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));

  select * into v_rev from public.meeting_revisions where id = v_job.source_revision_id;

  return jsonb_build_object(
    'job', app_private.job_json(v_job),
    'lease_token', v_token,
    'input', jsonb_build_object(
      'meeting_id', v_job.meeting_id,
      'source_revision_id', v_job.source_revision_id,
      'title', v_rev.immutable_snapshot ->> 'title',
      'body', v_rev.immutable_snapshot ->> 'body',
      'meeting_at', v_rev.immutable_snapshot ->> 'meeting_at',
      'meeting_local_date', v_rev.immutable_snapshot ->> 'meeting_local_date',
      'time_zone', v_rev.immutable_snapshot ->> 'time_zone'
    )
  );
end;
$$;

create function public.analysis_heartbeat(p_job_id uuid, p_lease_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_job public.analysis_jobs;
begin
  v_job := app_private.lock_analysis_lease(v_uid, p_job_id, p_lease_token);
  update public.analysis_jobs set lease_until = now() + interval '120 seconds', updated_at = now()
  where id = v_job.id returning * into v_job;
  return jsonb_build_object('lease_until', v_job.lease_until);
end;
$$;

-- 결과 저장·편집본 초기 생성·후보 생성·작업 완료를 한 트랜잭션에서 처리한다.
-- 같은 리스 토큰으로 다시 보내면 저장된 결과를 돌려준다(업로드 재시도).
create function public.analysis_submit_result(
  p_job_id uuid, p_lease_token text, p_source_revision_id uuid, p_payload jsonb, p_metadata jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_job public.analysis_jobs;
  v_meeting public.meetings;
  v_result public.analysis_results;
  v_note public.meeting_notes;
  v_cand public.event_candidates;
  v_stale boolean;
  v_note_created boolean := false;
  v_count integer := 0;
  v_item record;
begin
  select * into v_job from public.analysis_jobs where id = p_job_id and user_id = v_uid for update;
  if found and v_job.status = 'completed'
     and v_job.lease_token_hash = app_private.sha256_hex(p_lease_token) then
    select * into v_result from public.analysis_results where job_id = v_job.id;
    return jsonb_build_object('result_id', v_result.id, 'stale', v_result.stale, 'replayed', true);
  end if;

  v_job := app_private.lock_analysis_lease(v_uid, p_job_id, p_lease_token);
  if p_source_revision_id is distinct from v_job.source_revision_id then
    perform app_private.api_error('VALIDATION_FAILED', 400, '작업의 원문 revision과 다릅니다.');
  end if;
  perform app_private.validate_analysis_payload(p_payload);
  perform app_private.require_keys(p_metadata, array['engine_version', 'prompt_version', 'input_hash'], 'metadata');
  perform app_private.require_string(p_metadata -> 'engine_version', 'metadata.engine_version', 1, 200, false);
  perform app_private.require_string(p_metadata -> 'prompt_version', 'metadata.prompt_version', 1, 100, false);
  perform app_private.require_string(p_metadata -> 'input_hash', 'metadata.input_hash', 1, 128, false);

  select * into v_meeting from public.meetings where id = v_job.meeting_id and user_id = v_uid for update;
  v_stale := v_meeting.deleted_at is not null or v_meeting.revision_id <> v_job.source_revision_id;

  insert into public.analysis_results (job_id, user_id, meeting_id, source_revision_id, schema_version,
    validated_payload, engine_version, prompt_version, input_hash, stale)
  values (v_job.id, v_uid, v_job.meeting_id, v_job.source_revision_id, 1, p_payload,
    p_metadata ->> 'engine_version', p_metadata ->> 'prompt_version', p_metadata ->> 'input_hash', v_stale)
  returning * into v_result;

  if not v_stale then
    -- 최초 분석만 편집본을 만든다. 이미 있으면(재분석) 사용자 편집본을 건드리지 않는다.
    if not exists (select 1 from public.meeting_notes where meeting_id = v_job.meeting_id) then
      insert into public.meeting_notes (meeting_id, user_id, summary, decisions, source_result_id,
        source_revision_id, version, revision_id)
      values (v_job.meeting_id, v_uid, p_payload ->> 'summary', p_payload -> 'decisions', v_result.id,
        v_job.source_revision_id, 1, gen_random_uuid())
      returning * into v_note;
      perform app_private.record_note_revision(v_note);
      perform app_private.append_change(v_uid, 'meeting_note', v_note.id, v_note.version, 'upsert', app_private.note_json(v_note));
      v_note_created := true;
    end if;

    for v_item in
      select value, ordinality - 1 as idx from jsonb_array_elements(p_payload -> 'event_candidates') with ordinality
    loop
      insert into public.event_candidates (user_id, meeting_id, result_id, item_index, source_revision_id,
        version, content_version, payload, status)
      values (v_uid, v_job.meeting_id, v_result.id, v_item.idx, v_job.source_revision_id, 1, 1,
        v_item.value || '{"description": null}', 'needs_review')
      returning * into v_cand;
      perform app_private.append_change(v_uid, 'event_candidate', v_cand.id, v_cand.version, 'upsert', app_private.candidate_json(v_cand));
      v_count := v_count + 1;
    end loop;
  end if;

  update public.analysis_jobs
  set status = 'completed', finished_at = now(), error_code = null, version = version + 1, updated_at = now()
  where id = v_job.id returning * into v_job;
  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));

  return jsonb_build_object('result_id', v_result.id, 'stale', v_stale, 'replayed', false,
    'note_created', v_note_created, 'candidate_count', v_count);
end;
$$;

create function public.analysis_submit_failure(p_job_id uuid, p_lease_token text, p_error_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_job public.analysis_jobs;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z_]{1,40}$' then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'error_code 형식이 올바르지 않습니다.');
  end if;
  v_job := app_private.lock_analysis_lease(v_uid, p_job_id, p_lease_token);
  update public.analysis_jobs
  set status = 'failed', error_code = p_error_code, finished_at = now(), version = version + 1, updated_at = now()
  where id = v_job.id returning * into v_job;
  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));
  return app_private.job_json(v_job);
end;
$$;

-- 회의록 화면이 한 번에 읽는 분석·편집본·후보·등록 상태.
create function public.meeting_analysis_state(p_meeting_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_meeting public.meetings;
  v_job jsonb;
  v_result jsonb;
  v_note jsonb;
  v_candidates jsonb;
begin
  select * into v_meeting from public.meetings where id = p_meeting_id and user_id = v_uid;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '회의록을 찾을 수 없습니다.');
  end if;

  -- 리스가 만료된 실행 중 작업은 화면에서 실패로 보인다(읽기 함수이므로 상태는 바꾸지 않는다).
  select app_private.job_json(j) || case when j.status = 'running' and j.lease_until < now()
           then '{"status": "failed", "error_code": "LEASE_EXPIRED"}'::jsonb else '{}'::jsonb end
  into v_job
  from public.analysis_jobs j
  where j.meeting_id = p_meeting_id and j.user_id = v_uid
  order by j.requested_at desc, j.id desc limit 1;

  select jsonb_build_object('id', r.id, 'job_id', r.job_id, 'source_revision_id', r.source_revision_id,
           'stale', r.stale or r.source_revision_id <> v_meeting.revision_id,
           'created_at', r.created_at, 'payload', r.validated_payload)
  into v_result
  from public.analysis_results r
  where r.meeting_id = p_meeting_id and r.user_id = v_uid
  order by r.created_at desc, r.id desc limit 1;

  select app_private.note_json(n) || jsonb_build_object(
           'based_on_current_revision', n.source_revision_id = v_meeting.revision_id)
  into v_note
  from public.meeting_notes n where n.meeting_id = p_meeting_id and n.user_id = v_uid;

  select coalesce(jsonb_agg(app_private.candidate_json(c) || jsonb_build_object(
           'stale', c.source_revision_id <> v_meeting.revision_id or v_meeting.deleted_at is not null,
           'approval_id', a.id,
           'calendar_job', case when cj.id is null then null else app_private.calendar_job_json(cj) end,
           'link', case when l.id is null then null
                        else jsonb_build_object('html_link', l.html_link, 'google_event_id', l.google_event_id) end)
         order by c.created_at, c.item_index), '[]'::jsonb)
  into v_candidates
  from public.event_candidates c
  left join public.event_approvals a
    on a.candidate_id = c.id and a.candidate_content_version = c.content_version and a.revoked_at is null
  left join public.calendar_jobs cj on cj.approval_id = a.id
  left join public.calendar_links l on l.approval_id = a.id
  where c.meeting_id = p_meeting_id and c.user_id = v_uid and c.deleted_at is null;

  return jsonb_build_object(
    'meeting', jsonb_build_object('id', v_meeting.id, 'version', v_meeting.version,
      'revision_id', v_meeting.revision_id, 'deleted', v_meeting.deleted_at is not null),
    'job', v_job,
    'latest_result', v_result,
    'notes', v_note,
    'candidates', v_candidates
  );
end;
$$;

-- ───────────────────────── 편집본 RPC ─────────────────────────

create function public.meeting_notes_patch(
  p_operation_id uuid, p_meeting_id uuid, p_base_version integer, p_patch jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_note public.meeting_notes;
  v_item jsonb;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('notes.patch', jsonb_build_object(
    'meeting_id', p_meeting_id, 'base_version', p_base_version, 'patch', p_patch));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  perform app_private.require_keys(p_patch, array['summary', 'decisions'], 'patch');
  if p_patch = '{}'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '변경할 필드가 필요합니다.');
  end if;
  if p_patch ? 'summary' then
    perform app_private.require_string(p_patch -> 'summary', 'patch.summary', 0, 4000, false);
  end if;
  if p_patch ? 'decisions' then
    if jsonb_typeof(p_patch -> 'decisions') <> 'array' or jsonb_array_length(p_patch -> 'decisions') > 50 then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'decisions가 올바르지 않습니다.');
    end if;
    for v_item in select value from jsonb_array_elements(p_patch -> 'decisions') loop
      perform app_private.require_string(v_item, 'patch.decisions[]', 0, 1000, false);
    end loop;
  end if;

  select * into v_note from public.meeting_notes where meeting_id = p_meeting_id and user_id = v_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '편집본이 없습니다. 먼저 분석을 실행하세요.');
  end if;
  if v_note.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
      jsonb_build_object('current_version', v_note.version, 'current_revision_id', v_note.revision_id));
  end if;

  update public.meeting_notes
  set summary = coalesce(p_patch ->> 'summary', summary),
      decisions = coalesce(p_patch -> 'decisions', decisions),
      version = version + 1, revision_id = gen_random_uuid(), updated_at = now()
  where id = v_note.id returning * into v_note;
  perform app_private.record_note_revision(v_note);
  v_resp := app_private.note_json(v_note);
  perform app_private.append_change(v_uid, 'meeting_note', v_note.id, v_note.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- '새 결과 적용' 버튼. 사용자가 고른 필드만 base_version 검사 후 새 revision으로 반영한다.
-- 편집본이 아직 없으면 p_base_version = 0으로 새로 만든다.
create function public.meeting_notes_apply_result(
  p_operation_id uuid, p_meeting_id uuid, p_base_version integer, p_result_id uuid, p_fields text[]
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_note public.meeting_notes;
  v_result public.analysis_results;
  v_meeting public.meetings;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('notes.apply_result', jsonb_build_object(
    'meeting_id', p_meeting_id, 'base_version', p_base_version, 'result_id', p_result_id, 'fields', p_fields));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  if p_fields is null or cardinality(p_fields) = 0 or not (p_fields <@ array['summary', 'decisions']) then
    perform app_private.api_error('VALIDATION_FAILED', 400, '적용할 필드는 summary, decisions 중에서 고릅니다.');
  end if;

  select * into v_meeting from public.meetings where id = p_meeting_id and user_id = v_uid;
  select * into v_result from public.analysis_results
  where id = p_result_id and meeting_id = p_meeting_id and user_id = v_uid;
  if v_meeting.id is null or v_result.id is null then
    perform app_private.api_error('NOT_FOUND', 404, '분석 결과를 찾을 수 없습니다.');
  end if;
  if v_result.stale or v_result.source_revision_id <> v_meeting.revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '이전 원문 기준 결과는 적용할 수 없습니다.');
  end if;

  select * into v_note from public.meeting_notes where meeting_id = p_meeting_id and user_id = v_uid for update;
  if not found then
    if p_base_version <> 0 then
      perform app_private.api_error('VERSION_CONFLICT', 409, '편집본이 없습니다.', jsonb_build_object('current_version', 0));
    end if;
    insert into public.meeting_notes (meeting_id, user_id, summary, decisions, source_result_id,
      source_revision_id, version, revision_id)
    values (p_meeting_id, v_uid,
      case when 'summary' = any (p_fields) then v_result.validated_payload ->> 'summary' else '' end,
      case when 'decisions' = any (p_fields) then v_result.validated_payload -> 'decisions' else '[]'::jsonb end,
      v_result.id, v_result.source_revision_id, 1, gen_random_uuid())
    returning * into v_note;
  else
    if v_note.version <> p_base_version then
      perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
        jsonb_build_object('current_version', v_note.version, 'current_revision_id', v_note.revision_id));
    end if;
    update public.meeting_notes
    set summary = case when 'summary' = any (p_fields) then v_result.validated_payload ->> 'summary' else summary end,
        decisions = case when 'decisions' = any (p_fields) then v_result.validated_payload -> 'decisions' else decisions end,
        source_result_id = v_result.id, source_revision_id = v_result.source_revision_id,
        version = version + 1, revision_id = gen_random_uuid(), updated_at = now()
    where id = v_note.id returning * into v_note;
  end if;

  perform app_private.record_note_revision(v_note);
  v_resp := app_private.note_json(v_note);
  perform app_private.append_change(v_uid, 'meeting_note', v_note.id, v_note.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- ───────────────────────── 일정 후보 RPC ─────────────────────────

-- 후보 수정. 새 content_version을 만들고 이전 승인을 무효화한다. 등록 중·등록 완료 후보는 바꿀 수 없다.
create function public.candidate_patch(
  p_operation_id uuid, p_id uuid, p_base_version integer, p_patch jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_c public.event_candidates;
  v_payload jsonb;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('candidate.patch', jsonb_build_object(
    'id', p_id, 'base_version', p_base_version, 'patch', p_patch));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  perform app_private.require_keys(p_patch,
    array['title', 'start_local', 'end_local', 'time_zone', 'all_day', 'description'], 'patch');
  if p_patch = '{}'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '변경할 필드가 필요합니다.');
  end if;

  v_c := app_private.lock_candidate(v_uid, p_id);
  if v_c.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
      jsonb_build_object('current_version', v_c.version));
  end if;
  if v_c.status in ('registering', 'registered') then
    perform app_private.api_error('CANDIDATE_LOCKED', 409, '등록 중이거나 등록된 일정은 수정할 수 없습니다.');
  end if;

  v_payload := v_c.payload || p_patch;
  -- 사용자가 날짜·시각을 직접 고쳤으면 '확인 필요' 표시를 내린다.
  if p_patch ?| array['start_local', 'end_local', 'time_zone', 'all_day'] then
    v_payload := v_payload || '{"needs_confirmation": false}';
  end if;
  perform app_private.validate_candidate_shape(v_payload, 'payload');

  perform app_private.revoke_candidate_approvals(v_c.id);
  update public.event_candidates
  set payload = v_payload, content_version = content_version + 1, version = version + 1,
      status = 'needs_review', last_error_code = null, updated_at = now()
  where id = v_c.id returning * into v_c;

  v_resp := app_private.candidate_json(v_c);
  perform app_private.append_change(v_uid, 'event_candidate', v_c.id, v_c.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

create function public.candidate_reject(p_operation_id uuid, p_id uuid, p_base_version integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_c public.event_candidates;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('candidate.reject', jsonb_build_object('id', p_id, 'base_version', p_base_version));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_c := app_private.lock_candidate(v_uid, p_id);
  if v_c.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
      jsonb_build_object('current_version', v_c.version));
  end if;
  if v_c.status in ('registering', 'registered') then
    perform app_private.api_error('CANDIDATE_LOCKED', 409, '등록 중이거나 등록된 일정은 거절할 수 없습니다.');
  end if;
  perform app_private.revoke_candidate_approvals(v_c.id);
  v_c := app_private.touch_candidate(v_c, 'rejected', null);
  v_resp := app_private.candidate_json(v_c);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- '승인하고 캘린더 등록' 버튼. 화면에 보인 version·payload_hash와 현재 후보가 같을 때만 승인한다.
-- 이미 같은 내용으로 승인했다면(중복 클릭) 기존 승인과 작업을 돌려준다.
create function public.candidate_approve(
  p_operation_id uuid, p_id uuid, p_base_version integer, p_payload_hash text, p_calendar_id text default 'primary'
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_c public.event_candidates;
  v_meeting public.meetings;
  v_approval public.event_approvals;
  v_job public.calendar_jobs;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('candidate.approve', jsonb_build_object(
    'id', p_id, 'base_version', p_base_version, 'payload_hash', p_payload_hash, 'calendar_id', p_calendar_id));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_c := app_private.lock_candidate(v_uid, p_id);

  select * into v_approval from public.event_approvals
  where candidate_id = v_c.id and candidate_content_version = v_c.content_version and revoked_at is null;
  if found and v_approval.payload_hash = p_payload_hash then
    select * into v_job from public.calendar_jobs where approval_id = v_approval.id;
    v_resp := jsonb_build_object('approval_id', v_approval.id, 'calendar_job', app_private.calendar_job_json(v_job),
      'candidate', app_private.candidate_json(v_c), 'deduplicated', true);
    perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
    return v_resp;
  end if;

  if v_c.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '일정 후보가 바뀌었습니다. 내용을 다시 확인하세요.',
      jsonb_build_object('current_version', v_c.version));
  end if;
  if p_payload_hash is distinct from app_private.payload_hash(v_c.payload) then
    perform app_private.api_error('PAYLOAD_CHANGED', 409, '확인한 내용과 현재 후보가 다릅니다. 다시 확인하세요.');
  end if;
  if v_c.status not in ('needs_review', 'rejected') then
    perform app_private.api_error('INVALID_STATE', 409, '검토 중인 후보만 승인할 수 있습니다.');
  end if;

  select * into v_meeting from public.meetings where id = v_c.meeting_id and user_id = v_uid;
  if v_meeting.deleted_at is not null or v_meeting.revision_id <> v_c.source_revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '회의록이 바뀌어 이 후보는 승인할 수 없습니다. 다시 분석하세요.');
  end if;
  perform app_private.validate_candidate_registrable(v_c.payload);
  if p_calendar_id is distinct from 'primary' then
    perform app_private.api_error('VALIDATION_FAILED', 400, '현재는 기본 캘린더(primary)만 지원합니다.');
  end if;
  if not exists (select 1 from app_private.oauth_connections
                 where user_id = v_uid and provider = 'google' and status = 'active') then
    perform app_private.api_error('GOOGLE_AUTH_REQUIRED', 409, 'Google 캘린더를 먼저 연결하세요.');
  end if;

  insert into public.event_approvals (candidate_id, candidate_content_version, user_id, source_revision_id,
    payload_snapshot, payload_hash, calendar_id)
  values (v_c.id, v_c.content_version, v_uid, v_c.source_revision_id, v_c.payload, p_payload_hash, p_calendar_id)
  returning * into v_approval;
  insert into public.calendar_jobs (approval_id, candidate_id, user_id, status)
  values (v_approval.id, v_c.id, v_uid, 'queued')
  returning * into v_job;
  v_c := app_private.touch_candidate(v_c, 'approved', null);

  v_resp := jsonb_build_object('approval_id', v_approval.id, 'calendar_job', app_private.calendar_job_json(v_job),
    'candidate', app_private.candidate_json(v_c), 'deduplicated', false);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 202, v_resp);
  return v_resp;
end;
$$;

-- 캘린더 등록 '재시도' 버튼. 실패한 작업만 다시 대기시킨다. 승인이 무효이면 거절한다.
create function public.calendar_job_request_retry(p_operation_id uuid, p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_job public.calendar_jobs;
  v_approval public.event_approvals;
  v_c public.event_candidates;
  v_meeting public.meetings;
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('calendar_job.retry', jsonb_build_object('job_id', p_job_id));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_job from public.calendar_jobs where id = p_job_id and user_id = v_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '등록 작업을 찾을 수 없습니다.');
  end if;
  if v_job.status in ('queued', 'running', 'succeeded') then
    v_resp := app_private.calendar_job_json(v_job) || '{"deduplicated": true}';
    perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
    return v_resp;
  end if;
  if v_job.status <> 'failed' then
    perform app_private.api_error('INVALID_STATE', 409, '후보가 바뀌어 취소된 작업입니다. 다시 승인하세요.');
  end if;

  select * into v_approval from public.event_approvals where id = v_job.approval_id;
  v_c := app_private.lock_candidate(v_uid, v_job.candidate_id);
  select * into v_meeting from public.meetings where id = v_c.meeting_id and user_id = v_uid;
  if v_approval.revoked_at is not null or v_approval.candidate_content_version <> v_c.content_version then
    perform app_private.api_error('PAYLOAD_CHANGED', 409, '후보가 바뀌었습니다. 다시 승인하세요.');
  end if;
  if v_meeting.deleted_at is not null or v_meeting.revision_id <> v_approval.source_revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '회의록이 바뀌어 등록할 수 없습니다.');
  end if;

  update public.calendar_jobs
  set status = 'queued', last_error_code = null, last_error_message = null, lease_token_hash = null,
      lease_until = null, updated_at = now()
  where id = v_job.id returning * into v_job;
  v_c := app_private.touch_candidate(v_c, 'approved', null);

  v_resp := app_private.calendar_job_json(v_job) || '{"deduplicated": false}';
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 202, v_resp);
  return v_resp;
end;
$$;

create function public.google_connection_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('connected', c.status = 'active', 'status', c.status,
              'account_email', c.account_email, 'scopes', to_jsonb(c.scopes), 'connected_at', c.connected_at)
     from app_private.oauth_connections c
     where c.user_id = auth.uid() and c.provider = 'google'),
    jsonb_build_object('connected', false, 'status', 'none'));
$$;

-- ───────────────────────── 서버 전용 RPC (service_role, Edge Function) ─────────────────────────

create function public.svc_oauth_state_create(
  p_user_id uuid, p_state_hash text, p_code_verifier text, p_return_path text
) returns void
language sql security definer set search_path = ''
as $$
  delete from app_private.oauth_states where expires_at < now() - interval '1 day';
  insert into app_private.oauth_states (state_hash, user_id, provider, code_verifier, return_path, expires_at)
  values (p_state_hash, p_user_id, 'google', p_code_verifier, p_return_path, now() + interval '10 minutes');
$$;

-- state는 한 번만 쓸 수 있다(C04). 만료·재사용·없음은 모두 null.
create function public.svc_oauth_state_consume(p_state_hash text) returns jsonb
language sql security definer set search_path = ''
as $$
  update app_private.oauth_states set used_at = now()
  where state_hash = p_state_hash and used_at is null and expires_at > now()
  returning jsonb_build_object('user_id', user_id, 'code_verifier', code_verifier, 'return_path', return_path);
$$;

create function public.svc_oauth_connection_save(
  p_user_id uuid, p_account_email text, p_scopes text[], p_ciphertext text
) returns void
language sql security definer set search_path = ''
as $$
  insert into app_private.oauth_connections
    (user_id, provider, account_email, scopes, refresh_token_ciphertext, status)
  values (p_user_id, 'google', p_account_email, p_scopes, p_ciphertext, 'active')
  on conflict (user_id, provider) do update
  set account_email = excluded.account_email, scopes = excluded.scopes,
      refresh_token_ciphertext = coalesce(excluded.refresh_token_ciphertext,
                                          app_private.oauth_connections.refresh_token_ciphertext),
      status = 'active', connected_at = now(), updated_at = now();
$$;

create function public.svc_oauth_connection_get(p_user_id uuid) returns jsonb
language sql security definer set search_path = ''
as $$
  select jsonb_build_object('status', status, 'refresh_token_ciphertext', refresh_token_ciphertext)
  from app_private.oauth_connections where user_id = p_user_id and provider = 'google';
$$;

-- 연결 해제·재인증 필요. 대기 중인 등록 작업은 실패로 바꿔 사용자가 다시 연결 후 재시도하게 한다.
create function public.svc_oauth_connection_set_status(p_user_id uuid, p_status text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.calendar_jobs;
  v_c public.event_candidates;
begin
  if p_status not in ('auth_required', 'revoked') then
    perform app_private.api_error('VALIDATION_FAILED', 400, '허용되지 않은 상태입니다.');
  end if;
  update app_private.oauth_connections
  set status = p_status, updated_at = now(),
      refresh_token_ciphertext = case when p_status = 'revoked' then null else refresh_token_ciphertext end
  where user_id = p_user_id and provider = 'google';

  for v_job in
    update public.calendar_jobs set status = 'failed', last_error_code = 'AUTH_REQUIRED', updated_at = now()
    where user_id = p_user_id and status = 'queued' returning *
  loop
    select * into v_c from public.event_candidates where id = v_job.candidate_id for update;
    perform app_private.touch_candidate(v_c, 'failed', 'AUTH_REQUIRED');
  end loop;
end;
$$;

-- 등록 직전 재검사와 리스 획득. 검사에 실패하면 작업을 실패로 기록하고 ok=false를 돌려준다
-- (예외로 올리면 실패 기록까지 롤백되므로).
create function public.svc_calendar_job_claim(p_user_id uuid, p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.calendar_jobs;
  v_approval public.event_approvals;
  v_c public.event_candidates;
  v_meeting public.meetings;
  v_conn app_private.oauth_connections;
  v_link public.calendar_links;
  v_error text;
  v_token text;
begin
  select * into v_job from public.calendar_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND');
  end if;
  if v_job.status = 'succeeded' then
    select * into v_link from public.calendar_links where approval_id = v_job.approval_id;
    return jsonb_build_object('ok', false, 'error_code', 'ALREADY_SUCCEEDED', 'html_link', v_link.html_link);
  end if;
  if v_job.status = 'running' and v_job.lease_until > now() then
    return jsonb_build_object('ok', false, 'error_code', 'JOB_IN_PROGRESS');
  end if;
  if v_job.status not in ('queued', 'running') then
    return jsonb_build_object('ok', false, 'error_code', 'INVALID_STATE');
  end if;

  select * into v_approval from public.event_approvals where id = v_job.approval_id;
  select * into v_c from public.event_candidates where id = v_job.candidate_id for update;
  select * into v_meeting from public.meetings where id = v_c.meeting_id;
  select * into v_conn from app_private.oauth_connections where user_id = p_user_id and provider = 'google';

  if v_approval.revoked_at is not null or v_c.deleted_at is not null
     or v_approval.candidate_content_version <> v_c.content_version
     or v_approval.payload_hash <> app_private.payload_hash(v_c.payload) then
    v_error := 'CANDIDATE_CHANGED';
  elsif v_meeting.deleted_at is not null or v_meeting.revision_id <> v_approval.source_revision_id then
    v_error := 'STALE_SOURCE';
  elsif v_conn.status is distinct from 'active' or v_conn.refresh_token_ciphertext is null then
    v_error := 'AUTH_REQUIRED';
  end if;

  if v_error is not null then
    update public.calendar_jobs set status = 'failed', last_error_code = v_error, updated_at = now()
    where id = v_job.id;
    perform app_private.touch_candidate(v_c, 'failed', v_error);
    return jsonb_build_object('ok', false, 'error_code', v_error);
  end if;

  v_token := app_private.new_token();
  update public.calendar_jobs
  set status = 'running', lease_token_hash = app_private.sha256_hex(v_token),
      lease_until = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now()
  where id = v_job.id;
  perform app_private.touch_candidate(v_c, 'registering', null);

  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'lease_token', v_token,
    'approval_id', v_approval.id,
    'calendar_id', v_approval.calendar_id,
    'payload', v_approval.payload_snapshot,
    'refresh_token_ciphertext', v_conn.refresh_token_ciphertext
  );
end;
$$;

create function public.svc_calendar_job_complete(
  p_job_id uuid, p_lease_token text, p_google_event_id text, p_html_link text, p_etag text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.calendar_jobs;
  v_approval public.event_approvals;
  v_c public.event_candidates;
begin
  select * into v_job from public.calendar_jobs where id = p_job_id for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '등록 작업을 찾을 수 없습니다.');
  end if;
  if v_job.status = 'succeeded' then
    return app_private.calendar_job_json(v_job);
  end if;
  if v_job.status <> 'running' or v_job.lease_token_hash is distinct from app_private.sha256_hex(p_lease_token) then
    perform app_private.api_error('LEASE_EXPIRED', 409, '등록 작업 리스가 유효하지 않습니다.');
  end if;
  select * into v_approval from public.event_approvals where id = v_job.approval_id;

  insert into public.calendar_links (approval_id, candidate_id, user_id, calendar_id, google_event_id, html_link, etag)
  values (v_approval.id, v_job.candidate_id, v_job.user_id, v_approval.calendar_id, p_google_event_id,
    p_html_link, p_etag)
  on conflict (approval_id) do nothing;

  update public.calendar_jobs set status = 'succeeded', last_error_code = null, last_error_message = null,
    updated_at = now()
  where id = v_job.id returning * into v_job;
  select * into v_c from public.event_candidates where id = v_job.candidate_id for update;
  perform app_private.touch_candidate(v_c, 'registered', null);
  return app_private.calendar_job_json(v_job);
end;
$$;

create function public.svc_calendar_job_fail(
  p_job_id uuid, p_lease_token text, p_error_code text, p_message text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.calendar_jobs;
  v_c public.event_candidates;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z_]{1,40}$' then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'error_code 형식이 올바르지 않습니다.');
  end if;
  select * into v_job from public.calendar_jobs where id = p_job_id for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '등록 작업을 찾을 수 없습니다.');
  end if;
  if v_job.status <> 'running' or v_job.lease_token_hash is distinct from app_private.sha256_hex(p_lease_token) then
    perform app_private.api_error('LEASE_EXPIRED', 409, '등록 작업 리스가 유효하지 않습니다.');
  end if;
  update public.calendar_jobs
  set status = 'failed', last_error_code = p_error_code, last_error_message = left(p_message, 500), updated_at = now()
  where id = v_job.id returning * into v_job;
  select * into v_c from public.event_candidates where id = v_job.candidate_id for update;
  perform app_private.touch_candidate(v_c, 'failed', p_error_code);
  if p_error_code = 'AUTH_REQUIRED' then
    update app_private.oauth_connections set status = 'auth_required', updated_at = now()
    where user_id = v_job.user_id and provider = 'google';
  end if;
  return app_private.calendar_job_json(v_job);
end;
$$;

-- ───────────────────────── 실행 권한 ─────────────────────────

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'analysis_request(uuid, uuid, uuid, text)',
    'analysis_retry(uuid, uuid)',
    'analysis_claim(text, uuid)',
    'analysis_heartbeat(uuid, text)',
    'analysis_submit_result(uuid, text, uuid, jsonb, jsonb)',
    'analysis_submit_failure(uuid, text, text)',
    'meeting_analysis_state(uuid)',
    'meeting_notes_patch(uuid, uuid, integer, jsonb)',
    'meeting_notes_apply_result(uuid, uuid, integer, uuid, text[])',
    'candidate_patch(uuid, uuid, integer, jsonb)',
    'candidate_reject(uuid, uuid, integer)',
    'candidate_approve(uuid, uuid, integer, text, text)',
    'calendar_job_request_retry(uuid, uuid)',
    'google_connection_status()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', v_fn);
    execute format('grant execute on function public.%s to authenticated', v_fn);
  end loop;

  foreach v_fn in array array[
    'svc_oauth_state_create(uuid, text, text, text)',
    'svc_oauth_state_consume(text)',
    'svc_oauth_connection_save(uuid, text, text[], text)',
    'svc_oauth_connection_get(uuid)',
    'svc_oauth_connection_set_status(uuid, text)',
    'svc_calendar_job_claim(uuid, uuid)',
    'svc_calendar_job_complete(uuid, text, text, text, text)',
    'svc_calendar_job_fail(uuid, text, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end;
$$;
