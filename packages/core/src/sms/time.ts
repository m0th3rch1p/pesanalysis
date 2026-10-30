/** Kenya is UTC+3 year-round (no DST). SMS dates carry no zone. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "25/10/26" | "25/10/2026" | "2026-10-25" (ISO, used by Safaricom/Airtel/Equity) + "2:30 PM" / "14:30" -> epoch ms (EAT) */
export function parseEatDateTime(date: string, time: string): number {
  let d = date.trim().replace(/-/g, "/");
  const iso = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(d);
  if (iso) d = `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(d);
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(time.trim());
  if (!dm || !tm) throw new Error(`parseEatDateTime: bad input "${date}" "${time}"`);
  let year = parseInt(dm[3]!, 10);
  if (year < 100) year += 2000;
  let hour = parseInt(tm[1]!, 10);
  const ampm = tm[4]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const utc = Date.UTC(year, parseInt(dm[2]!, 10) - 1, parseInt(dm[1]!, 10), hour, parseInt(tm[2]!, 10), tm[3] ? parseInt(tm[3], 10) : 0);
  return utc - EAT_OFFSET_MS;
}

export function toEatParts(ms: number) {
  const d = new Date(ms + EAT_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

export function formatEat(ms: number): string {
  const p = toEatParts(ms);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const yy = String(p.year % 100).padStart(2, "0");
  return `${p.day}/${p.month}/${yy}|${h12}:${String(p.minute).padStart(2, "0")} ${p.hour >= 12 ? "PM" : "AM"}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Unambiguous display date: `Thu 29 Oct`. Never use formatEat for UI (it must stay dd/mm/yy for parsers). */
export function displayEat(ms: number): string {
  const p = toEatParts(ms);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return `${WEEKDAYS[day]} ${p.day} ${MONTHS[p.month - 1]}`;
}
export function displayEatTime(ms: number): string {
  return `${displayEat(ms)} · ${formatEat(ms).split("|")[1]}`;
}
