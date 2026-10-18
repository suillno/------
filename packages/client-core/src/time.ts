// 현지 시각 ↔ UTC instant 변환 (docs/design.md 7장: UTC instant와 IANA time zone을 구분해 저장).

function wallClockMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * "YYYY-MM-DDTHH:MM" 현지 시각을 해당 시간대의 UTC instant(ISO, Z)로 바꾼다.
 * 일광 절약 시간 전환으로 없는 시각이면 null(사용자에게 다시 입력받는다).
 */
export function localToInstant(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const target = Date.UTC(y, mo - 1, d, h, mi, m[6] ? Number(m[6]) : 0);
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - wallClockMs(guess, timeZone);
  return wallClockMs(guess, timeZone) === target ? new Date(guess).toISOString() : null;
}

/** UTC instant를 해당 시간대의 "YYYY-MM-DD HH:MM"로 표시한다. */
export function formatInZone(instant: string, timeZone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return instant;
  return new Date(wallClockMs(ms, timeZone)).toISOString().slice(0, 16).replace("T", " ");
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/.test(tz);
  } catch {
    return false;
  }
}
