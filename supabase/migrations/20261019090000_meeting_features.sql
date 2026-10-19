-- 2026-10-19 기능 추가: 회의록 영구 삭제, 분석 추가 요청사항, 일정 목적지(schema v2), 원본 회의록 링크용 정보, 요약 목록.
-- 설계: docs/plans/2026-10-19-meeting-features.md
-- 이전 마이그레이션은 수정하지 않는다. 바뀌는 함수는 create or replace로 교체한다
-- (생성 시 이전 정의를 그대로 가져와 해당 문장만 바꿨다).
-- 유지 규칙: 버튼으로만 실행, 사용자 승인 후 등록, operation_id 영수증, 실패는 사용자 재시도로만.

-- ───────────────────────── 스키마 변경 ─────────────────────────

alter table app_private.change_feed drop constraint change_feed_operation_check;
alter table app_private.change_feed add constraint change_feed_operation_check
  check (operation in ('upsert', 'delete', 'purge'));

alter table public.analysis_jobs
  add column user_instructions text check (char_length(user_instructions) <= 2000);
grant select (user_instructions) on public.analysis_jobs to authenticated;

-- 새 분석은 지시문 v2·결과 schema v2로 만든다. 이전 v1 완료 결과는 이력으로 남는다.
create or replace function app_private.analysis_config_hash() returns text
language sql immutable set search_path = ''
as $$ select 'meeting-analysis/v2'::text $$;

-- ───────────────────────── 검증 함수 교체 ─────────────────────────

create or replace function app_private.validate_candidate_shape(p jsonb, p_field text) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_all_day boolean;
  v_key text;
  v_pattern text;
begin
  perform app_private.require_keys(p,
    array['title', 'start_local', 'end_local', 'time_zone', 'all_day', 'evidence', 'needs_confirmation', 'description',
          'location', 'location_uncertain'],
    p_field);
  perform app_private.require_string(p -> 'title', p_field || '.title', 1, 300, false);
  perform app_private.require_string(p -> 'evidence', p_field || '.evidence', 0, 2000, true);
  perform app_private.require_string(p -> 'description', p_field || '.description', 0, 2000, true);
  -- 목적지(schema v2). 없는 키는 null과 같다. 여러 곳·경유지는 지원하지 않으므로 이름 하나만 받는다.
  perform app_private.require_string(p -> 'location', p_field || '.location', 1, 200, true);
  if p ? 'location_uncertain' and jsonb_typeof(p -> 'location_uncertain') is distinct from 'boolean' then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'location_uncertain은 boolean이어야 합니다.',
      jsonb_build_object('field', p_field || '.location_uncertain'));
  end if;
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

create or replace function app_private.validate_candidate_registrable(p jsonb) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text := p ->> 'time_zone';
  v_start timestamp;
  v_end timestamp;
begin
  if coalesce((p ->> 'location_uncertain')::boolean, false) then
    perform app_private.api_error('VALIDATION_FAILED', 400, '목적지를 확인해야 승인할 수 있습니다.',
      jsonb_build_object('field', 'location'));
  end if;
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

create or replace function app_private.validate_analysis_payload(p jsonb) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_item jsonb;
  v_i integer := 0;
  v_v2 boolean;
begin
  perform app_private.require_keys(p,
    array['schema_version', 'summary', 'decisions', 'action_items', 'event_candidates'], 'payload');
  -- v1(목적지 없음)과 v2(목적지 있음)를 모두 받는다. 새 분석은 v2다.
  if p -> 'schema_version' is distinct from '1'::jsonb and p -> 'schema_version' is distinct from '2'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '지원하지 않는 schema_version입니다.');
  end if;
  v_v2 := p -> 'schema_version' = '2'::jsonb;
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
    if v_v2 and not (v_item ? 'location' and v_item ? 'location_uncertain') then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'schema v2 일정 후보에는 location과 location_uncertain이 필요합니다.');
    end if;
    if not v_v2 and (v_item ? 'location' or v_item ? 'location_uncertain') then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'schema v1 결과에는 location을 넣지 않습니다.');
    end if;
    v_i := v_i + 1;
  end loop;
end;
$$;

-- ───────────────────────── 분석·후보 함수 교체 ─────────────────────────

create or replace function public.analysis_claim(p_device_id text, p_job_id uuid default null) returns jsonb
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
      'time_zone', v_rev.immutable_snapshot ->> 'time_zone',
      -- 원문(body)과 분리해 전달한다. PC 에이전트는 stdin JSON의 별도 필드로 넘긴다.
      'user_instructions', v_job.user_instructions
    )
  );
end;
$$;

create or replace function public.analysis_submit_result(
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
  values (v_job.id, v_uid, v_job.meeting_id, v_job.source_revision_id, (p_payload ->> 'schema_version')::integer, p_payload,
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
        -- v1 후보에는 목적지가 없다(= null). v2는 AI가 원문에서 찾은 목적지를 그대로 둔다.
        '{"location": null, "location_uncertain": false}'::jsonb || v_item.value || '{"description": null}', 'needs_review')
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

create or replace function public.candidate_patch(
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
    array['title', 'start_local', 'end_local', 'time_zone', 'all_day', 'description', 'location'], 'patch');
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
  -- 사용자가 목적지를 확인·수정·삭제하면 '목적지 확인 필요'를 내린다. 빈 문자열은 목적지 없음.
  if p_patch ? 'location' then
    if jsonb_typeof(p_patch -> 'location') = 'string' and btrim(p_patch ->> 'location') = '' then
      v_payload := v_payload || '{"location": null}';
    elsif jsonb_typeof(p_patch -> 'location') = 'string' then
      v_payload := v_payload || jsonb_build_object('location', btrim(p_patch ->> 'location'));
    end if;
    v_payload := v_payload || '{"location_uncertain": false}';
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

create or replace function public.svc_calendar_job_claim(p_user_id uuid, p_job_id uuid) returns jsonb
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
    -- 이벤트 설명의 '원본 회의록 보기' 링크용. 회의 UUID만 쓴다.
    'meeting_id', v_c.meeting_id,
    'calendar_id', v_approval.calendar_id,
    'payload', v_approval.payload_snapshot,
    'refresh_token_ciphertext', v_conn.refresh_token_ciphertext
  );
end;
$$;

-- ───────────────────────── 회의록 영구 삭제 ─────────────────────────

-- 회의록과 모든 하위 자료를 지운다(FK cascade). 휴지통·복원 없음.
-- Google에 이미 등록된 일정은 지우지 않는다. 진행 중인 캘린더 등록이 있으면 거절한다.
-- change feed의 과거 payload에서 본문을 지우고 purge 1건을 남겨 다른 기기가 로컬 사본을 지우게 한다.
create function public.meeting_purge(p_operation_id uuid, p_id uuid, p_base_version integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_hash text;
  v_replay jsonb;
  v_meeting public.meetings;
  v_registered integer;
  v_entity_ids uuid[];
  v_resp jsonb;
begin
  v_hash := app_private.request_hash('meeting.purge', jsonb_build_object('id', p_id, 'base_version', p_base_version));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  if p_id is null or p_base_version is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'id와 base_version이 필요합니다.');
  end if;
  select * into v_meeting from public.meetings where id = p_id and user_id = v_uid for update;
  if not found then
    perform app_private.api_error('NOT_FOUND', 404, '회의록을 찾을 수 없습니다.');
  end if;
  if v_meeting.version <> p_base_version then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다. 내용을 확인한 뒤 다시 삭제하세요.',
      jsonb_build_object('current_version', v_meeting.version, 'current_revision_id', v_meeting.revision_id));
  end if;
  if exists (
    select 1 from public.calendar_jobs j join public.event_candidates c on c.id = j.candidate_id
    where c.meeting_id = p_id and j.status = 'running' and j.lease_until > now()
  ) then
    perform app_private.api_error('JOB_IN_PROGRESS', 409, '캘린더 등록이 진행 중입니다. 잠시 뒤 다시 삭제하세요.');
  end if;

  select count(*) into v_registered
  from public.calendar_links l join public.event_candidates c on c.id = l.candidate_id
  where c.meeting_id = p_id and l.user_id = v_uid;

  select array_agg(id) into v_entity_ids from (
    select p_id as id
    union all select id from public.meeting_notes where meeting_id = p_id
    union all select id from public.event_candidates where meeting_id = p_id
    union all select id from public.analysis_jobs where meeting_id = p_id
  ) e;

  -- 과거 변경 기록에 남은 본문·요약을 지운다(seq는 유지해 커서가 깨지지 않게 한다).
  update app_private.change_feed
  set payload = jsonb_build_object('id', entity_id, 'purged', true)
  where user_id = v_uid and entity_id = any (v_entity_ids);
  -- 응답 재사용 영수증에 남은 본문도 지운다.
  delete from app_private.operation_receipts
  where user_id = v_uid
    and (response_payload ->> 'id' = p_id::text or response_payload ->> 'meeting_id' = p_id::text
         or response_payload -> 'candidate' ->> 'meeting_id' = p_id::text);

  delete from public.meetings where id = p_id and user_id = v_uid;

  perform app_private.append_change(v_uid, 'meeting', p_id, v_meeting.version + 1, 'purge',
    jsonb_build_object('id', p_id, 'purged', true));

  v_resp := jsonb_build_object('id', p_id, 'purged', true, 'registered_events_kept', v_registered);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- ───────────────────────── 요약 목록 ─────────────────────────

-- 회의별 최신 분석 결과 1건. 결과가 없는 회의·삭제(tombstone)된 회의는 제외한다.
create function public.meeting_summaries() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.analyzed_at desc), '[]'::jsonb)
  from (
    select distinct on (m.id)
      m.id as meeting_id, m.title, m.meeting_at, m.time_zone,
      r.id as result_id,
      left(r.validated_payload ->> 'summary', 160) as summary_preview,
      r.created_at as analyzed_at,
      (r.stale or r.source_revision_id <> m.revision_id) as stale,
      exists (select 1 from public.meeting_notes n where n.meeting_id = m.id and n.deleted_at is null) as has_user_notes
    from public.meetings m
    join public.analysis_results r on r.meeting_id = m.id and r.user_id = m.user_id
    where m.user_id = auth.uid() and m.deleted_at is null
    order by m.id, r.created_at desc, r.id desc
  ) s;
$$;

-- ───────────────────────── 실행 권한 ─────────────────────────

drop function public.analysis_request(uuid, uuid, uuid, text);

create function public.analysis_request(
  p_operation_id uuid, p_meeting_id uuid, p_source_revision_id uuid, p_mode text, p_user_instructions text default null
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
  -- 추가 요청사항: 앞뒤 공백만 정리하고 내용은 그대로 보관한다(분석 이력 = 작업 단위).
  v_instructions text := nullif(btrim(p_user_instructions), '');
begin
  v_hash := app_private.request_hash('analysis.request', jsonb_build_object(
    'meeting_id', p_meeting_id, 'source_revision_id', p_source_revision_id, 'mode', p_mode,
    'user_instructions', v_instructions));
  v_replay := app_private.receipt_begin(v_uid, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  if p_mode is null or p_mode not in ('initial', 'rerun') then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'mode는 initial 또는 rerun이어야 합니다.');
  end if;
  if char_length(v_instructions) > 2000 then
    perform app_private.api_error('VALIDATION_FAILED', 400, '추가 요청사항은 2000자 이하여야 합니다.');
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

  insert into public.analysis_jobs (user_id, meeting_id, source_revision_id, config_hash, run_no, status, user_instructions)
  values (v_uid, p_meeting_id, p_source_revision_id, app_private.analysis_config_hash(), v_run, 'queued', v_instructions)
  returning * into v_job;

  perform app_private.append_change(v_uid, 'analysis_job', v_job.id, v_job.version, 'upsert', app_private.job_json(v_job));
  v_resp := app_private.job_json(v_job) || '{"deduplicated": false}';
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 202, v_resp);
  return v_resp;
end;
$$;

revoke all on function public.analysis_request(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.analysis_request(uuid, uuid, uuid, text, text) to authenticated;
revoke all on function public.meeting_purge(uuid, uuid, integer) from public, anon;
grant execute on function public.meeting_purge(uuid, uuid, integer) to authenticated;
revoke all on function public.meeting_summaries() from public, anon;
grant execute on function public.meeting_summaries() to authenticated;
revoke all on function app_private.validate_candidate_shape(jsonb, text) from public, anon, authenticated;
revoke all on function app_private.validate_candidate_registrable(jsonb) from public, anon, authenticated;
revoke all on function app_private.validate_analysis_payload(jsonb) from public, anon, authenticated;
revoke all on function app_private.analysis_config_hash() from public, anon, authenticated;
