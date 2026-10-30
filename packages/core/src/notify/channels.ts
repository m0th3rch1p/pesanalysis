/**
 * Android notification channels. Importance is user-controlled once a channel exists, so ids are versioned:
 * bump `version` when defaults change and the old channel is left for the user to remove.
 */
export type ChannelKey = "capture" | "capturePrivate" | "alerts" | "digest";

/** Android importance levels (NotificationManager.IMPORTANCE_*): 0 none, 1 min, 2 low, 3 default, 4 high. */
export const IMPORTANCE = { none: 0, min: 1, low: 2, default: 3, high: 4 } as const;

export interface ChannelSpec { key: ChannelKey; id: string; name: string; description: string; importance: number; version: number }

export const CHANNELS: Record<ChannelKey, ChannelSpec> = {
  // D108: payments are the primary capture channel. High importance so they reach the lock screen,
  // silent so a shop visit does not ring. The private variant is used only when the user hides details.
  capture: { key: "capture", id: "yako-capture-v2", name: "Payment questions", description: "Ask what a payment was for, with amount and place by default", importance: IMPORTANCE.high, version: 2 },
  capturePrivate: { key: "capturePrivate", id: "yako-capture-private-v2", name: "Payment questions (hidden details)", description: "Same prompts, but the lock screen hides amount and place", importance: IMPORTANCE.high, version: 2 },
  alerts: { key: "alerts", id: "yako-alerts-v1", name: "Money alerts", description: "Safety, due dates and low-money warnings", importance: IMPORTANCE.high, version: 1 },
  digest: { key: "digest", id: "yako-digest-v1", name: "Daily summary", description: "Evening digest and low-urgency tips", importance: IMPORTANCE.default, version: 1 },
};

/** Channels retired by versioning; deleted on startup so they stop cluttering system settings. */
export const LEGACY_CHANNEL_IDS = ["yako-tx", "yako-capture-v1", "yako-capture-private-v1"];

export function channelForSeverity(sev: "low" | "normal" | "high" | "safety"): ChannelKey {
  return sev === "safety" || sev === "high" ? "alerts" : "digest";
}

export interface ChannelHealth { key: ChannelKey; ok: boolean; actual: number | null; guidance: string | null }

/** `actual` = importance reported by the OS now (null = channel missing / unreadable). */
export function channelHealth(key: ChannelKey, actual: number | null | undefined): ChannelHealth {
  const spec = CHANNELS[key];
  if (actual == null) return { key, ok: false, actual: null, guidance: `The "${spec.name}" channel is missing. Open the app once with notifications allowed to recreate it.` };
  if (actual === IMPORTANCE.none) {
    return { key, ok: false, actual, guidance: `"${spec.name}" is switched off in system settings, so you will not see these. Settings > Apps > Pesanalysis > Notifications > ${spec.name}: turn it on.` };
  }
  // capture is meant to be quiet: anything >= low is fine. Others must not be below what we asked for.
  if (actual < spec.importance) {
    const want = spec.importance >= IMPORTANCE.high ? "Urgent (pop on screen)" : spec.importance === IMPORTANCE.default ? "Default (sound)" : "Low";
    return { key, ok: false, actual, guidance: `"${spec.name}" was turned down in system settings, so it will not pop up. Settings > Apps > Pesanalysis > Notifications > ${spec.name}: set it to ${want}.` };
  }
  return { key, ok: true, actual, guidance: null };
}
