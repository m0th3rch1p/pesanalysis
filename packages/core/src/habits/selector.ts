import type { DbAdapter } from "../db/migrate.js";
import { toEatParts } from "../sms/time.js";

export interface HabitSelector {
  labels?: number[]; items?: number[]; groups?: number[]; counterparties?: number[];
  window?: { startMin: number; endMin: number }; weekdays?: number[];
  funding?: "credit" | "wallet" | "any"; direction: "out" | "in";
  words?: string[];
}

const minuteOfDay = (ms: number) => { const p = toEatParts(ms); return p.hour * 60 + p.minute; };
export function inHabitWindow(minute: number, w?: { startMin: number; endMin: number }): boolean {
  if (!w) return true;
  if (w.startMin <= w.endMin) return minute >= w.startMin && minute < w.endMin;
  return minute >= w.startMin || minute < w.endMin; // wraps midnight
}

/** SQL fragment + params, shared by matching and progress. */
export function selectorSql(sel: HabitSelector, alias = "t"): { where: string[]; params: unknown[] } {
  const where = [`${alias}.role = 'transaction'`, `${alias}.direction = ?`];
  const params: unknown[] = [sel.direction === "in" ? "in" : "out"];
  if (sel.labels?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.tx_id = ${alias}.id AND tl.confirmed_at IS NOT NULL AND tl.label_id IN (${sel.labels.map(() => "?").join(",")}))`);
    params.push(...sel.labels);
  }
  if (sel.items?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_items ti WHERE ti.tx_id = ${alias}.id AND ti.item_id IN (${sel.items.map(() => "?").join(",")}))`);
    params.push(...sel.items);
  }
  if (sel.groups?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_items ti WHERE ti.tx_id = ${alias}.id AND ti.group_id IN (${sel.groups.map(() => "?").join(",")}))`);
    params.push(...sel.groups);
  }
  if (sel.counterparties?.length) {
    where.push(`${alias}.counterparty_id IN (${sel.counterparties.map(() => "?").join(",")})`);
    params.push(...sel.counterparties);
  }
  if (sel.funding === "credit") where.push(`EXISTS (SELECT 1 FROM transactions f WHERE f.role='funding_notice' AND f.ref IS NOT NULL AND f.ref = ${alias}.event_ref)`);
  if (sel.funding === "wallet") where.push(`NOT EXISTS (SELECT 1 FROM transactions f WHERE f.role='funding_notice' AND f.ref IS NOT NULL AND f.ref = ${alias}.event_ref)`);
  if (sel.weekdays?.length) {
    where.push(`CAST(strftime('%w', ${alias}.occurred_at/1000, 'unixepoch', '+3 hours') AS INTEGER) IN (${sel.weekdays.map(() => "?").join(",")})`);
    params.push(...sel.weekdays);
  }
  return { where, params };
}

export interface HabitTx { id: number; at: number; amountCents: number; label: string | null }

export function matchingTxIds(db: DbAdapter, sel: HabitSelector, from: number, to: number): number[] {
  const s = selectorSql(sel);
  const rows = db.all(
    `SELECT t.id FROM transactions t WHERE ${s.where.join(" AND ")} AND t.occurred_at >= ? AND t.occurred_at < ? ORDER BY t.occurred_at`,
    [...s.params, from, to],
  ) as Array<{ id: number }>;
  return rows.map((r) => Number(r.id)).filter((id) => {
    if (!sel.window) return true;
    const at = (db.get(`SELECT occurred_at AS at FROM transactions WHERE id = ?`, [id]) as { at: number } | undefined)?.at;
    return at != null && inHabitWindow(minuteOfDay(Number(at)), sel.window);
  });
}

export function matchingTxs(db: DbAdapter, sel: HabitSelector, from: number, to: number): HabitTx[] {
  const ids = matchingTxIds(db, sel, from, to);
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT t.id, t.occurred_at AS at, t.amount, (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id=tl.label_id
       WHERE tl.tx_id=t.id AND tl.confirmed_at IS NOT NULL ORDER BY tl.confirmed_at DESC LIMIT 1) AS label
       FROM transactions t WHERE t.id IN (${ids.map(() => "?").join(",")}) ORDER BY t.occurred_at`, ids,
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), amountCents: Number(r.amount), label: r.label == null ? null : String(r.label) }));
}

/** Preview copy for the creation flow. */
export function selectorPreview(db: DbAdapter, sel: HabitSelector, now = Date.now()): { count: number; valueCents: number; examples: HabitTx[] } {
  const from = now - 56 * 86_400_000;
  const txs = matchingTxs(db, sel, from, now);
  return { count: txs.length, valueCents: txs.reduce((a, t) => a + t.amountCents, 0), examples: txs.slice(-5).reverse() };
}
