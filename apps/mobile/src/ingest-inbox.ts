import type { SQLiteDatabase } from "expo-sqlite";
import { ingestSms, type IngestActions, type SmsMessage } from "@yako/core";
import { readInbox, ingestFloor } from "../modules/yako-sms";
import { SqliteStore } from "./store";
import { runAfterIngest } from "./runtime/cycle";
import { recordFailedNotices } from "./runtime/failed";

export interface IngestStats {
  read: number;
  stored: number;
  skipped: number;
  chainOk: number;
  chainBreak: number;
  chainFirst: number;
  chainUnknown: number;
  ask: number;
  auto: number;
  silent: number;
  /** most recent actions, newest first — the UI shows these as cards */
  recent: IngestActions[];
  ms: number;
}

const empty = (): IngestStats => ({
  read: 0, stored: 0, skipped: 0,
  chainOk: 0, chainBreak: 0, chainFirst: 0, chainUnknown: 0,
  ask: 0, auto: 0, silent: 0, recent: [], ms: 0,
});

/**
 * THE ingestion path. The SMS receiver, the inbox backfill and the debug replay
 * all call this (WORKSTREAMS "Must-build early"). Persist-first, deterministic,
 * no LLM. Runs in one SQLite transaction so a backfill is atomic.
 */
export function ingestRows(db: SQLiteDatabase, rows: SmsMessage[]): IngestStats {
  const t0 = Date.now();
  const store = new SqliteStore(db);
  const stats = empty();
  stats.read = rows.length;
  db.withTransactionSync(() => {
    for (const msg of rows) {
      const res = ingestSms(msg, store);
      if (!res.stored || !res.actions) { stats.skipped++; continue; }
      stats.stored++;
      const a = res.actions;
      if (a.chainStatus === "ok") stats.chainOk++;
      else if (a.chainStatus === "break") stats.chainBreak++;
      else if (a.chainStatus === "first") stats.chainFirst++;
      else stats.chainUnknown++;
      stats[a.notify]++;
      stats.recent.push(a);
    }
  });
  stats.ms = Date.now() - t0;
  stats.recent = stats.recent.sort((a, b) => b.txId - a.txId).slice(0, 12);
  return stats;
}

export async function ingestInbox(db: SQLiteDatabase, limit = 20000): Promise<IngestStats> {
  const rows = await readInbox(0, limit);
  recordFailedNotices(db, rows);
  const stats = ingestRows(db, rows);
  try { await runAfterIngest(db, stats); } catch (e) { console.error(`[yako] after-backfill FAILED: ${String(e)}`); }
  return stats;
}

/**
 * Catch messages the receiver may never have seen: app stopped by install,
 * OEM broadcast restriction, or a dropped broadcast. Re-read a small overlap
 * before the newest stored SMS; ingestSms skips exact duplicates. Called on
 * launch, on resume, and by the foreground watcher.
 */
export async function catchUpInbox(db: SQLiteDatabase, limit = 20000, overlapMs = 60 * 60_000): Promise<IngestStats> {
  const latest = db.getFirstSync<{ at: number | null }>(`SELECT MAX(received_at) AS at FROM sms_raw`)?.at ?? 0;
  // After a user reset nothing older than the reset may come back (D88).
  const since = Math.max(ingestFloor(), latest > 0 ? Math.max(0, latest - overlapMs) : 0);
  const rows = await readInbox(since, limit);
  recordFailedNotices(db, rows);
  const stats = ingestRows(db, rows);
  try {
    db.runSync(`INSERT INTO meta (key,value) VALUES ('inbox_catchup_last', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(Date.now())]);
  } catch { /* status is non-fatal */ }
  // Same post-ingest pass as the receiver path. Freshness is judged per transaction, so a backfill never prompts.
  try { await runAfterIngest(db, stats); } catch (e) { console.error(`[yako] after-catchup FAILED: ${String(e)}`); }
  return stats;
}
