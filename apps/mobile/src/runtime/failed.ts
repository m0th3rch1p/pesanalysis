import type { SQLiteDatabase } from "expo-sqlite";
import type { FailedAttemptFact } from "@yako/core";
import { bump } from "./obs";

/**
 * The parser skips "Failed." / "Invalid input" notices (not transactions), so nothing stores them. This keeps a
 * timestamp-only ring (no bodies, no names) in meta so the repeated_failed safety rule has data.
 * Insufficient-funds notices are NOT counted: that is a low balance, not an attack signal.
 */
const KEY = "failed_attempts_v1";
const KEEP_MS = 24 * 3_600_000;
const FAILED = /^(Failed\.|Invalid input|REVERSAL FAILED|Failure Reason)/i;
const MPESA_SENDER = /^m-?pesa$/i;

export function isFailedNotice(sender: string, body: string): boolean {
  return MPESA_SENDER.test(sender.trim()) && FAILED.test(body.trim());
}

interface Entry { kind: string; at: number }

function load(db: SQLiteDatabase): Entry[] {
  try {
    const r = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [KEY]);
    const a = r ? JSON.parse(r.value) : [];
    return Array.isArray(a) ? a.filter((e) => e && typeof e.at === "number") : [];
  } catch { return []; }
}

/** Call with raw inbound rows before ingest. Idempotent per timestamp (at-least-once redelivery does not double count). */
export function recordFailedNotices(db: SQLiteDatabase, rows: Array<{ sender: string; body: string; receivedAt: number }>, now = Date.now()): number {
  const hits = rows.filter((r) => isFailedNotice(r.sender, r.body));
  if (!hits.length) return 0;
  try {
    const cur = load(db).filter((e) => now - e.at < KEEP_MS);
    const have = new Set(cur.map((e) => e.at));
    let added = 0;
    for (const h of hits) if (!have.has(h.receivedAt)) { cur.push({ kind: "payment", at: h.receivedAt }); have.add(h.receivedAt); added++; }
    db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(cur.slice(-60))]);
    if (added) bump(db, "failed_notice", added);
    return added;
  } catch { return 0; }
}

export function failedAttemptFacts(db: SQLiteDatabase, now = Date.now()): FailedAttemptFact[] {
  const live = load(db).filter((e) => now - e.at < KEEP_MS);
  if (!live.length) return [];
  return [{ kind: "payment", atMs: live.map((e) => e.at) }];
}
