import type { SQLiteDatabase } from "expo-sqlite";
import {
  alertNotificationId, channelForSeverity, captureCopy, elapsedSteps, formatEat, getAlertPrefs, listJournalEntries, listOpenCaptures, listTxItems, logDelivered,
  capturePausedUntil, planCaptureSteps, planDigest, planStale, recordPromptSent, refreshOccurrences, runAlertCycle, runJournalChecks, syncFulizaObligation, txLink,
  type GateDecision, type PlannedNotification,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import type { IngestStats } from "../ingest-inbox";
import { startup } from "../startup";
import { markDigestShown, markFirstSent, registerNewCaptures, suggestionEvidence, syncCaptureState, type NewCapture } from "./capture";
import { bump, time } from "./obs";
import { buildSnapshot } from "./snapshot";
import {
  CATEGORY, clearCaptureNotifications, ensureNotificationRuntime, notificationsGranted, presentNow, reconcileSchedule, shownFor, type Shown,
} from "./notifications";

/**
 * The one runtime pass. Order matters and every step is idempotent:
 *   1 Fuliza obligation sync  2 expected-occurrence refresh  3 journal checks  4 capture state (resolve, mark elapsed steps)
 *   5 snapshot -> alert rules -> gate -> log  6 notifications (deliver now, reconcile the OS schedule).
 * Stages 1-5 are synchronous SQLite and are timed (`[cycle] ... ms`, values only). Stage 6 is OS calls.
 * Safe to run from the headless task, the foreground tick, resume and every ingest path.
 */

const REFRESH_EVERY_MS = 10 * 60_000;
const JOURNAL_EVERY_MS = 3 * 3_600_000;
const DIGEST_KEY = "digest_plan_v1";

export interface CycleResult {
  ms: number;
  syncMs: number;
  notifyMs: number;
  refreshed: boolean;
  delivered: number;
  deferred: number;
  scheduled: number;
  cancelled: number;
  resolved: number;
  errors: string[];
}

const last = { refresh: 0, journal: 0 };
let running: Promise<CycleResult> | null = null;
let rerun: { ingested: boolean } | null = null;

function metaGet(db: SQLiteDatabase, key: string): string | null {
  try { return db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null; } catch { return null; }
}
function metaSet(db: SQLiteDatabase, key: string, value: string | null): void {
  try {
    if (value == null) db.runSync(`DELETE FROM meta WHERE key = ?`, [key]);
    else db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  } catch { /* optional */ }
}

function stage<T>(db: SQLiteDatabase, errors: string[], name: string, fn: () => T): T | undefined {
  try { let out: T | undefined; db.withTransactionSync(() => { out = fn(); }); return out; } catch (e) { errors.push(`${name}: ${String(e).slice(0, 120)}`); return undefined; }
}

/** Synchronous part. Exported for timing/tests; everything it writes is idempotent. */
export function syncStages(db: SQLiteDatabase, now: number, opts: { ingested: boolean; force: boolean }) {
  const adapter = asDbAdapter(db);
  const errors: string[] = [];
  let refreshed = false;
  stage(db, errors, "fuliza", () => syncFulizaObligation(adapter, now));
  if (opts.ingested || opts.force || now - last.refresh >= REFRESH_EVERY_MS) {
    const r = stage(db, errors, "refresh", () => refreshOccurrences(adapter, now));
    if (r) { last.refresh = now; refreshed = true; }
  }
  if (opts.ingested || now - last.journal >= JOURNAL_EVERY_MS) {
    stage(db, errors, "journal", () => {
      const through = Number(metaGet(db, "inbox_catchup_last")) || null;
      for (const e of listJournalEntries(adapter, "active")) { if (e.rule) runJournalChecks(adapter, e.id, now, { syncedThroughMs: through }); }
    });
    last.journal = now;
  }

  // capture state: close what qualifies, then record ladder steps the OS has already delivered (scheduled notifications fire without JS)
  const cap = stage(db, errors, "capture", () => {
    const { resolved } = syncCaptureState(db, now);
    const prefs = getAlertPrefs(adapter);
    const paused = capturePausedUntil(adapter);
    const items = listOpenCaptures(adapter);
    if (paused != null && paused > now) metaSet(db, "capture_pause_pending", "1");
    const active = paused != null && paused > now ? [] : items;
    const done = elapsedSteps(active, now, prefs.quiet);
    for (const d of done) recordPromptSent(adapter, d.txId, d.stepsSent, now, d.stale);
    if (done.length) bump(db, "prompt_shown", done.length);
    // digest that was scheduled for a time that has passed has been delivered
    const raw = metaGet(db, DIGEST_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw) as { at: number; txIds: number[] };
        if (p.at <= now) { markDigestShown(db, p.txIds, now); bump(db, "prompt_shown"); metaSet(db, DIGEST_KEY, null); }
      } catch { metaSet(db, DIGEST_KEY, null); }
    }
    return { resolved, quiet: prefs.quiet };
  });

  const snap = stage(db, errors, "alerts", () => {
    const s = buildSnapshot(db, now);
    const res = runAlertCycle(adapter, s.alert);
    const deliver: Array<{ d: GateDecision; logId: number }> = [];
    let k = 0;
    for (const d of res.decisions) if (d.verdict === "deliver") deliver.push({ d, logId: res.logIds[k++]! });
    // quiet-hours deferrals are logged with a future delivered_at: the gate then treats them as sent (no duplicate when the app
    // opens later), the cap counts them against the day they land on, and the scheduler turns them into OS notifications
    let deferred = 0;
    for (const d of res.decisions) if (d.verdict === "defer" && d.deferUntilMs != null) { logDelivered(adapter, d, d.deferUntilMs); deferred++; }
    for (const e of res.errors) errors.push(`rule ${e.ruleId}: ${e.error}`);
    return { deliver, deferred, snapshotMs: s.ms, showDetails: getAlertPrefs(adapter).showDetailsOnLockScreen };
  });
  return { refreshed, cap, snap, errors };
}

async function notifyStage(db: SQLiteDatabase, now: number, sync: ReturnType<typeof syncStages>): Promise<{ delivered: number; scheduled: number; cancelled: number }> {
  if (!(await notificationsGranted())) return { delivered: 0, scheduled: 0, cancelled: 0 };
  await ensureNotificationRuntime();
  const adapter = asDbAdapter(db);
  const showDetails = sync.snap?.showDetails ?? false;
  let delivered = 0;

  for (const { d, logId } of sync.snap?.deliver ?? []) {
    const c = d.candidate;
    const sev = d.effectiveSeverity;
    await presentNow({
      id: alertNotificationId(logId), channel: channelForSeverity(sev), category: CATEGORY.alert,
      title: showDetails ? c.title : sev === "safety" ? "Security alert" : "Money alert", body: d.publicBody,
      data: { v: 1, kind: "alert", logId, url: c.action.url },
    });
    delivered++;
  }
  if (delivered) { bump(db, "alert_delivered", delivered); bump(db, "prompt_shown", delivered); }

  if (sync.cap?.resolved.length) await clearCaptureNotifications(sync.cap.resolved);

  // the desired OS schedule, rebuilt from the database every time. Suppressed counterparties and
  // a user pause must not leave already-scheduled ladder steps firing.
  const paused = capturePausedUntil(adapter);
  const suppressed = new Set(db.getAllSync<{ id: number }>(
    `SELECT t.id FROM transactions t JOIN ask_suppress s ON s.counterparty_id = t.counterparty_id`,
  ).map((r) => r.id));
  const items = listOpenCaptures(adapter).filter((i) => !suppressed.has(i.txId) && !(paused != null && paused > now));
  if (paused != null && paused <= now && metaGet(db, "capture_pause_pending") === "1") {
    if (items.length) {
      await presentNow({
        id: "cap:resume", channel: "digest",
        title: items.length === 1 ? "1 payment is waiting" : `${items.length} payments are waiting`,
        body: "Your pause is over. Add detail or mark done.",
        data: { v: 1, kind: "digest", txIds: items.map((i) => i.txId), url: "yako://needs-you" },
      }).catch(() => undefined);
    }
    metaSet(db, "capture_pause_pending", null);
  }
  const quiet = sync.cap?.quiet;
  const desired: PlannedNotification[] = [...planCaptureSteps(items, now, quiet)];
  const stale = planStale(items, now, quiet);
  if (stale) desired.push(stale);
  const dig = planDigest(items, now);
  if (dig) { desired.push(dig); metaSet(db, DIGEST_KEY, JSON.stringify({ at: dig.atMs, txIds: dig.txIds })); } else metaSet(db, DIGEST_KEY, null);
  const alertRows = new Map<string, { title: string; body: string; redacted: string; url: string | null; severity: "low" | "normal" | "high" | "safety"; logId: number }>();
  for (const r of db.getAllSync<{ id: number; severity: string; title: string; body: string; redacted_body: string; action_url: string | null; delivered_at: number }>(
    `SELECT id, severity, title, body, redacted_body, action_url, delivered_at FROM alerts_log WHERE delivered_at > ? AND (expires_at IS NULL OR expires_at > delivered_at)`, [now])) {
    const id = alertNotificationId(r.id);
    desired.push({ id, atMs: r.delivered_at, kind: "alert_deferred", channel: channelForSeverity(r.severity as "low"), txIds: [] });
    alertRows.set(id, { title: r.title, body: r.body, redacted: r.redacted_body, url: r.action_url, severity: r.severity as "low", logId: r.id });
  }
  const res = await reconcileSchedule(desired, (p) => shownFor(db, p, showDetails, alertRows.get(p.id)));
  return { delivered, scheduled: res.scheduled, cancelled: res.cancelled };
}

async function runOnce(db: SQLiteDatabase, opts: { ingested: boolean; force: boolean; now?: number }): Promise<CycleResult> {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const errors: string[] = [];
  const sync = syncStages(db, now, opts);
  errors.push(...sync.errors);
  const syncMs = Date.now() - t0;
  let n = { delivered: 0, scheduled: 0, cancelled: 0 };
  const t1 = Date.now();
  try { n = await notifyStage(db, now, sync); } catch (e) { errors.push(`notify: ${String(e).slice(0, 120)}`); }
  const notifyMs = Date.now() - t1;
  const ms = Date.now() - t0;
  bump(db, "cycle_run"); if (errors.length) bump(db, "cycle_error");
  time(db, "cycle_ms", ms); time(db, "cycle_snapshot_ms", sync.snap?.snapshotMs ?? 0); time(db, "cycle_notify_ms", notifyMs);
  // values only: never log ledger content
  startup("cycle", `${ms}ms sync=${syncMs} notify=${notifyMs} snap=${sync.snap?.snapshotMs ?? "-"} refresh=${sync.refreshed ? 1 : 0} deliver=${n.delivered} sched=${n.scheduled}/${n.cancelled} err=${errors.length}`);
  return { ms, syncMs, notifyMs, refreshed: sync.refreshed, delivered: n.delivered, deferred: sync.snap?.deferred ?? 0, scheduled: n.scheduled, cancelled: n.cancelled, resolved: sync.cap?.resolved.length ?? 0, errors };
}

/** Single-flight: a call that arrives mid-run coalesces into exactly one follow-up run. */
function schedule(db: SQLiteDatabase, opts: { ingested: boolean; force: boolean }): Promise<CycleResult> {
  if (running) {
    rerun = { ingested: (rerun?.ingested ?? false) || opts.ingested };
    return running;
  }
  running = (async () => {
    try {
      let r = await runOnce(db, opts);
      while (rerun) { const o = rerun; rerun = null; r = await runOnce(db, { ingested: o.ingested, force: false }); }
      return r;
    } finally { running = null; }
  })();
  return running;
}

/** App resume, 60 s tick, screen focus. Cheap enough to call freely: heavy stages are interval-gated. */
export function runForegroundCycle(db: SQLiteDatabase, opts: { force?: boolean } = {}): Promise<CycleResult> {
  return schedule(db, { ingested: false, force: !!opts.force });
}

function firstPrompt(db: SQLiteDatabase, n: NewCapture, showDetails: boolean): Shown {
  const a = n.action;
  const time = formatEat(a.occurredAt).split("|")[1] ?? "";
  const ev = a.suggestion ? suggestionEvidence(db, a.txId, a.suggestion.label) : { seen: 0, total: 0 };
  const items = listTxItems(asDbAdapter(db), a.txId).filter((i) => i.source === "inferred" && i.itemName);
  const itemGuess = items.map((i) => `${i.qty && i.qty > 1 ? `${i.qty} ` : ""}${i.itemName}`).join(" + ");
  const guessText = itemGuess || a.suggestion?.label;
  const guess = showDetails && guessText
    ? `${guessText}${ev.total >= 2 ? `? (seen ${ev.seen} of ${ev.total} times)` : "?"} · ${time}`
    : showDetails ? `What was this for? · ${time}` : "New payment · tap to add detail";
  return {
    id: `cap:${a.txId}:0`, channel: showDetails ? "capture" : "capturePrivate",
    category: guessText ? CATEGORY.captureA : CATEGORY.captureB,
    title: showDetails ? a.title : "New payment",
    body: guess,
    data: { v: 1, kind: "capture", txId: a.txId, step: "first", url: txLink(a.txId) },
  };
}


/**
 * Every ingest path calls this (headless task, drainDurable, catch-up). First prompts go out BEFORE the heavier
 * cycle so the notification latency is ingest + a few queries. Returns null when nothing new was stored.
 */
export async function runAfterIngest(db: SQLiteDatabase, stats: Pick<IngestStats, "stored" | "recent" | "ms" | "read"> | null): Promise<CycleResult | null> {
  if (!stats) return null;
  const t0 = Date.now();
  bump(db, "ingest_batches");
  if (stats.read > 0) time(db, "ingest_ms", stats.ms);
  if (stats.stored <= 0) return null;
  bump(db, "ingest_stored", stats.stored);
  const errors: string[] = [];
  try {
    const due = registerNewCaptures(db, stats.recent, t0);
    if (due.length && (await notificationsGranted())) {
      await ensureNotificationRuntime();
      const showDetails = getAlertPrefs(asDbAdapter(db)).showDetailsOnLockScreen;
      for (const n of due) {
        try { await presentNow(firstPrompt(db, n, showDetails)); markFirstSent(db, n.action.txId, t0); bump(db, "prompt_shown"); }
        catch (e) { errors.push(`first: ${String(e).slice(0, 80)}`); }
      }
      time(db, "ingest_to_notify_ms", stats.ms + (Date.now() - t0));
    }
  } catch (e) { errors.push(`register: ${String(e).slice(0, 80)}`); bump(db, "cycle_error"); }
  const r = await schedule(db, { ingested: true, force: true });
  if (errors.length) r.errors.push(...errors);
  return r;
}
