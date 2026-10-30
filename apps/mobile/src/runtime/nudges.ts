import * as Notifications from "expo-notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import { CHANNELS, formatMinute, nudgeHabits, parseHabitNudge } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { CATEGORY, ensureNotificationRuntime } from "./notifications";
import { nextOccurrences, occurrenceMinute, occurrenceStamp } from "./recurring";

export const NUDGE_PREFIX = "nudge:";
export const NUDGE_ACTION = { done: "habit_done", snooze: "habit_snooze" } as const;
export const NUDGE_WEEKS_AHEAD = 8;

export const nudgeId = (habitId: number, weekday: number, at: number) => `${NUDGE_PREFIX}${habitId}:${weekday}:${occurrenceStamp(at)}:${occurrenceMinute(at)}`;
const isManagedNudge = (id: string) => id.startsWith(NUDGE_PREFIX) && !id.includes(":snooze:") && !id.endsWith(":soon");

interface PlannedNudge { id: string; atMs: number; title: string; body: string; habitId: number }

function plannedNudges(db: SQLiteDatabase, now = Date.now()): PlannedNudge[] {
  const out: PlannedNudge[] = [];
  for (const habit of nudgeHabits(asDbAdapter(db))) {
    const n = parseHabitNudge(habit.nudge);
    if (!n?.enabled) continue;
    for (const weekday of n.weekdays) {
      for (const atMs of nextOccurrences(weekday, Math.floor(n.minuteOfDay / 60), n.minuteOfDay % 60, now, NUDGE_WEEKS_AHEAD)) {
        out.push({
          id: nudgeId(habit.id, weekday, atMs), atMs, habitId: habit.id, title: habit.name,
          body: `It's ${formatMinute(n.minuteOfDay)}. Check in on ${habit.name}?`,
        });
      }
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

/** Rebuild the OS schedule from habits. DATE triggers only: weekly triggers were unreliable on the reference ROM. */
export async function syncHabitNudges(db: SQLiteDatabase): Promise<{ scheduled: number; cancelled: number }> {
  try {
    await ensureNotificationRuntime();
    const now = Date.now();
    const desired = plannedNudges(db, now);
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const have = new Map(all.filter((n) => isManagedNudge(n.identifier)).map((n) => [n.identifier, n]));
    const want = new Map(desired.map((s) => [s.id, s]));
    let cancelled = 0;
    for (const id of have.keys()) {
      if (want.has(id)) continue;
      try { await Notifications.cancelScheduledNotificationAsync(id); cancelled++; } catch { /* already gone */ }
    }
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== "granted") return { scheduled: 0, cancelled };
    let scheduled = 0;
    for (const s of desired) {
      if (have.has(s.id)) continue;
      await Notifications.scheduleNotificationAsync({
        identifier: s.id,
        content: {
          title: s.title, body: s.body,
          data: { v: 1, kind: "habit_nudge", habitId: s.habitId, url: "yako://plan/habits" },
          categoryIdentifier: CATEGORY.habit, sound: false,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(s.atMs), channelId: CHANNELS.alerts.id },
      });
      scheduled++;
    }
    return { scheduled, cancelled };
  } catch (e) { console.error("[nudge] sync failed", e); return { scheduled: 0, cancelled: 0 }; }
}

/** One-off "Remind me in 1 h" after a nudge action. ID includes the minute so it never collides. */
export async function snoozeHabitNudge(db: SQLiteDatabase, habitId: number, now = Date.now()): Promise<void> {
  const at = now + 3_600_000;
  const row = db.getFirstSync<{ name: string }>(`SELECT name FROM habits WHERE id = ?`, [habitId]);
  if (!row?.name) return;
  await Notifications.scheduleNotificationAsync({
    identifier: `nudge:${habitId}:snooze:${Math.floor(at / 60_000)}`,
    content: {
      title: row.name,
      body: `You asked to be reminded about ${row.name}.`,
      data: { v: 1, kind: "habit_nudge", habitId, url: "yako://plan/habits" },
      categoryIdentifier: CATEGORY.habit,
      sound: false,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(at),
      channelId: CHANNELS.alerts.id,
    },
  });
}

export function nudgeCopyTime(minute: number): string { return formatMinute(minute); }
