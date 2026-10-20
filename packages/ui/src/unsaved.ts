// 저장하지 않은 편집 보호 (docs/plans/2026-10-20-rich-text.md 7장).
// 편집 화면이 useUnsavedChanges(dirty)로 알리면, 탭·화면 이동·뒤로가기·창 닫기 전에 confirmLeave()로 확인한다.
// 앱 강제 종료·시스템 종료는 확인할 수 없다(한계).

import { useEffect, useRef } from "react";

const dirty = new Set<symbol>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.size === 0) return;
  e.preventDefault();
  e.returnValue = "";
}

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}

export const LEAVE_MESSAGE = "저장하지 않은 편집이 있습니다. 저장하지 않고 이동할까요? (편집한 내용은 사라집니다)";

/** 이동해도 되면 true. 저장 안 한 편집이 있으면 확인창을 띄운다. */
export function confirmLeave(): boolean {
  return dirty.size === 0 || window.confirm(LEAVE_MESSAGE);
}

/** 저장 안 한 편집이 생기거나 없어질 때 알림(뒤로가기 가로채기용) */
export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 편집 화면에서 호출한다. 화면이 사라지면 자동으로 해제된다. */
export function useUnsavedChanges(isDirty: boolean): void {
  const key = useRef(Symbol("unsaved")).current;
  useEffect(() => {
    if (!isDirty) return;
    dirty.add(key);
    if (dirty.size === 1) window.addEventListener("beforeunload", onBeforeUnload);
    notify();
    return () => {
      dirty.delete(key);
      if (dirty.size === 0) window.removeEventListener("beforeunload", onBeforeUnload);
      notify();
    };
  }, [isDirty, key]);
}

/**
 * 안드로이드 뒤로가기: 저장 안 한 편집이 있는 동안 기록(history)을 하나 쌓아 두고,
 * 뒤로가기가 오면 확인한다. 취소하면 그대로 머물고, 이동하면 onBack을 부른다.
 */
export function useBackGuard(onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    let armed = false;
    const arm = () => {
      if (dirty.size > 0 && !armed) {
        history.pushState({ unsavedGuard: true }, "");
        armed = true;
      } else if (dirty.size === 0 && armed) {
        // 저장·취소로 편집이 끝나면 쌓아 둔 기록을 걷어 다음 뒤로가기가 바로 동작하게 한다
        armed = false;
        history.back();
      }
    };
    const onPop = () => {
      if (!armed) return;
      armed = false;
      if (window.confirm(LEAVE_MESSAGE)) cb.current();
      else arm();
    };
    const unsub = subscribeUnsaved(arm);
    window.addEventListener("popstate", onPop);
    arm();
    return () => {
      unsub();
      window.removeEventListener("popstate", onPop);
    };
  }, []);
}
