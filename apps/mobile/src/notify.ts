import * as Notifications from "expo-notifications";
import { CHANNELS, formatKes, type IngestActions } from "@yako/core";
import { ensureNotificationRuntime } from "./runtime/notifications";

// Channels, categories and scheduling live in src/runtime/notifications.ts (versioned channel ids, capture ladder,
// alerts). This file keeps the permission/state helpers and the test notification.
const CHANNEL = CHANNELS.alerts.id;
const ASK_CATEGORY = "yako_ask";
const AUTO_CATEGORY = "yako_auto";

// Foreground delivery too (default expo-notifications behaviour is to swallow banners).
// Capture prompts are low-importance by design: show them in the shade, never play a sound.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const kind = (n.request.content.data as { kind?: string } | undefined)?.kind;
    const quiet = kind === "capture" || kind === "digest" || kind === "capture_stale";
    return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: !quiet, shouldSetBadge: false };
  },
});

let categoriesReady = false;

export async function ensureNotificationCategories(): Promise<void> {
  if (categoriesReady) return;
  try {
    await Notifications.setNotificationCategoryAsync(ASK_CATEGORY, [
      { identifier: "review", buttonTitle: "Review now", options: { opensAppToForeground: true } },
      { identifier: "dismiss", buttonTitle: "Later", options: { opensAppToForeground: false } },
    ]);
    await Notifications.setNotificationCategoryAsync(AUTO_CATEGORY, [
      { identifier: "change", buttonTitle: "Change label", options: { opensAppToForeground: true } },
    ]);
    categoriesReady = true;
  } catch { /* categories are optional; the tap still opens Review */ }
}

export async function ensureNotifyChannel(): Promise<void> {
  await ensureNotificationCategories();
  await ensureNotificationRuntime();
}

export interface NotificationState {
  permission: string;
  granted: boolean;
  canAskAgain: boolean;
  channel: boolean;
}

/** Ask once on first use; callers show a visible banner when this stays denied. */
export async function ensureNotificationPermission(request = true): Promise<NotificationState> {
  const current = await Notifications.getPermissionsAsync();
  const result = current.status === "granted" || !request
    ? current
    : await Notifications.requestPermissionsAsync();
  let channel = false;
  try {
    channel = !!(await Notifications.getNotificationChannelAsync(CHANNEL));
  } catch { channel = false; }
  return { permission: result.status, granted: result.status === "granted", canAskAgain: result.canAskAgain, channel };
}

export async function notificationState(): Promise<NotificationState> {
  return ensureNotificationPermission(false);
}

/**
 * @deprecated Kept so existing call sites compile. Prompts are now decided (materiality), scheduled (ladder) and
 * delivered by runtime/cycle.ts `runAfterIngest`, which every ingest path already calls. Calling this does nothing,
 * on purpose: it would otherwise duplicate the notification.
 */
export async function notifyAction(_a: IngestActions): Promise<void> {
  return;
}

/** User-triggered proof that the permission, channel and scheduler all work. */
export async function sendTestNotification(): Promise<NotificationState> {
  const state = await ensureNotificationPermission(true);
  if (!state.granted) return state;
  await ensureNotifyChannel();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Pesanalysis notification test",
      body: "If you see this, alerts are working.",
      data: { txId: 0, test: true },
      categoryIdentifier: ASK_CATEGORY,
    },
    trigger: { channelId: CHANNELS.alerts.id },
  });
  return { ...state, channel: true };
}

export function describeAction(a: IngestActions): string {
  const s = a.suggestion;
  return `${formatKes(a.amount)} · ${a.title} · ${s ? `${s.label} ${(s.confidence * 100).toFixed(0)}%` : "no suggestion"}`;
}
