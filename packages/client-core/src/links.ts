// 캘린더 일정의 '원본 회의록 보기' 딥링크 해석 (docs/plans/2026-10-19-meeting-features.md 4장).
// 형식: meetingassistant://meeting/<회의 UUID>. 회의 UUID 외의 값(본문·토큰)은 받지 않는다.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MEETING_LINK_SCHEME = "meetingassistant";

/** 딥링크에서 회의 UUID를 꺼낸다. 형식이 다르면 null */
export function parseMeetingLink(url: string): string | null {
  const m = /^meetingassistant:\/\/meeting\/([0-9a-fA-F-]{36})\/?(?:[?#].*)?$/.exec(url.trim());
  if (!m) return null;
  const id = m[1]!.toLowerCase();
  return UUID.test(id) ? id : null;
}
