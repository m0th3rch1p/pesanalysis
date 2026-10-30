import type { SQLiteDatabase } from "expo-sqlite";

/**
 * F-OBS: local-only counters in `meta` (key prefix `obs:`). No network, no content: names of events and numbers only.
 *   obs:c:<name>            monotonically increasing count
 *   obs:t:<name>            JSON {n,sum,max,last} for durations (ms)
 * Reads are for Advanced/diagnostics export; writes are best-effort and never throw.
 */
const C = "obs:c:";
const T = "obs:t:";

export type CounterName =
  | "prompt_shown" | "prompt_acted" | "prompt_dismissed"
  | "capture_registered" | "capture_resolved" | "note_inline_saved" | "note_inline_failed" | "guess_confirmed_inline"
  | "alert_delivered" | "alert_opened" | "alert_deferred"
  | "cycle_run" | "cycle_skipped" | "cycle_error" | "ingest_batches" | "ingest_stored" | "failed_notice";

export type TimerName = "cycle_ms" | "cycle_snapshot_ms" | "cycle_notify_ms" | "ingest_ms" | "ingest_to_notify_ms";

export function bump(db: SQLiteDatabase, name: CounterName, by = 1): void {
  try {
    db.runSync(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + ? AS TEXT)`,
      [C + name, String(by), by],
    );
  } catch { /* observability must never break a flow */ }
}

export function time(db: SQLiteDatabase, name: TimerName, ms: number): void {
  try {
    const row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [T + name]);
    const cur = row ? (JSON.parse(row.value) as { n: number; sum: number; max: number; last: number }) : { n: 0, sum: 0, max: 0, last: 0 };
    const next = { n: cur.n + 1, sum: cur.sum + ms, max: Math.max(cur.max, ms), last: ms };
    db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [T + name, JSON.stringify(next)]);
  } catch { /* ignore */ }
}

export interface ObsSnapshot {
  counters: Record<string, number>;
  timers: Record<string, { n: number; avgMs: number; maxMs: number; lastMs: number }>;
}

export function readObs(db: SQLiteDatabase): ObsSnapshot {
  const out: ObsSnapshot = { counters: {}, timers: {} };
  try {
    for (const r of db.getAllSync<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'obs:%'`)) {
      if (r.key.startsWith(C)) out.counters[r.key.slice(C.length)] = Number(r.value) || 0;
      else if (r.key.startsWith(T)) {
        try {
          const t = JSON.parse(r.value) as { n: number; sum: number; max: number; last: number };
          out.timers[r.key.slice(T.length)] = { n: t.n, avgMs: t.n ? Math.round(t.sum / t.n) : 0, maxMs: t.max, lastMs: t.last };
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* meta missing */ }
  // ignored = shown and neither acted on nor dismissed (derived; there is no OS signal for a swipe-away)
  out.counters.prompt_ignored = Math.max(0, (out.counters.prompt_shown ?? 0) - (out.counters.prompt_acted ?? 0) - (out.counters.prompt_dismissed ?? 0));
  return out;
}

/** Share of shown prompts the user acted on. Null until there is something to divide. */
export function actRate(o: ObsSnapshot): number | null {
  const shown = o.counters.prompt_shown ?? 0;
  return shown > 0 ? (o.counters.prompt_acted ?? 0) / shown : null;
}
