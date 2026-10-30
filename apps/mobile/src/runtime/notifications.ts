import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  alertNotificationId, captureCopy, CHANNELS, channelForSeverity, channelHealth, diffSchedule, LEGACY_CHANNEL_IDS, txLink, ownsId,
  type ChannelHealth, type ChannelKey, type PlannedNotification,
} from "@yako/core";
import { txTitle } from "./capture";
import { taskManagerAvailable } from "./taskmanager";

export const CATEGORY = { captureA: "yako_capture_a", captureB: "yako_capture_b", alert: "yako_alert", habit: "yako_habit" } as const;
export const ACTION = { detail: "detail", photo: "photo", media: "media", confirm: "confirm", voice: "voice", note: "note", snooze: "snooze", notUseful: "not_useful", habitDone: "habit_done", habitSnooze: "habit_snooze" } as const;

const IMPORTANCE: Record<ChannelKey, Notifications.AndroidImportance> = {
  capture: Notifications.AndroidImportance.HIGH,
  capturePrivate: Notifications.AndroidImportance.HIGH,
  alerts: Notifications.AndroidImportance.HIGH,
  digest: Notifications.AndroidImportance.DEFAULT,
};

let ready: Promise<void> | null = null;

/**
 * Channels + categories, once per process. Safe to call from the headless task and the UI.
 *
 * Android shows at most THREE action buttons per notification, in the order added. Category A (first prompt) is
 * [Add detail, Note, Photo]; category B (reminders) swaps Photo for Voice so both capture routes are offered over the
 * life of one transaction. Note is a RemoteInput text reply. Its `opensAppToForeground` is false only when
 * expo-task-manager is installed (so JS can run with the app closed); otherwise it opens the app on that transaction.
 */
export function ensureNotificationRuntime(): Promise<void> {
  return (ready ??= (async () => {
    if (Platform.OS === "android") {
      for (const id of LEGACY_CHANNEL_IDS) { try { await Notifications.deleteNotificationChannelAsync(id); } catch { /* absent */ } }
      for (const c of Object.values(CHANNELS)) {
        const privateChannel = c.key === "capturePrivate" || c.key === "digest";
        await Notifications.setNotificationChannelAsync(c.id, {
          name: c.name, description: c.description, importance: IMPORTANCE[c.key],
          // D108: payments and safety alerts show amount/place on the lock screen by default.
          // The private capture channel exists only for the "hide details" preference.
          lockscreenVisibility: privateChannel ? Notifications.AndroidNotificationVisibility.PRIVATE : Notifications.AndroidNotificationVisibility.PUBLIC,
          sound: c.key === "capture" || c.key === "capturePrivate" ? null : undefined,
          enableVibrate: c.key === "capture" || c.key === "capturePrivate" || c.key === "alerts",
          vibrationPattern: c.key === "alerts" ? [0, 200, 100, 200] : c.key === "capture" || c.key === "capturePrivate" ? [0, 60] : undefined,
          showBadge: c.key !== "capture" && c.key !== "capturePrivate",
        });
      }
    }
    const bg = taskManagerAvailable();
    const open = { opensAppToForeground: true };
    const note = {
      identifier: ACTION.note, buttonTitle: "Note", options: { opensAppToForeground: !bg },
      textInput: { submitButtonTitle: "Save", placeholder: "What was this for?" },
    };
    const detail = { identifier: ACTION.detail, buttonTitle: "Pick category", options: open };
    const media = { identifier: ACTION.media, buttonTitle: "Add media", options: open };
    const confirm = { identifier: ACTION.confirm, buttonTitle: "✓ Confirm", options: { opensAppToForeground: !bg } };
    // A = a guess exists; B = no guess. Android shows at most three actions.
    await Notifications.setNotificationCategoryAsync(CATEGORY.captureA, [confirm, note, media]);
    await Notifications.setNotificationCategoryAsync(CATEGORY.captureB, [detail, note, media]);
    await Notifications.setNotificationCategoryAsync(CATEGORY.alert, [
      { identifier: "open", buttonTitle: "Open", options: open },
      { identifier: ACTION.snooze, buttonTitle: "Snooze 1 day", options: { opensAppToForeground: !bg } },
      { identifier: ACTION.notUseful, buttonTitle: "Not useful", options: { opensAppToForeground: !bg } },
    ]);
    await Notifications.setNotificationCategoryAsync(CATEGORY.habit, [
      { identifier: ACTION.habitDone, buttonTitle: "I've got this", options: { opensAppToForeground: !bg } },
      { identifier: ACTION.habitSnooze, buttonTitle: "Remind me in 1 h", options: { opensAppToForeground: !bg } },
    ]);
  })().catch((e) => { ready = null; throw e; }));
}

/**
 * Android channel importance is user-controlled after creation, so an app cannot re-raise it. Read what the OS has
 * now and return plain guidance for any channel the user (or the OEM) turned down.
 */
export async function checkChannels(): Promise<{ health: ChannelHealth[]; guidance: string[] }> {
  if (Platform.OS !== "android") return { health: [], guidance: [] };
  const health: ChannelHealth[] = [];
  for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
    let actual: number | null = null;
    try { actual = (await Notifications.getNotificationChannelAsync(CHANNELS[key].id))?.importance ?? null; } catch { actual = null; }
    health.push(channelHealth(key, actual));
  }
  return { health, guidance: health.flatMap((h) => (h.guidance ? [h.guidance] : [])) };
}

export async function notificationsGranted(): Promise<boolean> {
  try { return (await Notifications.getPermissionsAsync()).status === "granted"; } catch { return false; }
}

export interface Shown { id: string; channel: ChannelKey; title: string; body: string; data: Record<string, unknown>; category?: string }

function toInput(s: Shown): Notifications.NotificationContentInput {
  return { title: s.title, body: s.body, data: s.data, categoryIdentifier: s.category, sound: false };
}

/** Show now. Same id replaces the previous one (used for the inline-reply acknowledgement). */
export async function presentNow(s: Shown): Promise<void> {
  await ensureNotificationRuntime();
  await Notifications.scheduleNotificationAsync({ identifier: s.id, content: toInput(s), trigger: { channelId: CHANNELS[s.channel].id } });
}

export async function scheduleAt(s: Shown, atMs: number): Promise<void> {
  await ensureNotificationRuntime();
  await Notifications.scheduleNotificationAsync({
    identifier: s.id, content: toInput(s),
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(atMs), channelId: CHANNELS[s.channel].id },
  });
}

export async function cancelOwned(ids: string[]): Promise<void> {
  for (const id of ids) { try { await Notifications.cancelScheduledNotificationAsync(id); } catch { /* already fired */ } }
}

/** Remove one transaction's scheduled reminders and any delivered capture notification for it. */
export async function clearCaptureNotifications(txIds: number[]): Promise<void> {
  if (!txIds.length) return;
  const want = new Set(txIds.map((i) => `cap:${i}:`));
  const sched = await Notifications.getAllScheduledNotificationsAsync();
  await cancelOwned(sched.filter((n) => [...want].some((p) => n.identifier.startsWith(p))).map((n) => n.identifier));
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    for (const n of shown) {
      const d = n.request.content.data as { kind?: string; txId?: number } | undefined;
      if (d?.kind === "capture" && d.txId != null && txIds.includes(d.txId)) await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch { /* presented list unsupported */ }
}

function triggerAt(t: unknown): number | null {
  const v = (t as { value?: unknown; date?: unknown } | null)?.value ?? (t as { date?: unknown } | null)?.date;
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Content for one planned notification. Specific text only when the user allows details; otherwise redacted. */
export function shownFor(db: SQLiteDatabase, p: PlannedNotification, showDetails: boolean, alertRow?: { title: string; body: string; redacted: string; url: string | null; severity: "low" | "normal" | "high" | "safety"; logId: number }): Shown {
  if (p.kind === "alert_deferred" && alertRow) {
    return {
      id: p.id, channel: channelForSeverity(alertRow.severity), category: CATEGORY.alert,
      title: showDetails ? alertRow.title : "Money alert", body: showDetails ? alertRow.body : alertRow.redacted,
      data: { v: 1, kind: "alert", logId: alertRow.logId, url: alertRow.url },
    };
  }
  if (p.kind === "digest") {
    const c = captureCopy("digest", { count: p.count, showDetails });
    return { id: p.id, channel: "digest", ...c, data: { v: 1, kind: "digest", txIds: p.txIds, url: "yako://needs-you" } };
  }
  if (p.kind === "capture_stale") {
    const c = captureCopy("stale", { count: p.count, showDetails });
    return { id: p.id, channel: "digest", ...c, data: { v: 1, kind: "capture_stale", txIds: p.txIds, url: "yako://needs-you" } };
  }
  const txId = p.txIds[0]!;
  const step = p.step ?? "followup";
  const c = captureCopy(step, { details: showDetails ? txTitle(db, txId) : null, showDetails });
  return {
    id: p.id, channel: showDetails ? "capture" : "capturePrivate", category: step === "followup" ? CATEGORY.captureB : CATEGORY.captureA, ...c,
    data: { v: 1, kind: "capture", txId, step, url: txLink(txId) },
  };
}

/** Diff desired vs OS-scheduled (owned ids only) and apply. Idempotent: running it twice is a no-op. */
export async function reconcileSchedule(desired: PlannedNotification[], build: (p: PlannedNotification) => Shown): Promise<{ scheduled: number; cancelled: number }> {
  const sched = await Notifications.getAllScheduledNotificationsAsync();
  const diff = diffSchedule(desired, sched.map((n) => ({ id: n.identifier, atMs: triggerAt(n.trigger) })));
  await cancelOwned(diff.cancel);
  for (const p of diff.schedule) { try { await scheduleAt(build(p), p.atMs); } catch { /* one bad item must not block the rest */ } }
  return { scheduled: diff.schedule.length, cancelled: diff.cancel.length };
}

export { alertNotificationId, ownsId };
