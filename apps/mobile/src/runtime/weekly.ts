import * as Notifications from "expo-notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import { CHANNELS } from "@yako/core";
import { nextOccurrences, occurrenceStamp } from "./recurring";

export const WEEKLY_REVIEW_PREFIX = "week:review:";
export const WEEKLY_REVIEW_LEGACY = "week:review";
export const WEEKLY_REVIEW_WEEKS_AHEAD = 8;
export const WEEKLY_REVIEW_KEY = "weekly_review_enabled";
export const WEEKLY_REVIEW_HOUR = 18;
export const WEEKLY_REVIEW_MINUTE = 0;
/** JavaScript weekday: 0 = Sunday … 6 = Saturday. */
export const WEEKLY_REVIEW_WEEKDAY = 0;

export function weeklyReviewEnabled(db: SQLiteDatabase): boolean {
  const row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [WEEKLY_REVIEW_KEY]);
  return row?.value !== "0";
}

export function setWeeklyReviewEnabled(db: SQLiteDatabase, enabled: boolean): void {
  db.runSync(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [WEEKLY_REVIEW_KEY, enabled ? "1" : "0"],
  );
}

/** Idempotent: eight one-off Sunday 18:00 triggers (weekly triggers were unreliable on the reference ROM). */
export async function ensureWeeklyReviewSchedule(db: SQLiteDatabase): Promise<{ scheduled: boolean; cancelled: boolean }> {
  const enabled = weeklyReviewEnabled(db);
  const now = Date.now();
  const all = await Notifications.getAllScheduledNotificationsAsync();
  try { await Notifications.cancelScheduledNotificationAsync(WEEKLY_REVIEW_LEGACY); } catch { /* no legacy request */ }
  const have = new Set(all.filter((n) => n.identifier.startsWith(WEEKLY_REVIEW_PREFIX)).map((n) => n.identifier));
  const want = new Set(enabled
    ? nextOccurrences(WEEKLY_REVIEW_WEEKDAY, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE, now, WEEKLY_REVIEW_WEEKS_AHEAD)
      .map((at) => `${WEEKLY_REVIEW_PREFIX}${occurrenceStamp(at)}`)
    : []);
  let cancelled = false;
  for (const id of have) {
    if (want.has(id)) continue;
    try { await Notifications.cancelScheduledNotificationAsync(id); cancelled = true; } catch { /* already gone */ }
  }
  if (!enabled) return { scheduled: false, cancelled };
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") return { scheduled: false, cancelled };
  let scheduled = false;
  for (const at of nextOccurrences(WEEKLY_REVIEW_WEEKDAY, WEEKLY_REVIEW_HOUR, WEEKLY_REVIEW_MINUTE, now, WEEKLY_REVIEW_WEEKS_AHEAD)) {
    const id = `${WEEKLY_REVIEW_PREFIX}${occurrenceStamp(at)}`;
    if (have.has(id)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: "Your week",
        body: "Habits, new patterns and credit use from the last seven days. Tap to open.",
        data: { v: 1, kind: "week", url: "yako://week" },
        sound: false,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), channelId: CHANNELS.digest.id },
    });
    scheduled = true;
  }
  return { scheduled, cancelled };
}

/** Called after settings change and once per app start. Never throws into the UI. */
export async function syncWeeklyReview(db: SQLiteDatabase): Promise<void> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== "granted") { await ensureWeeklyReviewSchedule(db).catch(() => undefined); return; }
    await Notifications.setNotificationChannelAsync(CHANNELS.digest.id, {
      name: CHANNELS.digest.name, description: CHANNELS.digest.description,
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await ensureWeeklyReviewSchedule(db);
  } catch { /* schedule is optional */ }
}
