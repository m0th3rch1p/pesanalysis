/** Quiet-hours arithmetic in Africa/Nairobi (UTC+3, no DST). Pure. */
import { DAY_MS, EAT_OFFSET_MS, dayStartMs, dayOf } from "../expect/eat.js";

export const MIN_MS = 60_000;
export const HOUR_MS = 3_600_000;

export interface QuietHours {
  /** minutes after 00:00 EAT; window may wrap midnight (default 22:00 -> 07:00) */
  startMin: number;
  endMin: number;
}
export const DEFAULT_QUIET: QuietHours = { startMin: 22 * 60, endMin: 7 * 60 };

export function minuteOfDayEat(ms: number): number {
  const m = Math.floor((((ms + EAT_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / MIN_MS);
  return m;
}

export function inQuietHours(ms: number, q: QuietHours = DEFAULT_QUIET): boolean {
  if (q.startMin === q.endMin) return false;
  const m = minuteOfDayEat(ms);
  return q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
}

/** First instant >= ms that is outside quiet hours (ms itself when already outside). */
export function nextQuietEnd(ms: number, q: QuietHours = DEFAULT_QUIET): number {
  if (!inQuietHours(ms, q)) return ms;
  const m = minuteOfDayEat(ms);
  const dayStart = dayStartMs(dayOf(ms));
  const sameDay = dayStart + q.endMin * MIN_MS;
  if (q.startMin < q.endMin) return sameDay; // non-wrapping window: end is later today
  return m >= q.startMin ? sameDay + DAY_MS : sameDay;
}

/** 00:00 EAT of the day after `ms`. */
export function endOfDayEat(ms: number): number { return dayStartMs(dayOf(ms)) + DAY_MS; }
/** Epoch ms of HH:MM EAT on the EAT day containing ms. */
export function atMinuteOfDay(ms: number, min: number): number { return dayStartMs(dayOf(ms)) + min * MIN_MS; }
