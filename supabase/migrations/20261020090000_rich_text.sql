-- 2026-10-20 서식 표시·편집 (docs/plans/2026-10-20-rich-text.md, ADR 0005)
--
-- 1. 분석 기준 revision: meetings.analysis_revision_id
--    저장할 때마다 version·revision_id(이력)는 늘어나지만, AI에 전달되는 실제 텍스트(제목·일시·시간대·본문의 읽는 텍스트)가
--    같으면 analysis_revision_id를 그대로 둔다. 원문 변경(stale) 판정은 모두 이 값과 비교한다.
--    ‘서식만 바뀜’ 판정은 Markdown 해석이 필요해 Edge Function(meeting-save)이 공유 변환 코드로 하고,
--    서비스 전용 svc_meeting_patch만 analysis_revision_id를 유지할 수 있다. 사용자 경로 meeting_patch는
--    지금처럼 항상 원문 변경으로 처리한다(서버 판정 우회 불가, 이전 버전 앱 호환).
-- 2. 편집본 저장 한도: 보이는 글자 4000(요약)·1000(결정 항목)은 그대로, 서식 포함 저장 한도 12000·3000.
--    보이는 글자 수는 Edge Function(notes-save)이 계산해 서비스 전용 svc_meeting_notes_patch로 넘긴다.
--    사용자 경로 meeting_notes_patch는 지금 한도(저장 길이 4000·1000)를 유지한다.
-- 3. 글자색: <span style="color:#rrggbb"> 형식은 팔레트 색만 허용(모든 저장 경로).

-- ───────── 1. 분석 기준 revision ─────────

alter table public.meetings add column analysis_revision_id uuid;
update public.meetings set analysis_revision_id = revision_id;
alter table public.meetings alter column analysis_revision_id set not null;
alter table public.meetings
  add constraint meetings_analysis_revision_fk
  foreign key (analysis_revision_id, id, user_id)
  references public.meeting_revisions (id, meeting_id, user_id)
  deferrable initially deferred;

-- ───────── 2. 편집본 저장 한도 ─────────

alter table public.meeting_notes drop constraint meeting_notes_summary_check;
alter table public.meeting_notes add constraint meeting_notes_summary_check check (char_length(summary) <= 12000);

-- ───────── 3. 글자색 팔레트 ─────────

-- supabase/functions/_shared/richtext.ts PALETTE와 같아야 한다(richtext.test.ts가 비교한다).
create function app_private.palette_colors() returns text[]
language sql immutable set search_path = ''
as $$
  select array['#c92a2a', '#b4430b', '#8a6100', '#2b7a3b', '#0b6e7f', '#1864ab', '#6741d9', '#a61e4d', '#495057'];
$$;

create function app_private.validate_rich_colors(p_text text, p_field text) returns void
language plpgsql immutable set search_path = ''
as $$
declare
  v_color text;
begin
  if p_text is null then
    return;
  end if;
  for v_color in
    select lower(m[1]) from regexp_matches(p_text, '<span\s+style\s*=\s*"\s*color\s*:\s*(#[0-9a-fA-F]{6})\s*;?\s*">', 'g') as m
  loop
    if not (v_color = any (app_private.palette_colors())) then
      perform app_private.api_error('VALIDATION_FAILED', 400, '허용하지 않는 글자색입니다.',
        jsonb_build_object('field', p_field, 'color', v_color));
    end if;
  end loop;
end;
$$;


-- app_private.validate_meeting_fields
create or replace function app_private.validate_meeting_fields(p_title text, p_body text, p_time_zone text)
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
  perform app_private.validate_rich_colors(p_body, 'body');
  -- 약어(KST)나 POSIX 문자열이 아닌 IANA 이름만 허용한다.
  if p_time_zone is null
     or p_time_zone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$'
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'time_zone은 IANA 시간대 이름이어야 합니다.');
  end if;
end;
$$;


-- public.meeting_create
create or replace function public.meeting_create(
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
  v_rev uuid := gen_random_uuid();
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
    (id, user_id, title, body, meeting_at, meeting_local_date, time_zone, version, revision_id, analysis_revision_id)
  values
    (p_id, v_uid, p_title, p_body, v_at, (v_at at time zone p_time_zone)::date, p_time_zone,
     1, v_rev, v_rev)
  returning * into v_row;

  perform app_private.record_meeting_revision(v_row);
  v_resp := app_private.meeting_json(v_row);
  perform app_private.append_change(v_uid, 'meeting', v_row.id, v_row.version, 'upsert', v_resp);
  perform app_private.receipt_store(v_uid, p_operation_id, v_hash, 201, v_resp);
  return v_resp;
end;
$$;


-- public.analysis_request
create or replace function public.analysis_request(
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
  -- 분석 기준 revision 또는 현재 revision(이전 버전 앱)을 받고, 작업에는 분석 기준 revision을 기록한다.
  if p_source_revision_id is distinct from v_meeting.analysis_revision_id and p_source_revision_id is distinct from v_meeting.revision_id then
    perform app_private.api_error('STALE_SOURCE', 409, '회의록이 바뀌었습니다. 최신 내용을 확인한 뒤 실행하세요.',
      jsonb_build_object('current_version', v_meeting.version, 'current_revision_id', v_meeting.revision_id,
        'current_analysis_revision_id', v_meeting.analysis_revision_id));
  end if;
  p_source_revision_id := v_meeting.analysis_revision_id;

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


-- public.analysis_claim
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
    if v_meeting.deleted_at is null and v_meeting.analysis_revision_id = v_job.source_revision_id then
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


-- public.analysis_submit_result
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
  v_stale := v_meeting.deleted_at is not null or v_meeting.analysis_revision_id <> v_job.source_revision_id;

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


-- public.meeting_analysis_state
create or replace function public.meeting_analysis_state(p_meeting_id uuid) returns jsonb
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
           'stale', r.stale or r.source_revision_id <> v_meeting.analysis_revision_id,
           'created_at', r.created_at, 'payload', r.validated_payload)
  into v_result
  from public.analysis_results r
  where r.meeting_id = p_meeting_id and r.user_id = v_uid
  order by r.created_at desc, r.id desc limit 1;

  select app_private.note_json(n) || jsonb_build_object(
           'based_on_current_revision', n.source_revision_id = v_meeting.analysis_revision_id)
  into v_note
  from public.meeting_notes n where n.meeting_id = p_meeting_id and n.user_id = v_uid;

  select coalesce(jsonb_agg(app_private.candidate_json(c) || jsonb_build_object(
           'stale', c.source_revision_id <> v_meeting.analysis_revision_id or v_meeting.deleted_at is not null,
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
      'revision_id', v_meeting.revision_id, 'analysis_revision_id', v_meeting.analysis_revision_id,
      'deleted', v_meeting.deleted_at is not null),
    'job', v_job,
    'latest_result', v_result,
    'notes', v_note,
    'candidates', v_candidates
  );
end;
$$;


-- public.meeting_summaries
create or replace function public.meeting_summaries() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.analyzed_at desc), '[]'::jsonb)
  from (
    select distinct on (m.id)
      m.id as meeting_id, m.title, m.meeting_at, m.time_zone,
      r.id as result_id,
      left(r.validated_payload ->> 'summary', 160) as summary_preview,
      r.created_at as analyzed_at,
      (r.stale or r.source_revision_id <> m.analysis_revision_id) as stale,
      exists (select 1 from public.meeting_notes n where n.meeting_id = m.id and n.deleted_at is null) as has_user_notes
    from public.meetings m
    join public.analysis_results r on r.meeting_id = m.id and r.user_id = m.user_id
    where m.user_id = auth.uid() and m.deleted_at is null
    order by m.id, r.created_at desc, r.id desc
  ) s;
$$;


-- public.candidate_approve
create or replace function public.candidate_approve(
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
  if v_meeting.deleted_at is not null or v_meeting.analysis_revision_id <> v_c.source_revision_id then
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


-- public.meeting_notes_apply_result
create or replace function public.meeting_notes_apply_result(
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
  if v_result.stale or v_result.source_revision_id <> v_meeting.analysis_revision_id then
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


-- public.analysis_retry
create or replace function public.analysis_retry(p_operation_id uuid, p_job_id uuid) returns jsonb
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
  if v_meeting.deleted_at is not null or v_meeting.analysis_revision_id <> v_job.source_revision_id then
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


-- public.meeting_notes_patch
create or replace function public.meeting_notes_patch(
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
    perform app_private.validate_rich_colors(p_patch ->> 'summary', 'summary');
  end if;
  if p_patch ? 'decisions' then
    if jsonb_typeof(p_patch -> 'decisions') <> 'array' or jsonb_array_length(p_patch -> 'decisions') > 50 then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'decisions가 올바르지 않습니다.');
    end if;
    for v_item in select value from jsonb_array_elements(p_patch -> 'decisions') loop
      perform app_private.require_string(v_item, 'patch.decisions[]', 0, 1000, false);
      perform app_private.validate_rich_colors(v_item #>> '{}', 'decisions');
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


-- ───────── 회의 수정: 사용자 경로와 서버 판정 경로 ─────────

-- p_keep_analysis = true면 분석 기준 revision을 유지한다(서버가 서식만 바뀐 것으로 판정한 경우만).
-- p_expected_analysis_revision_id: 판정에 쓴 분석 기준 revision. 그 사이 바뀌었으면 충돌로 거절한다.
create function app_private.meeting_patch_core(
  p_uid uuid,
  p_operation_id uuid,
  p_id uuid,
  p_base_version integer,
  p_patch jsonb,
  p_keep_analysis boolean,
  p_expected_analysis_revision_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_hash text;
  v_replay jsonb;
  v_row public.meetings;
  v_title text;
  v_body text;
  v_tz text;
  v_at timestamptz;
  v_key text;
  v_resp jsonb;
  v_rev uuid := gen_random_uuid();
begin
  v_hash := app_private.request_hash('meeting.patch', jsonb_build_object(
    'id', p_id, 'base_version', p_base_version, 'patch', p_patch,
    'keep_analysis', p_keep_analysis, 'expected_analysis_revision_id', p_expected_analysis_revision_id));
  v_replay := app_private.receipt_begin(p_uid, p_operation_id, v_hash);
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

  v_row := app_private.lock_meeting_for_write(p_uid, p_id, p_base_version);
  if p_keep_analysis and v_row.analysis_revision_id is distinct from p_expected_analysis_revision_id then
    perform app_private.api_error('VERSION_CONFLICT', 409, '다른 기기에서 수정되었습니다.',
      jsonb_build_object('current_version', v_row.version, 'current_revision_id', v_row.revision_id));
  end if;

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
      revision_id = v_rev,
      analysis_revision_id = case when p_keep_analysis then analysis_revision_id else v_rev end,
      updated_at = now()
  where id = v_row.id and user_id = p_uid and version = p_base_version and deleted_at is null
  returning * into v_row;

  perform app_private.record_meeting_revision(v_row);
  v_resp := app_private.meeting_json(v_row);
  perform app_private.append_change(p_uid, 'meeting', v_row.id, v_row.version, 'upsert', v_resp);
  perform app_private.receipt_store(p_uid, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- 사용자 JWT 경로(이전 버전 앱 포함): 항상 원문 변경으로 처리한다.
create or replace function public.meeting_patch(
  p_operation_id uuid,
  p_id uuid,
  p_base_version integer,
  p_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app_private.meeting_patch_core(app_private.require_uid(), p_operation_id, p_id, p_base_version, p_patch, false, null);
end;
$$;

-- 서버 판정 경로(Edge Function meeting-save, service_role 전용).
-- p_analysis_changed는 공유 변환 코드(_shared/richtext.ts analysisChanged)로 계산한 값이다.
create function public.svc_meeting_patch(
  p_user_id uuid,
  p_operation_id uuid,
  p_id uuid,
  p_base_version integer,
  p_patch jsonb,
  p_expected_analysis_revision_id uuid,
  p_analysis_changed boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_analysis_changed is null or p_expected_analysis_revision_id is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'user_id·expected_analysis_revision_id·analysis_changed가 필요합니다.');
  end if;
  return app_private.meeting_patch_core(p_user_id, p_operation_id, p_id, p_base_version, p_patch,
    not p_analysis_changed, p_expected_analysis_revision_id);
end;
$$;

-- ───────── 편집본 저장: 서버 판정 경로 ─────────

-- 보이는 글자 수(p_summary_visible, p_decisions_visible)는 Edge Function notes-save가
-- 공유 변환 코드(visibleLength)로 계산한다. 저장 길이·개수·글자색은 여기서 다시 검사한다.
create function public.svc_meeting_notes_patch(
  p_user_id uuid,
  p_operation_id uuid,
  p_meeting_id uuid,
  p_base_version integer,
  p_patch jsonb,
  p_summary_visible integer,
  p_decisions_visible integer[]
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_hash text;
  v_replay jsonb;
  v_note public.meeting_notes;
  v_item jsonb;
  v_resp jsonb;
  v_i integer := 0;
begin
  if p_user_id is null then
    perform app_private.api_error('VALIDATION_FAILED', 400, 'user_id가 필요합니다.');
  end if;
  v_hash := app_private.request_hash('notes.patch', jsonb_build_object(
    'meeting_id', p_meeting_id, 'base_version', p_base_version, 'patch', p_patch));
  v_replay := app_private.receipt_begin(p_user_id, p_operation_id, v_hash);
  if v_replay is not null then return v_replay; end if;

  perform app_private.require_keys(p_patch, array['summary', 'decisions'], 'patch');
  if p_patch = '{}'::jsonb then
    perform app_private.api_error('VALIDATION_FAILED', 400, '변경할 필드가 필요합니다.');
  end if;
  if p_patch ? 'summary' then
    perform app_private.require_string(p_patch -> 'summary', 'patch.summary', 0, 12000, false);
    if p_summary_visible is null or p_summary_visible < 0 or p_summary_visible > 4000 then
      perform app_private.api_error('VALIDATION_FAILED', 400, '요약은 보이는 글자 4000자까지 저장할 수 있습니다.',
        jsonb_build_object('field', 'summary', 'visible', p_summary_visible, 'max', 4000));
    end if;
    perform app_private.validate_rich_colors(p_patch ->> 'summary', 'summary');
  end if;
  if p_patch ? 'decisions' then
    if jsonb_typeof(p_patch -> 'decisions') <> 'array' or jsonb_array_length(p_patch -> 'decisions') > 50 then
      perform app_private.api_error('VALIDATION_FAILED', 400, 'decisions가 올바르지 않습니다.');
    end if;
    if p_decisions_visible is null or coalesce(array_length(p_decisions_visible, 1), 0) <> jsonb_array_length(p_patch -> 'decisions') then
      perform app_private.api_error('VALIDATION_FAILED', 400, '결정사항 글자 수 정보가 맞지 않습니다.');
    end if;
    for v_item in select value from jsonb_array_elements(p_patch -> 'decisions') loop
      v_i := v_i + 1;
      perform app_private.require_string(v_item, 'patch.decisions[]', 0, 3000, false);
      if p_decisions_visible[v_i] is null or p_decisions_visible[v_i] < 0 or p_decisions_visible[v_i] > 1000 then
        perform app_private.api_error('VALIDATION_FAILED', 400, '결정사항은 항목마다 보이는 글자 1000자까지 저장할 수 있습니다.',
          jsonb_build_object('field', 'decisions', 'index', v_i - 1, 'visible', p_decisions_visible[v_i], 'max', 1000));
      end if;
      perform app_private.validate_rich_colors(v_item #>> '{}', 'decisions');
    end loop;
  end if;

  select * into v_note from public.meeting_notes where meeting_id = p_meeting_id and user_id = p_user_id for update;
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
  perform app_private.append_change(p_user_id, 'meeting_note', v_note.id, v_note.version, 'upsert', v_resp);
  perform app_private.receipt_store(p_user_id, p_operation_id, v_hash, 200, v_resp);
  return v_resp;
end;
$$;

-- ───────── 권한 ─────────

revoke all on function app_private.meeting_patch_core(uuid, uuid, uuid, integer, jsonb, boolean, uuid) from public, anon, authenticated;
revoke all on function app_private.palette_colors() from public, anon, authenticated;
revoke all on function app_private.validate_rich_colors(text, text) from public, anon, authenticated;
revoke all on function public.svc_meeting_patch(uuid, uuid, uuid, integer, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.svc_meeting_patch(uuid, uuid, uuid, integer, jsonb, uuid, boolean) to service_role;
revoke all on function public.svc_meeting_notes_patch(uuid, uuid, uuid, integer, jsonb, integer, integer[]) from public, anon, authenticated;
grant execute on function public.svc_meeting_notes_patch(uuid, uuid, uuid, integer, jsonb, integer, integer[]) to service_role;
