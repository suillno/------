// 일정 후보 확인·수정·승인. Google 등록은 '승인하고 캘린더 등록'을 누르고 확인했을 때만 한다.
// 후보를 수정하면 서버가 이전 승인을 무효화하므로 다시 승인해야 한다.

import { useCallback, useEffect, useRef, useState } from "react";
import { SingleFlight, approveAllSequentially, candidateView, isValidTimeZone, planBulkApprove, type BulkApproveResult } from "@meeting/client-core";
import type { CandidatePatch, CandidatePayload, EventCandidate, MeetingAnalysisState } from "@meeting/contracts";
import { Badge, ConfirmBox, ErrorText, errorMessage, needsRefresh } from "../../common";
import { useApp } from "../../context";

const KEEP = new Set(["approved", "registering", "registered", "failed"]);

/**
 * 최신 결과의 후보와, 이전 결과 중 승인·등록이 진행된 후보만 보여준다.
 * 거절한 후보는 보이지 않는다(서버에는 거절 기록이 남는다). hidden은 이전 분석의 검토 전 후보 수다.
 */
export function visibleCandidates(state: MeetingAnalysisState): { shown: EventCandidate[]; hidden: number } {
  const latestId = state.latest_result?.id;
  const live = state.candidates.filter((c) => c.status !== "rejected");
  const shown = live.filter((c) => c.result_id === latestId || KEEP.has(c.status));
  return { shown, hidden: live.length - shown.length };
}

export function CandidateList({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { api, google } = useApp();
  const { shown, hidden } = visibleCandidates(state);
  const flight = useRef(new SingleFlight()).current;
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<"confirming" | "running" | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<BulkApproveResult[] | null>(null);

  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  if (shown.length === 0) return null;
  const plan = planBulkApprove(shown, { googleConnected: Boolean(google?.connected), dirtyIds });

  async function approveAll() {
    // 확인창에 보여 준 그 후보·그 버전으로만 승인한다
    const targets = plan.targets;
    setBulk("running");
    setResults(null);
    setProgress({ done: 0, total: targets.length });
    try {
      setResults(await approveAllSequentially(api, flight, targets, (done, total) => setProgress({ done, total })));
    } finally {
      setBulk(null);
      await refresh();
    }
  }

  const failed = results?.filter((r) => r.status === "failed") ?? [];
  const succeeded = results?.filter((r) => r.status !== "failed").length ?? 0;

  return (
    <section className="panel" aria-label="일정 후보">
      <h3>일정 후보</h3>
      <p className="muted">내용을 확인·수정한 뒤 ‘승인하고 캘린더 등록’을 눌러야만 Google 캘린더에 등록됩니다. 참석자 초대는 보내지 않습니다.</p>

      {bulk === "confirming" ? (
        <ConfirmBox
          title={`일정 ${plan.targets.length}건 Google 캘린더 등록 확인`}
          confirmLabel={`${plan.targets.length}건 등록`}
          busy={false}
          onConfirm={() => void approveAll()}
          onCancel={() => setBulk(null)}
        >
          <ul className="bulk-list">
            {plan.targets.map((c) => (
              <li key={c.id}>
                <strong>{c.payload.title}</strong> · {describeWhen(c.payload)}
                {c.payload.location ? ` · 장소 ${c.payload.location}` : ""}
              </li>
            ))}
          </ul>
          {plan.skipped.length > 0 && (
            <>
              <p className="muted">다음 후보는 이번에 등록하지 않습니다.</p>
              <ul className="bulk-list muted">
                {plan.skipped.map((s) => <li key={s.candidate.id}>{s.candidate.payload.title} — {s.reason}</li>)}
              </ul>
            </>
          )}
          <p className="muted">
            각 일정 설명에 ‘원본 회의록 보기’ 링크가 들어갑니다. 기본 캘린더{google?.account_email ? ` (${google.account_email})` : ""}에 이 내용 그대로 등록하며, 참석자 초대·알림 메일은 보내지 않습니다.
          </p>
        </ConfirmBox>
      ) : (
        plan.targets.length > 1 && (
          <p className="row">
            <button type="button" className="primary" disabled={bulk !== null} onClick={() => { setResults(null); setBulk("confirming"); }}>
              {bulk === "running" ? `등록 중… (${progress.done}/${progress.total})` : `모두 승인하고 캘린더 등록 (${plan.targets.length}건)`}
            </button>
            {plan.skipped.length > 0 && <span className="muted">확인이 필요한 {plan.skipped.length}건은 제외됩니다</span>}
          </p>
        )
      )}
      {results && (
        <div role="status">
          {succeeded > 0 && <p className="ok">{succeeded}건을 Google 캘린더에 등록했습니다.</p>}
          {failed.length > 0 && (
            <>
              <p className="error">{failed.length}건은 등록하지 못했습니다. 해당 일정에서 확인한 뒤 다시 시도하세요.</p>
              <ul className="bulk-list">
                {failed.map((r) => <li key={r.candidate.id}>{r.candidate.payload.title}{r.error ? ` — ${errorMessage(r.error)}` : ""}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {shown.map((c) => (
        <CandidateCard key={c.id} candidate={c} refresh={refresh} locked={bulk !== null} onDirtyChange={onDirtyChange} />
      ))}
      {hidden > 0 && <p className="muted">이전 분석의 검토 전 후보 {hidden}개는 숨겼습니다.</p>}
    </section>
  );
}

type Form = Pick<CandidatePayload, "title" | "start_local" | "end_local" | "time_zone" | "all_day" | "description"> & { location: string | null };

function toForm(p: CandidatePayload): Form {
  return {
    title: p.title, start_local: p.start_local, end_local: p.end_local, time_zone: p.time_zone, all_day: p.all_day,
    description: p.description, location: p.location ?? null,
  };
}

function diff(form: Form, p: CandidatePayload): CandidatePatch {
  const patch: CandidatePatch = {};
  for (const k of Object.keys(form) as (keyof Form)[]) {
    const current = k === "location" ? (p.location ?? null) : p[k];
    if (form[k] !== current) (patch as Record<string, unknown>)[k] = form[k];
  }
  return patch;
}

function describeWhen(p: Pick<CandidatePayload, "start_local" | "end_local" | "all_day" | "time_zone">): string {
  if (!p.start_local) return "날짜 미정";
  const fmt = (s: string) => s.replace("T", " ").slice(0, 16);
  const range = p.end_local && p.end_local !== p.start_local ? `${fmt(p.start_local)} ~ ${fmt(p.end_local)}` : fmt(p.start_local);
  return p.all_day ? `${range} (종일)` : `${range} (${p.time_zone})`;
}

function CandidateCard({ candidate: c, refresh, locked = false, onDirtyChange }: {
  candidate: EventCandidate;
  refresh: () => Promise<void>;
  /** '모두 승인' 확인·진행 중에는 이 카드의 수정·승인·거절을 막는다(확인창 내용과 실제 등록 내용이 같도록) */
  locked?: boolean;
  onDirtyChange?: (id: string, dirty: boolean) => void;
}) {
  const { api, google, platform } = useApp();
  const flight = useRef(new SingleFlight()).current;
  // base: 입력값을 불러온 서버 후보. 수정 여부·patch·base_version은 모두 base 기준이다.
  // 그래서 다른 기기가 먼저 바꿨다면 저장 시 409로 알리고 덮어쓰지 않는다.
  const [base, setBase] = useState(() => ({ version: c.version, form: toForm(c.payload), payload: c.payload }));
  const [form, setForm] = useState<Form>(base.form);
  const [forceSync, setForceSync] = useState(false);
  const [pending, setPending] = useState<"save" | "approve" | "retry" | "reject" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const patch = diff(form, base.payload);
  const dirty = Object.keys(patch).length > 0;
  if (c.version !== base.version && (!dirty || forceSync)) {
    const next = { version: c.version, form: toForm(c.payload), payload: c.payload };
    setBase(next);
    setForm(next.form);
    setForceSync(false);
  }

  useEffect(() => {
    onDirtyChange?.(c.id, dirty);
  }, [c.id, dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(c.id, false), [c.id, onDirtyChange]);

  const busy = pending !== null || locked;
  const view = candidateView(c, { googleConnected: Boolean(google?.connected), pending: busy, dirty });
  const tzInvalid = !isValidTimeZone(form.time_zone);

  async function act(kind: "save" | "approve" | "retry" | "reject", fn: (op: string) => Promise<unknown>) {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      const out = await flight.run(`${kind}:${c.id}`, fn);
      if (kind === "save") setForceSync(true);
      if (kind === "approve" || kind === "retry") {
        const o = out as { status: string; error_code?: string };
        setNotice(o.status === "succeeded" ? "Google 캘린더에 등록했습니다." : o.status === "running" ? "등록 중입니다." : null);
      }
      setConfirming(false);
    } catch (e) {
      setError(errorMessage(e));
      if (kind === "save" && needsRefresh(e)) setConflict(true);
      setConfirming(false);
    } finally {
      setPending(null);
      await refresh();
    }
  }

  const timeType = form.all_day ? "date" : "datetime-local";
  const trimTime = (v: string | null) => (v ? (form.all_day ? v.slice(0, 10) : v.slice(0, 16)) : "");

  return (
    <article className="candidate">
      <div className="row between">
        <strong>{c.payload.title}</strong>
        <Badge tone={view.tone}>{pending === "approve" || pending === "retry" ? "등록 요청 중…" : view.statusLabel}</Badge>
      </div>
      <p className="muted">{describeWhen(c.payload)}</p>
      {c.payload.location && <p className="muted">목적지: {c.payload.location}{c.payload.location_uncertain ? " (확인 필요)" : ""}</p>}
      {c.payload.evidence && <p className="evidence">근거: {c.payload.evidence}</p>}
      {view.message && <p className={view.tone === "error" ? "error" : "muted"}>{view.message}</p>}
      {view.canEdit && c.payload.location_uncertain && !dirty && (
        <p className="row">
          <button type="button" disabled={busy}
            onClick={() => void act("save", (op) => api.patchCandidate(op, c.id, base.version, { location: c.payload.location ?? "" }))}>
            이 목적지가 맞음
          </button>
          <span className="muted">아니면 아래 목적지를 고치거나 지우세요.</span>
        </p>
      )}
      {c.link?.html_link && (
        <p>
          <a href={c.link.html_link} onClick={(e) => { e.preventDefault(); void platform.openExternal(c.link!.html_link!); }}>
            Google 캘린더에서 보기
          </a>
        </p>
      )}

      {view.canEdit && (
        <fieldset className="candidate-form" disabled={busy}>
          <label>
            제목
            <input value={form.title} maxLength={300} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={form.all_day}
              onChange={(e) => setForm({
                ...form, all_day: e.target.checked,
                start_local: form.start_local ? (e.target.checked ? form.start_local.slice(0, 10) : `${form.start_local.slice(0, 10)}T09:00`) : null,
                end_local: form.end_local ? (e.target.checked ? form.end_local.slice(0, 10) : `${form.end_local.slice(0, 10)}T10:00`) : null,
              })}
            /> 종일
          </label>
          <div className="row">
            <label>
              시작
              <input type={timeType} value={trimTime(form.start_local)} onChange={(e) => setForm({ ...form, start_local: e.target.value || null })} />
            </label>
            <label>
              {form.all_day ? "마지막 날" : "종료"}
              <input type={timeType} value={trimTime(form.end_local)} onChange={(e) => setForm({ ...form, end_local: e.target.value || null })} />
            </label>
          </div>
          {!form.all_day && (
            <label>
              시간대 (IANA)
              <input value={form.time_zone} onChange={(e) => setForm({ ...form, time_zone: e.target.value })} aria-invalid={tzInvalid} />
            </label>
          )}
          <label>
            목적지 (원문에 있을 때만, 하나만)
            <input value={form.location ?? ""} maxLength={200} placeholder="없으면 비워 두세요"
              onChange={(e) => setForm({ ...form, location: e.target.value || null })} />
            <span className="muted">
              {form.location ? "승인하면 캘린더 '장소'에 넣고 설명에 네이버 지도 검색 링크를 추가합니다." : "목적지가 없으면 장소와 지도 링크를 넣지 않습니다."}
            </span>
          </label>
          <label>
            설명 (선택)
            <textarea rows={2} maxLength={2000} value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value || null })} />
          </label>
          <div className="row">
            <button type="button" disabled={!dirty || tzInvalid || busy}
              onClick={() => void act("save", (op) => api.patchCandidate(op, c.id, base.version, patch))}>
              {pending === "save" ? "저장 중…" : "수정 저장"}
            </button>
            {dirty && <span className="muted">수정하면 다시 승인해야 합니다</span>}
          </div>
        </fieldset>
      )}

      {confirming ? (
        <ConfirmBox
          title="Google 캘린더 등록 확인"
          confirmLabel="등록"
          busy={busy}
          onConfirm={() => void act("approve", (op) => api.approveAndRegister(op, c))}
          onCancel={() => setConfirming(false)}
        >
          <dl className="summary">
            <dt>제목</dt><dd>{c.payload.title}</dd>
            <dt>일시</dt><dd>{describeWhen(c.payload)}</dd>
            <dt>장소</dt><dd>{c.payload.location ? `${c.payload.location} (설명에 네이버 지도 링크)` : "없음"}</dd>
            <dt>설명</dt><dd>‘원본 회의록 보기’ 링크 포함</dd>
            <dt>캘린더</dt><dd>기본 캘린더{google?.account_email ? ` (${google.account_email})` : ""}</dd>
          </dl>
          <p className="muted">이 내용 그대로 등록합니다. 참석자 초대·알림 메일은 보내지 않습니다.</p>
        </ConfirmBox>
      ) : (
        <div className="row">
          {view.approve && (
            <button type="button" className="primary" disabled={!view.approve.enabled} title={view.approve.reason} onClick={() => setConfirming(true)}>
              {view.approve.label}
            </button>
          )}
          {view.retry && c.calendar_job && (
            <button type="button" className="primary" disabled={!view.retry.enabled} title={view.retry.reason}
              onClick={() => void act("retry", (op) => api.retryCalendarJob(op, c.calendar_job!.id))}>
              {pending === "retry" ? "재시도 중…" : view.retry.label}
            </button>
          )}
          {view.reject && (
            <button type="button" disabled={!view.reject.enabled} onClick={() => void act("reject", (op) => api.rejectCandidate(op, c.id, c.version))}>
              {view.reject.label}
            </button>
          )}
        </div>
      )}
      {view.approve && !view.approve.enabled && view.approve.reason && <p className="muted">{view.approve.reason}</p>}
      {conflict && (
        <p className="row">
          <span className="muted">입력한 내용은 그대로 두었습니다.</span>
          <button type="button" onClick={() => { setForceSync(true); setConflict(false); setError(null); }}>최신 내용 불러오기</button>
        </p>
      )}
      {notice && <p className="ok" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>
    </article>
  );
}
