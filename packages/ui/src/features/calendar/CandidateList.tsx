// 일정 후보 확인·수정·승인. Google 등록은 '승인하고 캘린더 등록'을 누르고 확인했을 때만 한다.
// 후보를 수정하면 서버가 이전 승인을 무효화하므로 다시 승인해야 한다.

import { useRef, useState } from "react";
import { SingleFlight, candidateView, isValidTimeZone } from "@meeting/client-core";
import type { CandidatePatch, CandidatePayload, EventCandidate, MeetingAnalysisState } from "@meeting/contracts";
import { Badge, ConfirmBox, ErrorText, errorMessage, needsRefresh } from "../../common";
import { useApp } from "../../context";

const KEEP = new Set(["approved", "registering", "registered", "failed"]);

/** 최신 결과의 후보와, 이전 결과 중 승인·등록이 진행된 후보만 보여준다. */
export function visibleCandidates(state: MeetingAnalysisState): { shown: EventCandidate[]; hidden: number } {
  const latestId = state.latest_result?.id;
  const shown = state.candidates.filter((c) => c.result_id === latestId || KEEP.has(c.status));
  return { shown, hidden: state.candidates.length - shown.length };
}

export function CandidateList({ state, refresh }: { state: MeetingAnalysisState; refresh: () => Promise<void> }) {
  const { shown, hidden } = visibleCandidates(state);
  if (state.candidates.length === 0) return null;
  return (
    <section className="panel" aria-label="일정 후보">
      <h3>일정 후보</h3>
      <p className="muted">내용을 확인·수정한 뒤 ‘승인하고 캘린더 등록’을 눌러야만 Google 캘린더에 등록됩니다. 참석자 초대는 보내지 않습니다.</p>
      {shown.map((c) => <CandidateCard key={c.id} candidate={c} refresh={refresh} />)}
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

function CandidateCard({ candidate: c, refresh }: { candidate: EventCandidate; refresh: () => Promise<void> }) {
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

  const view = candidateView(c, { googleConnected: Boolean(google?.connected), pending: pending !== null, dirty });
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
          <button type="button" disabled={pending !== null}
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
        <fieldset className="candidate-form" disabled={pending !== null}>
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
            <button type="button" disabled={!dirty || tzInvalid || pending !== null}
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
          busy={pending !== null}
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
