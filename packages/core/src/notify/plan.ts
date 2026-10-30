/**
 * Notification scheduling plan (pure). Turns open capture items into the exact set of local notifications that
 * should exist, so the runtime can diff it against what the OS has scheduled and stay idempotent.
 * Nothing here talks to the OS. Times are epoch ms; day boundaries are Africa/Nairobi.
 */
import { DEFAULT_QUIET, type QuietHours } from "../alerts/quiet.js";
import { batchDigest, buildLadder, type CaptureItem, type LadderKind } from "../capture/ladder.js";
import { nextDigestAt, DEFAULT_DIGEST_MINUTE } from "../capture/materiality.js";
import type { ChannelKey } from "./channels.js";

export type PlannedKind = "capture_step" | "capture_stale" | "digest" | "alert_deferred";

export interface PlannedNotification {
  id: string;
  atMs: number;
  kind: PlannedKind;
  channel: ChannelKey;
  txIds: number[];
  step?: LadderKind;
  /** ladder index (capture_step only) */
  index?: number;
  count?: number;
}

export const CAPTURE_ID_PREFIX = "cap:";
export const STALE_ID = "cap:stale";
export const DIGEST_ID = "digest:capture";
export const ALERT_ID_PREFIX = "alert:";
/** Everything we schedule starts with one of these; anything else in the OS schedule belongs to someone else. */
export const OWNED_PREFIXES = [CAPTURE_ID_PREFIX, "digest:", ALERT_ID_PREFIX];

export const captureStepId = (txId: number, index: number) => `${CAPTURE_ID_PREFIX}${txId}:${index}`;
export const alertNotificationId = (logId: number) => `${ALERT_ID_PREFIX}${logId}`;
export const ownsId = (id: string) => OWNED_PREFIXES.some((p) => id.startsWith(p));

/** The ladder shifted past a snooze, so a snoozed item stays silent until the snooze ends. */
function ladderFor(it: CaptureItem, quiet: QuietHours) {
  const base = buildLadder(it.createdAt, it.tier, quiet);
  if (it.snoozeUntil == null) return base;
  return base.map((s) => (s.kind === "stale" ? s : { ...s, atMs: Math.max(s.atMs, it.snoozeUntil!) }));
}

/** Per-item reminder steps still in the future. The stale step is not scheduled per item (see planStale). */
export function planCaptureSteps(items: CaptureItem[], nowMs: number, quiet: QuietHours = DEFAULT_QUIET): PlannedNotification[] {
  const out: PlannedNotification[] = [];
  for (const it of items) {
    if (it.resolvedAt != null || it.tier === "none") continue;
    for (const s of ladderFor(it, quiet)) {
      if (s.kind === "stale" || s.index < it.stepsSent || s.atMs <= nowMs) continue;
      out.push({ id: captureStepId(it.txId, s.index), atMs: s.atMs, kind: "capture_step", channel: "capture", txIds: [it.txId], step: s.kind, index: s.index });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

/**
 * Ladder steps whose time has passed and that the OS has therefore already delivered (scheduled notifications fire
 * without JS). The runtime records these as sent so a late catch-up never repeats them. Returns the new `steps_sent`
 * and whether the stale step is among them.
 */
export function elapsedSteps(items: CaptureItem[], nowMs: number, quiet: QuietHours = DEFAULT_QUIET): Array<{ txId: number; stepsSent: number; stale: boolean }> {
  const out: Array<{ txId: number; stepsSent: number; stale: boolean }> = [];
  for (const it of items) {
    if (it.resolvedAt != null || it.tier === "none") continue;
    const lad = ladderFor(it, quiet);
    let n = it.stepsSent, stale = false;
    for (const s of lad) if (s.index >= it.stepsSent && s.atMs <= nowMs) { n = Math.max(n, s.index + 1); if (s.kind === "stale") stale = true; }
    const staleNew = stale && it.staleEscalatedAt == null;
    if (n > it.stepsSent || staleNew) out.push({ txId: it.txId, stepsSent: n, stale: staleNew });
  }
  return out;
}

/** One summary notification for the next 48 h crossing (escalated once; grouped, never one per item). */
export function planStale(items: CaptureItem[], nowMs: number, quiet: QuietHours = DEFAULT_QUIET): PlannedNotification | null {
  let first: number | null = null;
  const at = new Map<number, number>();
  for (const it of items) {
    if (it.resolvedAt != null || it.tier === "none" || it.staleEscalatedAt != null) continue;
    const st = ladderFor(it, quiet).find((s) => s.kind === "stale");
    if (!st || st.atMs <= nowMs) continue;
    at.set(it.txId, st.atMs);
    if (first == null || st.atMs < first) first = st.atMs;
  }
  if (first == null) return null;
  // everything that goes stale within 3 h of the first one rides in the same notification
  const ids = [...at].filter(([, t]) => t <= first! + 3 * 3_600_000).map(([id]) => id).sort((a, b) => a - b);
  return { id: STALE_ID, atMs: first, kind: "capture_stale", channel: "digest", txIds: ids, count: ids.length };
}

/** Evening digest for small auto-filed items. Null when nothing is waiting. */
export function planDigest(items: CaptureItem[], nowMs: number, digestMinute = DEFAULT_DIGEST_MINUTE): PlannedNotification | null {
  const groups = batchDigest(items);
  if (!groups.length) return null;
  const ids = groups.flatMap((g) => g.txIds).sort((a, b) => a - b);
  return { id: DIGEST_ID, atMs: nextDigestAt(nowMs, digestMinute), kind: "digest", channel: "digest", txIds: ids, count: ids.length };
}

export interface ScheduleDiff { schedule: PlannedNotification[]; cancel: string[] }

/** `existing` = identifiers currently scheduled in the OS with their fire time. Idempotent: a second diff is empty. */
export function diffSchedule(desired: PlannedNotification[], existing: Array<{ id: string; atMs: number | null }>, toleranceMs = 30_000): ScheduleDiff {
  const have = new Map(existing.filter((e) => ownsId(e.id)).map((e) => [e.id, e.atMs]));
  const want = new Map(desired.map((d) => [d.id, d]));
  const cancel = [...have.keys()].filter((id) => !want.has(id));
  const schedule = desired.filter((d) => {
    const at = have.get(d.id);
    return at === undefined || at === null || Math.abs(at - d.atMs) > toleranceMs;
  });
  return { schedule, cancel };
}

export interface NotifCopy { title: string; body: string }

/**
 * Words for capture notifications. `details` carries the specific title (amount, name); it is used only when
 * the user opted into details on the lock screen. Redacted copy never contains an amount or a name.
 */
export function captureCopy(kind: LadderKind | "digest" | "stale", opt: { details?: string | null; count?: number; showDetails: boolean }): NotifCopy {
  const n = opt.count ?? 1;
  const d = opt.showDetails && opt.details ? opt.details : null;
  switch (kind) {
    case "first": return { title: d ?? "New payment", body: "Tap to say what it was for." };
    case "followup": return { title: d ?? "Still need to know about a payment", body: "Add a category or a quick note." };
    case "morning": return { title: d ?? "A payment from yesterday needs detail", body: "Takes a few seconds." };
    case "stale": return { title: n === 1 ? "A payment is still waiting" : `${n} payments are still waiting`, body: "They have waited over 2 days. Add detail or mark done." };
    case "digest": return { title: n === 1 ? "1 small payment filed" : `${n} small payments filed`, body: "Filed automatically. Tap to confirm." };
  }
}

/** Copy the "Note saved" acknowledgement shown after an inline reply. */
export const NOTE_SAVED: NotifCopy = { title: "Note saved", body: "Add a category to finish this one." };
export const NOTE_SAVED_DONE: NotifCopy = { title: "Note saved", body: "This payment is complete." };
