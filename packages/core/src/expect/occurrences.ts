/** Pure occurrence generator for expected flows. All dates are Africa/Nairobi calendar days. */
import { type DayStr, addDays, clampedDay, diffDays, parseDay, weekdayOf, ymd } from "./eat.js";
import { isPublicHoliday, isWorkingDay, lastWorkingDayOfMonth } from "./holidays-ke.js";

export type ExpectCadence = "once" | "weekly" | "monthly" | "last_working_day" | "custom";
export type HolidayPolicy = "none" | "before" | "after";

export interface CadenceRule {
  cadence: ExpectCadence;
  dayOfMonth?: number | null;
  weekday?: number | null;
  intervalDays?: number | null;
  anchorOn?: DayStr | null;
  holidayPolicy?: HolidayPolicy;
  startsOn?: DayStr | null;
  endsOn?: DayStr | null;
}

export interface GeneratedOccurrence { nominalOn: DayStr; dueOn: DayStr; shifted: boolean }

export function validateCadence(r: CadenceRule): string | null {
  switch (r.cadence) {
    case "once": return r.anchorOn ? null : "once needs anchorOn";
    case "weekly": return r.weekday != null && r.weekday >= 0 && r.weekday <= 6 && Number.isInteger(r.weekday) ? null : "weekly needs weekday 0..6";
    case "monthly": return r.dayOfMonth != null && r.dayOfMonth >= 1 && r.dayOfMonth <= 31 && Number.isInteger(r.dayOfMonth) ? null : "monthly needs dayOfMonth 1..31";
    case "last_working_day": return null;
    case "custom": return r.intervalDays != null && r.intervalDays >= 1 && Number.isInteger(r.intervalDays) && r.anchorOn ? null : "custom needs intervalDays>=1 and anchorOn";
    default: return "unknown cadence";
  }
}

/**
 * Holiday/weekend shift. Day-of-month and one-off dates move off weekends AND public holidays (money moves through banks);
 * weekly and custom-interval rules pick their weekday on purpose, so only public holidays trigger a shift.
 * Outside the holiday table's years only weekends can trigger.
 */
export function shiftDue(nominal: DayStr, policy: HolidayPolicy, cadence: ExpectCadence): DayStr {
  if (policy === "none" || cadence === "last_working_day") return nominal;
  const blocked = cadence === "weekly" || cadence === "custom" ? (d: DayStr) => isPublicHoliday(d) : (d: DayStr) => !isWorkingDay(d);
  const step = policy === "before" ? -1 : 1;
  let d = nominal;
  for (let i = 0; i < 14 && blocked(d); i++) d = addDays(d, step);
  return d;
}

function monthsBetween(from: DayStr, to: DayStr): Array<{ y: number; m: number }> {
  const a = ymd(from), b = ymd(to);
  const out: Array<{ y: number; m: number }> = [];
  let y = a.y, m = a.m;
  while (y < b.y || (y === b.y && m <= b.m)) {
    out.push({ y, m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Unshifted dates of the rule inside [from, to] (inclusive). */
export function nominalDates(r: CadenceRule, from: DayStr, to: DayStr): DayStr[] {
  const out: DayStr[] = [];
  switch (r.cadence) {
    case "once":
      if (r.anchorOn && r.anchorOn >= from && r.anchorOn <= to) out.push(r.anchorOn);
      break;
    case "weekly": {
      if (r.weekday == null) break;
      const start = parseDay(from);
      const first = start + ((r.weekday - weekdayOf(start) + 7) % 7);
      for (let n = first; n <= parseDay(to); n += 7) out.push(addDays("1970-01-01", n));
      break;
    }
    case "monthly":
      if (r.dayOfMonth == null) break;
      for (const { y, m } of monthsBetween(from, to)) {
        const d = clampedDay(y, m, r.dayOfMonth);
        if (d >= from && d <= to) out.push(d);
      }
      break;
    case "last_working_day":
      for (const { y, m } of monthsBetween(from, to)) {
        const d = lastWorkingDayOfMonth(y, m);
        if (d >= from && d <= to) out.push(d);
      }
      break;
    case "custom": {
      if (!r.anchorOn || !r.intervalDays || r.intervalDays < 1) break;
      const gap = diffDays(from, r.anchorOn);
      const k0 = gap <= 0 ? 0 : Math.ceil(gap / r.intervalDays);
      for (let k = k0; ; k++) {
        const d = addDays(r.anchorOn, k * r.intervalDays);
        if (d > to) break;
        if (d >= from) out.push(d);
      }
      break;
    }
  }
  return out;
}

/** Occurrences whose (shifted) due date is in [from, to]. Deterministic and idempotent. */
export function generateOccurrences(r: CadenceRule, from: DayStr, to: DayStr): GeneratedOccurrence[] {
  if (validateCadence(r)) return [];
  const policy = r.holidayPolicy ?? "none";
  const pad = 16; // a shift moves at most 14 days; widen so occurrences crossing the window edge are found
  const noms = nominalDates(r, addDays(from, -pad), addDays(to, pad));
  const seen = new Set<DayStr>();
  const out: GeneratedOccurrence[] = [];
  for (const nominalOn of noms) {
    if (r.startsOn && nominalOn < r.startsOn) continue;
    if (r.endsOn && nominalOn > r.endsOn) continue;
    if (seen.has(nominalOn)) continue;
    seen.add(nominalOn);
    const dueOn = shiftDue(nominalOn, policy, r.cadence);
    if (dueOn < from || dueOn > to) continue;
    out.push({ nominalOn, dueOn, shifted: dueOn !== nominalOn });
  }
  return out.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}

