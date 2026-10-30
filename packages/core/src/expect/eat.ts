/**
 * Africa/Nairobi calendar arithmetic. EAT is UTC+3 all year (no DST), so a fixed offset is exact.
 * Days are "YYYY-MM-DD" strings; a "day number" is whole days since 1970-01-01 in EAT.
 */
export const EAT_OFFSET_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;

export type DayStr = string;

export function dayNumber(ms: number): number {
  return Math.floor((ms + EAT_OFFSET_MS) / DAY_MS);
}

export function dayStrOfNumber(n: number): DayStr {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function parseDay(d: DayStr): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`bad day: ${d}`);
  const y = +m[1]!, mo = +m[2]!, da = +m[3]!;
  const t = Date.UTC(y, mo - 1, da);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) throw new Error(`bad day: ${d}`);
  return t / DAY_MS;
}

export function dayOf(ms: number): DayStr { return dayStrOfNumber(dayNumber(ms)); }
/** Epoch ms (UTC) of 00:00 EAT on that day. */
export function dayStartMs(d: DayStr | number): number {
  const n = typeof d === "number" ? d : parseDay(d);
  return n * DAY_MS - EAT_OFFSET_MS;
}
export function addDays(d: DayStr, n: number): DayStr { return dayStrOfNumber(parseDay(d) + n); }
export function diffDays(a: DayStr, b: DayStr): number { return parseDay(a) - parseDay(b); }
/** 0 = Sunday .. 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekdayOf(d: DayStr | number): number {
  const n = typeof d === "number" ? d : parseDay(d);
  return (((n + 4) % 7) + 7) % 7;
}

export function ymd(d: DayStr): { y: number; m: number; d: number } {
  const [y, m, da] = d.split("-").map(Number) as [number, number, number];
  return { y, m, d: da };
}
export function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function mkDay(y: number, m: number, d: number): DayStr {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Day-of-month clamped to the month length (31 -> 28/29/30). */
export function clampedDay(y: number, m: number, dom: number): DayStr {
  return mkDay(y, m, Math.min(Math.max(1, dom), daysInMonth(y, m)));
}
