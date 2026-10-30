/** Opt-in moment nudges (WS6.5). Pure schedule/copy helpers; the app owns OS scheduling. */
import type { DbAdapter } from "../db/migrate.js";
import { DEFAULT_QUIET, type QuietHours } from "../alerts/quiet.js";
import type { HabitRow } from "./categories.js";
import { listHabits } from "./categories.js";
import { inHabitWindow } from "./selector.js";

export interface HabitNudge {
  enabled: boolean;
  /** minutes after 00:00 EAT */
  minuteOfDay: number;
  /** 0=Sunday … 6=Saturday */
  weekdays: number[];
  copyKey?: string;
}

export const NUDGE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

export function parseHabitNudge(raw: unknown): HabitNudge | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  const minute = Number(r.minuteOfDay);
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
  const weekdays = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  if (!weekdays.length) return null;
  return { enabled: r.enabled, minuteOfDay: minute, weekdays: weekdays.sort((a, b) => a - b), ...(typeof r.copyKey === "string" ? { copyKey: r.copyKey } : {}) };
}

export function setHabitNudge(db: DbAdapter, id: number, nudge: HabitNudge | null, now = Date.now()): void {
  const clean = nudge ? parseHabitNudge(nudge) : null;
  if (nudge && !clean) throw new Error("invalid habit nudge");
  db.run(`UPDATE habits SET nudge_json = ?, updated_at = ? WHERE id = ?`, [clean ? JSON.stringify(clean) : null, now, id]);
}

/** 30 minutes before the habit window starts; 20:00 when the habit has no window. */
export function suggestedNudgeMinute(habit: Pick<HabitRow, "selector">): number {
  const start = habit.selector.window?.startMin;
  return start == null ? 20 * 60 : (start - 30 + 1440) % 1440;
}

/** Default weekdays: the weekdays on which the habit actually happened in the last 8 weeks, else every day. */
export function suggestedNudgeWeekdays(db: DbAdapter, habit: HabitRow, now = Date.now()): number[] {
  const from = now - 56 * 86_400_000;
  const rows = db.all(
    `SELECT DISTINCT CAST(strftime('%w', t.occurred_at/1000, 'unixepoch', '+3 hours') AS INTEGER) AS day
       FROM transactions t
      WHERE t.role = 'transaction' AND t.direction = ? AND t.occurred_at >= ?
        AND EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL AND tl.label_id IN (${(habit.selector.labels ?? [-1]).map(() => "?").join(",")}))`,
    [habit.selector.direction === "in" ? "in" : "out", from, ...(habit.selector.labels ?? [-1])],
  ) as Array<{ day: number }>;
  const days = rows.map((r) => Number(r.day)).filter((d) => d >= 0 && d <= 6);
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : [...NUDGE_WEEKDAYS];
}

/** Keep the nudge outside quiet hours (move to quiet end on the same weekday). */
export function adjustNudgeMinute(minute: number, q: QuietHours = DEFAULT_QUIET): number {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const inside = q.startMin === q.endMin ? false : q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
  return inside ? q.endMin : m;
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60) % 24, m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface NudgeSchedule { habitId: number; weekday: number; minute: number; title: string; body: string }

/**
 * One weekly trigger per chosen weekday. Paused/archived habits and disabled nudges produce none.
 * The body names the habit, not a transaction or an amount; the actions live in the notification category.
 */
export function nudgeSchedules(habits: HabitRow[], q: QuietHours = DEFAULT_QUIET): NudgeSchedule[] {
  const out: NudgeSchedule[] = [];
  for (const h of habits) {
    if (h.status !== "active") continue;
    const n = parseHabitNudge(h.nudge);
    if (!n?.enabled) continue;
    const minute = adjustNudgeMinute(n.minuteOfDay, q);
    for (const weekday of n.weekdays) {
      out.push({
        habitId: h.id, weekday, minute,
        title: h.name,
        body: `It's ${formatMinute(minute)}. Check in on ${h.name}?`,
      });
    }
  }
  return out;
}

export function nudgeHabits(db: DbAdapter): HabitRow[] {
  return listHabits(db, "active").filter((h) => {
    const n = parseHabitNudge(h.nudge);
    return !!n?.enabled;
  });
}

/** Used by tests and the UI preview: does the current clock fall inside the habit's own window? */
export function withinHabitWindow(habit: HabitRow, minuteOfDay: number): boolean {
  return inHabitWindow(minuteOfDay, habit.selector.window);
}

export interface NudgeStats { delivered: number; acted: number; snoozed: number }
/** Counts from alerts_log (rule habit_nudge). Responses are local; no message text is stored. */
export function nudgeResponseStats(db: DbAdapter, habitId: number, from = 0, to = Date.now()): NudgeStats {
  const rows = db.all(
    `SELECT title, body, acted_at AS actedAt FROM alerts_log
      WHERE rule_id = 'habit_nudge' AND alert_key = ? AND delivered_at >= ? AND delivered_at < ?`,
    [`habit:${habitId}`, from, to],
  ) as Array<{ title: string; body: string; actedAt: number | null }>;
  return {
    delivered: rows.length,
    acted: rows.filter((r) => r.actedAt != null && !/Reminded/.test(r.body)).length,
    snoozed: rows.filter((r) => r.actedAt != null && /Reminded/.test(r.body)).length,
  };
}
