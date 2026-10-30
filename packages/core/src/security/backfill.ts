/**
 * First-run inbox backfill planning (F-ONBOARD). Pure: turns "now + what is already done" into the next window.
 *
 * Phases, in order:
 *   1. recent  - newest RECENT_DAYS (60) days, newest first, in batches.
 *   2. top     - older messages from the top counterparties/senders (by frequency x amount) so the first Review
 *                is worth doing.
 *   3. rest    - everything older, newest first, in the background.
 * Progress is a small JSON cursor that survives a kill. Cancel keeps all progress; "resume" continues from it.
 */
export const RECENT_DAYS = 60;
export const BACKFILL_BATCH = 400;
const DAY = 86_400_000;

export type BackfillPhase = "recent" | "top" | "rest" | "done";
export type BackfillStatus = "idle" | "running" | "paused" | "cancelled" | "done" | "error";

export interface BackfillCursor {
  v: 1;
  phase: BackfillPhase;
  status: BackfillStatus;
  /** wall clock the backfill started; the recent window is relative to it */
  startedAt: number;
  /** exclusive upper bound for the next window of the current phase (receivedAt ms) */
  before: number;
  /** ingested so far across phases */
  stored: number;
  /** scanned so far (read from inbox) */
  read: number;
  updatedAt: number;
  error?: string;
  /** senders chosen for the "top" phase (set when phase 1 completes) */
  topSenders?: string[];
}

export function newCursor(now: number): BackfillCursor {
  return { v: 1, phase: "recent", status: "idle", startedAt: now, before: now + 1, stored: 0, read: 0, updatedAt: now };
}

export interface Window { phase: BackfillPhase; since: number; before: number; senders?: string[]; limit: number }

/** Next inbox window to read, or null when done / not runnable. `floor` is the native ingest floor (D88). */
export function nextWindow(c: BackfillCursor, floor = 0): Window | null {
  if (c.phase === "done" || c.status === "done" || c.status === "cancelled") return null;
  const recentStart = Math.max(floor, c.startedAt - RECENT_DAYS * DAY);
  if (c.phase === "recent") {
    // one window = the whole 60 days; the reader pages with `limit`, newest first
    return { phase: "recent", since: recentStart, before: c.before, limit: BACKFILL_BATCH };
  }
  if (c.phase === "top") {
    return { phase: "top", since: floor, before: Math.min(c.before, recentStart), senders: c.topSenders ?? [], limit: BACKFILL_BATCH };
  }
  return { phase: "rest", since: floor, before: Math.min(c.before, recentStart), limit: BACKFILL_BATCH };
}

/**
 * Fold the result of one read. `oldestReceivedAt` is the oldest message in the batch (null if empty).
 * A batch smaller than the limit means the window is exhausted and the phase advances.
 */
export function advance(c: BackfillCursor, r: { read: number; stored: number; oldestReceivedAt: number | null; limit: number }, now: number): BackfillCursor {
  const next: BackfillCursor = { ...c, read: c.read + r.read, stored: c.stored + r.stored, updatedAt: now, status: "running" };
  const exhausted = r.read < r.limit || r.oldestReceivedAt == null;
  if (!exhausted) { next.before = r.oldestReceivedAt!; return next; }
  const recentStart = c.startedAt - RECENT_DAYS * DAY;
  if (c.phase === "recent") { next.phase = "top"; next.before = recentStart; }
  else if (c.phase === "top") { next.phase = "rest"; next.before = recentStart; }
  else { next.phase = "done"; next.status = "done"; }
  return next;
}

export function pause(c: BackfillCursor, now: number): BackfillCursor { return c.status === "done" ? c : { ...c, status: "paused", updatedAt: now }; }
export function cancel(c: BackfillCursor, now: number): BackfillCursor { return c.status === "done" ? c : { ...c, status: "cancelled", updatedAt: now }; }
/** Resume after a pause, cancel, kill or error. Keeps phase and `before`, so nothing is re-read. */
export function resume(c: BackfillCursor, now: number): BackfillCursor {
  return c.status === "done" ? c : { ...c, status: "running", error: undefined, updatedAt: now };
}
export function fail(c: BackfillCursor, msg: string, now: number): BackfillCursor { return { ...c, status: "error", error: msg.slice(0, 160), updatedAt: now }; }

export function parseCursor(raw: string | null | undefined): BackfillCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as BackfillCursor;
    if (c && c.v === 1 && typeof c.before === "number" && typeof c.startedAt === "number") {
      // a process kill leaves "running" behind: treat as paused so the UI offers Resume
      return c.status === "running" ? { ...c, status: "paused" } : c;
    }
  } catch { /* corrupt */ }
  return null;
}

/** Rank senders for the "top" phase: frequency x median-ish amount. Input comes from the recent window's ingested rows. */
export function rankTopSenders(rows: Array<{ key: string; amount: number }>, take = 12): string[] {
  const by = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    const e = by.get(r.key) ?? { n: 0, sum: 0 };
    e.n++; e.sum += Math.abs(r.amount);
    by.set(r.key, e);
  }
  return [...by.entries()].sort((a, b) => b[1].n * b[1].sum - a[1].n * a[1].sum || a[0].localeCompare(b[0])).slice(0, take).map(([k]) => k);
}

export function describeBackfill(c: BackfillCursor): string {
  const what = c.phase === "recent" ? "last 60 days" : c.phase === "top" ? "top counterparties" : c.phase === "rest" ? "older messages" : "all";
  switch (c.status) {
    case "done": return `Done. ${c.stored} transactions imported.`;
    case "running": return `Importing ${what}… ${c.stored} transactions so far.`;
    case "paused": return `Paused (${what}). ${c.stored} imported so far. Resume any time.`;
    case "cancelled": return `Stopped. ${c.stored} imported. Resume to continue.`;
    case "error": return `Stopped by an error: ${c.error ?? "unknown"}. ${c.stored} imported. Resume to retry.`;
    default: return "Not started.";
  }
}
