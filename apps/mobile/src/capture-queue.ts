import type { SQLiteDatabase } from "expo-sqlite";
import { peekQueue, ackQueue, type RawSms } from "../modules/yako-sms";
import { ingestRows, type IngestStats } from "./ingest-inbox";
import { runAfterIngest } from "./runtime/cycle";
import { recordFailedNotices } from "./runtime/failed";

/** Native queue row -> core SmsMessage (carries the passive context captured at receive time). */
const toMessage = (q: RawSms) => ({
  sender: q.sender, body: q.body, receivedAt: q.receivedAt,
  context: q.lat != null || q.batteryPct != null || q.fixKind ? {
    lat: q.lat, lng: q.lng, accuracy: q.accuracy, locationAt: q.locationAt,
    fixKind: q.fixKind, provider: q.provider, fixLatencyMs: q.fixLatencyMs, ageMs: q.ageMs,
    batteryPct: q.batteryPct, isCharging: q.isCharging, capturedAt: q.capturedAt,
    calendarEventId: q.calendarEventId, calendarTitle: q.calendarTitle,
  } : undefined,
});

let busy: Promise<IngestStats | null> | null = null;

/**
 * At-least-once drain (D88): peek -> ingest (one SQL transaction) -> ack. A crash between ingest and ack
 * re-delivers rows, and the ledger's natural-key dedupe makes that harmless. Serialised per process so the
 * headless task and the UI never ingest the same batch concurrently.
 */
export function drainDurable(db: SQLiteDatabase): Promise<IngestStats | null> {
  if (busy) return busy;
  busy = (async () => {
    try {
      let total: IngestStats | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const rows = await peekQueue(200);
        if (rows.length === 0) break;
        const msgs = rows.map(toMessage);
        recordFailedNotices(db, msgs); // timestamps only; feeds the repeated_failed safety rule
        const stats = ingestRows(db, msgs);
        const maxSeq = Math.max(...rows.map((r) => r.seq ?? 0));
        await ackQueue(maxSeq);
        total = total ? merge(total, stats) : stats;
      }
      // Capture tiers, alerts and notification scheduling. Awaited so the headless task is not torn down mid-notify.
      // Never fails the drain: the rows are already committed and acked.
      if (total) { try { await runAfterIngest(db, total); } catch (e) { console.error(`[yako] after-ingest FAILED: ${String(e)}`); } }
      return total;
    } finally { busy = null; }
  })();
  return busy;
}

function merge(a: IngestStats, b: IngestStats): IngestStats {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (typeof v === "number" && typeof cur === "number") out[k] = cur + v;
    else if (Array.isArray(v) && Array.isArray(cur)) out[k] = [...cur, ...v];
  }
  return out as unknown as IngestStats;
}
