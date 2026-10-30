import type { DbAdapter } from "../db/migrate.js";

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
}

/**
 * Attach local calendar events to transactions that happened during them.
 * Calendar titles never leave the device, never enter the Z1 snapshot/airlock,
 * and are only stored in tx_context.
 */
export function attachCalendarEvents(db: DbAdapter, events: CalendarEvent[], now = Date.now()): { updated: number; created: number } {
  let updated = 0;
  let created = 0;
  for (const e of events) {
    if (!e.id || !e.title || !(e.endAt > e.startAt)) continue;
    const start = e.startAt - 15 * 60_000;
    const end = e.endAt + 15 * 60_000;
    const upd = db.run(
      `UPDATE tx_context SET calendar_event_id = ?, calendar_title = ?
        WHERE tx_id IN (SELECT id FROM tx_events WHERE occurred_at BETWEEN ? AND ?)
          AND (calendar_event_id IS NULL OR calendar_event_id = '')`,
      [e.id, e.title, start, end],
    );
    updated += Number((upd as { changes?: number }).changes ?? 0);
    const ins = db.run(
      `INSERT OR IGNORE INTO tx_context (tx_id, source, captured_at, calendar_event_id, calendar_title)
       SELECT id, 'calendar', ?, ?, ? FROM tx_events
        WHERE occurred_at BETWEEN ? AND ?
          AND id NOT IN (SELECT tx_id FROM tx_context)`,
      [now, e.id, e.title, start, end],
    );
    created += Number((ins as { changes?: number }).changes ?? 0);
  }
  return { updated, created };
}

/**
 * A calendar event the user deleted should not keep naming a transaction.
 * Only prune rows within the connector's live window so old history is kept.
 */
export function pruneCalendarContext(db: DbAdapter, eventIds: string[], now = Date.now(), windowDays = 120): number {
  if (!eventIds.length) return 0;
  const since = now - windowDays * 86_400_000;
  const marks = eventIds.map(() => "?").join(",");
  const r = db.run(
    `UPDATE tx_context SET calendar_event_id = NULL, calendar_title = NULL
      WHERE source = 'calendar' AND calendar_event_id IS NOT NULL
        AND calendar_event_id NOT IN (${marks}) AND COALESCE(captured_at, 0) >= ?`,
    [...eventIds, since],
  );
  return Number((r as { changes?: number }).changes ?? 0);
}

export interface CalendarContextRow { txId: number; eventId: string; title: string }

export function listCalendarContext(db: DbAdapter, limit = 50): CalendarContextRow[] {
  return db.all(
    `SELECT tx_id AS txId, calendar_event_id AS eventId, calendar_title AS title
       FROM tx_context WHERE calendar_event_id IS NOT NULL AND calendar_title IS NOT NULL
       ORDER BY captured_at DESC LIMIT ?`,
    [limit],
  ) as CalendarContextRow[];
}
