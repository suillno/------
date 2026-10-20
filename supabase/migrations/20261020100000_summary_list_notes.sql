-- 2026-10-20 요약 목록: 편집본 기준 미리보기 (docs/plans/2026-10-20-rich-text.md 1장)
-- 목록 미리보기는 사용자 편집본을 우선 보여 주고(없으면 최신 AI 결과), 서식을 뺀 글자로 화면이 만든다.
-- 그래서 요약 전체(summary)를 함께 돌려준다. summary_preview는 이전 버전 앱을 위해 남긴다.

create or replace function public.meeting_summaries() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.analyzed_at desc), '[]'::jsonb)
  from (
    select distinct on (m.id)
      m.id as meeting_id, m.title, m.meeting_at, m.time_zone,
      r.id as result_id,
      left(coalesce(n.summary, r.validated_payload ->> 'summary'), 160) as summary_preview,
      coalesce(n.summary, r.validated_payload ->> 'summary') as summary,
      r.created_at as analyzed_at,
      (r.stale or r.source_revision_id <> m.analysis_revision_id) as stale,
      n.id is not null as has_user_notes
    from public.meetings m
    join public.analysis_results r on r.meeting_id = m.id and r.user_id = m.user_id
    left join public.meeting_notes n on n.meeting_id = m.id and n.user_id = m.user_id and n.deleted_at is null
    where m.user_id = auth.uid() and m.deleted_at is null
    order by m.id, r.created_at desc, r.id desc
  ) s;
$$;
