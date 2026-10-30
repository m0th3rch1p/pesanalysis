/** Local-time recurring occurrences as one-off DATE triggers. Workaround for weekly triggers that do not fire on this ROM. */
export function nextOccurrences(jsWeekday: number, hour: number, minute: number, now = Date.now(), count = 8): number[] {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let delta = (jsWeekday - d.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now) delta = 7;
  d.setDate(d.getDate() + delta);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 7);
  }
  return out;
}

export function occurrenceStamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function occurrenceMinute(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
