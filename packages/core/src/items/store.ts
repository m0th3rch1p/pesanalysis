/**
 * Item-level ledger (D110). A transaction may carry zero or more items; an item may
 * belong to a group and a habit. Nothing here is ever auto-confirmed: inference writes
 * source='inferred' and waits for the user.
 */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";
import { displayItemName, normalizeItemName } from "./normalize.js";
import { wilson } from "../detectors/stats.js";
import { habitGroupForItem } from "../habits/categories.js";

export type ItemSource = "inferred" | "note" | "ocr" | "user" | "gold";

export interface ItemRow { id: number; name: string; groupId: number | null; habitId: number | null }
export interface GroupRow { id: number; name: string; parentId: number | null; labelId: number | null }
export interface TxItemRow {
  id: number; txId: number; itemId: number | null; groupId: number | null; itemName: string | null;
  groupName: string | null; qty: number | null; unit: string | null; amountCents: number | null;
  source: ItemSource; confidence: number | null; confirmedAt: number | null;
}
export interface PriceRow { itemId: number; name: string; unitCents: number; seen: number }

export function ensureGroup(db: DbAdapter, name: string, opts: { parentId?: number | null; labelId?: number | null; now?: number } = {}): number {
  const clean = displayItemName(name);
  if (!clean) throw new Error("group name is empty");
  const existing = db.get(`SELECT id FROM item_groups WHERE name = ? COLLATE NOCASE LIMIT 1`, [clean]) as { id?: number } | undefined;
  if (existing?.id) return Number(existing.id);
  const r = db.run(
    `INSERT INTO item_groups (name, parent_id, label_id, created_at) VALUES (?, ?, ?, ?)`,
    [clean, opts.parentId ?? null, opts.labelId ?? null, opts.now ?? Date.now()],
  );
  return lastInsertId(r) || Number((db.get(`SELECT id FROM item_groups WHERE name = ? COLLATE NOCASE LIMIT 1`, [clean]) as { id?: number } | undefined)?.id ?? 0);
}

export function ensureItem(db: AdapterLike, name: string, opts: { groupId?: number | null; habitId?: number | null; now?: number } = {}): number {
  const clean = displayItemName(name);
  const key = normalizeItemName(clean);
  if (!key) throw new Error("item name is empty");
  const existing = db.get(`SELECT id FROM items WHERE key = ? LIMIT 1`, [key]) as { id?: number } | undefined;
  if (existing?.id) {
    if (opts.groupId != null) db.run(`UPDATE items SET group_id = COALESCE(group_id, ?) WHERE id = ?`, [opts.groupId, existing.id]);
    if (opts.habitId != null) db.run(`UPDATE items SET habit_id = COALESCE(habit_id, ?) WHERE id = ?`, [opts.habitId, existing.id]);
    return Number(existing.id);
  }
  const r = db.run(
    `INSERT INTO items (name, key, group_id, habit_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [clean, key, opts.groupId ?? null, opts.habitId ?? null, opts.now ?? Date.now()],
  );
  return lastInsertId(r) || Number((db.get(`SELECT id FROM items WHERE key = ? LIMIT 1`, [key]) as { id?: number } | undefined)?.id ?? 0);
}

// Small structural type so both DbAdapter and test helpers fit.
type AdapterLike = DbAdapter;

export interface AddTxItem {
  item?: string | null; group?: string | null; groupId?: number | null; itemId?: number | null;
  qty?: number | null; unit?: string | null; amountCents?: number | null;
  source?: ItemSource; confidence?: number | null; confirmed?: boolean;
}

export function addTxItem(db: DbAdapter, txId: number, x: AddTxItem, now = Date.now()): number {
  let groupId = x.groupId ?? (x.group ? ensureGroup(db, x.group, { now }) : null);
  const habit = !groupId && x.item ? habitGroupForItem(db, x.item) : null;
  if (habit) groupId = habit.groupId;
  const itemId = x.itemId ?? (x.item ? ensureItem(db, x.item, { groupId, habitId: habit?.habitId ?? null, now }) : null);
  if (itemId == null && groupId == null) throw new Error("an item or a group is required");
  const r = db.run(
    `INSERT INTO tx_items (tx_id, item_id, group_id, qty, unit, amount_cents, source, confidence, confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [txId, itemId, groupId, x.qty ?? null, x.unit ?? null, x.amountCents ?? null,
      x.source ?? "user", x.confidence ?? null, x.confirmed === false ? null : now, now],
  );
  return lastInsertId(r);
}

export function listTxItems(db: DbAdapter, txId: number): TxItemRow[] {
  return db.all(
    `SELECT ti.id, ti.tx_id AS txId, ti.item_id AS itemId, ti.group_id AS groupId,
            i.name AS itemName, g.name AS groupName, ti.qty, ti.unit, ti.amount_cents AS amountCents,
            ti.source, ti.confidence, ti.confirmed_at AS confirmedAt
       FROM tx_items ti LEFT JOIN items i ON i.id = ti.item_id LEFT JOIN item_groups g ON g.id = COALESCE(ti.group_id, i.group_id)
      WHERE ti.tx_id = ? ORDER BY ti.id`,
    [txId],
  ) as TxItemRow[];
}

export function confirmTxItems(db: DbAdapter, txId: number, now = Date.now()): number {
  const r = db.run(`UPDATE tx_items SET confirmed_at = ? WHERE tx_id = ? AND confirmed_at IS NULL`, [now, txId]);
  return Number((r as { changes?: number } | undefined)?.changes ?? 0);
}

export function deleteTxItems(db: DbAdapter, txId: number, source?: ItemSource): void {
  if (source) db.run(`DELETE FROM tx_items WHERE tx_id = ? AND source = ?`, [txId, source]);
  else db.run(`DELETE FROM tx_items WHERE tx_id = ?`, [txId]);
}

/** Rebuild learned unit prices from every confirmed item that has an amount. */
export function rebuildItemPrices(db: DbAdapter): number {
  db.run(`DELETE FROM item_prices`);
  const rows = db.all(
    `SELECT t.counterparty_id AS cpId, ti.item_id AS itemId,
            CAST(ROUND(ti.amount_cents / COALESCE(NULLIF(ti.qty, 0), 1)) AS INTEGER) AS unitCents,
            MIN(t.occurred_at) AS firstAt, MAX(t.occurred_at) AS lastAt, COUNT(*) AS seen
       FROM tx_items ti JOIN transactions t ON t.id = ti.tx_id
      WHERE ti.confirmed_at IS NOT NULL AND ti.item_id IS NOT NULL AND ti.amount_cents IS NOT NULL
        AND t.counterparty_id IS NOT NULL AND t.role = 'transaction'
      GROUP BY t.counterparty_id, ti.item_id, unitCents`,
  ) as Array<{ cpId: number; itemId: number; unitCents: number; firstAt: number; lastAt: number; seen: number }>;
  for (const r of rows) {
    db.run(
      `INSERT INTO item_prices (counterparty_id, item_id, unit_cents, seen, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [r.cpId, r.itemId, r.unitCents, r.seen, r.firstAt, r.lastAt],
    );
  }
  return rows.length;
}

/** Learn prices for one transaction's confirmed items without rebuilding everything. */
export function learnItemPricesForTx(db: AdapterLike, txId: number, now = Date.now()): void {
  const cp = db.get(`SELECT counterparty_id AS cpId FROM transactions WHERE id = ?`, [txId]) as { cpId?: number } | undefined;
  if (cp?.cpId == null) return;
  for (const x of listTxItems(db, txId)) {
    if (x.itemId == null || x.amountCents == null || x.confirmedAt == null) continue;
    const unit = Math.round(x.amountCents / Math.max(1, x.qty ?? 1));
    db.run(
      `INSERT INTO item_prices (counterparty_id, item_id, unit_cents, seen, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(counterparty_id, item_id, unit_cents) DO UPDATE SET seen = seen + 1, last_at = excluded.last_at`,
      [cp.cpId, x.itemId, unit, now, now],
    );
  }
}

export function pricesForCounterparty(db: DbAdapter, counterpartyId: number): PriceRow[] {
  return db.all(
    `SELECT ip.item_id AS itemId, i.name AS name, ip.unit_cents AS unitCents, ip.seen
       FROM item_prices ip JOIN items i ON i.id = ip.item_id
      WHERE ip.counterparty_id = ? ORDER BY ip.seen DESC, ip.unit_cents`,
    [counterpartyId],
  ) as PriceRow[];
}

export function topItemsForCounterparty(db: DbAdapter, counterpartyId: number, limit = 8): Array<{ itemId: number; name: string; count: number; totalCents: number }> {
  return db.all(
    `SELECT ti.item_id AS itemId, i.name AS name, COUNT(*) AS count, SUM(COALESCE(ti.amount_cents, 0)) AS totalCents
       FROM tx_items ti JOIN transactions t ON t.id = ti.tx_id JOIN items i ON i.id = ti.item_id
      WHERE t.counterparty_id = ? AND ti.confirmed_at IS NOT NULL
      GROUP BY ti.item_id ORDER BY count DESC, totalCents DESC LIMIT ?`,
    [counterpartyId, limit],
  ) as Array<{ itemId: number; name: string; count: number; totalCents: number }>;
}

export { wilson };
