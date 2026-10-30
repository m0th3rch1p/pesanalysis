/**
 * Transaction bundles group one real cash movement with evidence from another
 * channel. The first supported case is an airtime purchase: M-Pesa pays a till
 * (e.g. TINGG), then the telco credits airtime. The cash event is the payment;
 * the credit is evidence, never income. The difference is the hidden fee.
 *
 * Bundling is deliberately conservative: same 15-minute window, credit <= paid,
 * a small value gap, and an airtime-looking merchant. A random payment next to
 * an airtime gift is not merged.
 */
import type { DbAdapter } from "../db/migrate.js";
import { lastInsertId } from "../db/migrate.js";
import { reindexTx } from "../search/service.js";

export interface TxBundleRow {
  id: number;
  kind: string;
  primaryTxId: number;
  paidCents: number;
  receivedCents: number;
  hiddenFeeCents: number;
  note: string | null;
  createdAt: number;
}

const WINDOW_MS = 15 * 60_000;
const AIRTIME_MERCHANT = `(
  t.kind IN ('airtime','bundle')
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%tingg%'
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%airtime%'
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%safaricom%'
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%airtel%'
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%me2u%'
  OR LOWER(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '')) LIKE '%bundle%'
)`;

function mapBundle(r: Record<string, unknown>): TxBundleRow {
  return {
    id: Number(r.id), kind: String(r.kind), primaryTxId: Number(r.primary_tx_id),
    paidCents: Number(r.paid_cents), receivedCents: Number(r.received_cents),
    hiddenFeeCents: Number(r.hidden_fee_cents), note: r.note == null ? null : String(r.note),
    createdAt: Number(r.created_at),
  };
}

export interface BundleInput {
  kind?: string;
  primaryTxId: number;
  paidCents: number;
  receivedCents: number;
  hiddenFeeCents: number;
  note?: string | null;
  evidenceTxId?: number;
}

/** Create/update a bundle and make the evidence row non-canonical. */
export function upsertBundle(db: DbAdapter, input: BundleInput, now = Date.now()): number {
  const kind = input.kind ?? "airtime";
  const existing = db.get(`SELECT id, primary_tx_id AS primaryTxId FROM tx_bundles WHERE primary_tx_id = ?`, [input.primaryTxId]) as { id: number } | undefined;
  let id = existing ? Number(existing.id) : 0;
  if (id) {
    db.run(
      `UPDATE tx_bundles SET kind = ?, paid_cents = ?, received_cents = ?, hidden_fee_cents = ?, note = ? WHERE id = ?`,
      [kind, input.paidCents, input.receivedCents, input.hiddenFeeCents, input.note ?? null, id],
    );
  } else {
    const r = db.run(
      `INSERT INTO tx_bundles (kind, primary_tx_id, paid_cents, received_cents, hidden_fee_cents, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [kind, input.primaryTxId, input.paidCents, input.receivedCents, input.hiddenFeeCents, input.note ?? null, now],
    );
    id = lastInsertId(r) || Number((db.get(`SELECT id FROM tx_bundles WHERE primary_tx_id = ?`, [input.primaryTxId]) as { id?: number } | undefined)?.id ?? 0);
  }
  db.run(`UPDATE transactions SET bundle_id = ? WHERE id = ?`, [id, input.primaryTxId]);
  if (input.evidenceTxId) {
    db.run(`UPDATE transactions SET bundle_id = ?, role = 'airtime_credit' WHERE id = ?`, [id, input.evidenceTxId]);
    reindexTx(db, input.evidenceTxId);
  }
  // A complete airtime bundle is a high-precision rule: the cash out and the
  // credited value are both visible. Auto-file it, while keeping the source
  // visible so the user can override it.
  const label = db.get(`SELECT id FROM labels WHERE name = 'Airtime & data' AND status = 'active' LIMIT 1`) as { id?: number } | undefined;
  if (label?.id) {
    const confirmed = db.get(`SELECT 1 FROM tx_labels WHERE tx_id = ? AND confirmed_at IS NOT NULL LIMIT 1`, [input.primaryTxId]);
    if (!confirmed) {
      db.run(
        `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
         VALUES (?, ?, 'bundle', 0.9, ?, ?)
         ON CONFLICT(tx_id, label_id) DO UPDATE SET source = 'bundle', confidence = excluded.confidence, confirmed_at = excluded.confirmed_at`,
        [input.primaryTxId, label.id, now, now],
      );
      db.run(`UPDATE transactions SET status = 'auto' WHERE id = ? AND status = 'pending'`, [input.primaryTxId]);
    }
  }
  reindexTx(db, input.primaryTxId);
  return id;
}

/** Find a plausible airtime-purchase parent for a credited-airtime row. */
export function findAirtimePurchase(db: DbAdapter, creditTxId: number, creditCents: number, at: number): { id: number; amount: number; occurredAt: number } | null {
  const threshold = Math.max(500, Math.round(creditCents * 0.25));
  return (db.get(
    `SELECT t.id, t.amount, t.occurred_at AS occurredAt
       FROM transactions t
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.id <> ?
        AND t.direction = 'out' AND t.role = 'transaction'
        AND t.bundle_id IS NULL
        AND t.kind IN ('till','paybill','send','airtime','bundle')
        AND t.amount >= ?
        AND (t.amount - ?) <= ?
        AND ABS(t.occurred_at - ?) <= ?
        AND ${AIRTIME_MERCHANT}
      ORDER BY ABS((t.amount - ?)) ASC, ABS(t.occurred_at - ?) ASC, t.id DESC
      LIMIT 1`,
    [creditTxId, creditCents, creditCents, threshold, at, WINDOW_MS, creditCents, at],
  ) as { id: number; amount: number; occurredAt: number } | undefined) ?? null;
}

/** Link one credited-airtime row to a parent payment, when a safe match exists. */
export function linkAirtimeCredit(db: DbAdapter, creditTxId: number, creditCents: number, at: number, now = Date.now()): TxBundleRow | null {
  const parent = findAirtimePurchase(db, creditTxId, creditCents, at);
  if (!parent) {
    db.run(`UPDATE transactions SET role = 'airtime_credit' WHERE id = ?`, [creditTxId]);
    reindexTx(db, creditTxId);
    return null;
  }
  const hidden = Math.max(0, Number(parent.amount) - creditCents);
  const id = upsertBundle(db, {
    kind: "airtime", primaryTxId: parent.id, evidenceTxId: creditTxId,
    paidCents: Number(parent.amount), receivedCents: creditCents, hiddenFeeCents: hidden,
    note: hidden > 0 ? `Airtime value ${hidden} cents below the payment.` : null,
  }, now);
  return getBundle(db, id);
}

export function getBundle(db: DbAdapter, id: number): TxBundleRow | null {
  const row = db.get(`SELECT * FROM tx_bundles WHERE id = ?`, [id]);
  return row ? mapBundle(row) : null;
}

export function bundleForTx(db: DbAdapter, txId: number): TxBundleRow | null {
  const row = db.get(
    `SELECT b.* FROM tx_bundles b JOIN transactions t ON t.bundle_id = b.id WHERE t.id = ?`,
    [txId],
  );
  return row ? mapBundle(row) : null;
}

/**
 * One-time repair for rows captured before bundling existed. Non-matching
 * credits remain excluded from cash flow, but are no longer shown as income.
 */
export function backfillAirtimeBundles(db: DbAdapter, now = Date.now()): { scanned: number; bundled: number } {
  const done = db.get(`SELECT value FROM meta WHERE key = 'airtime_bundle_backfill_v1'`);
  if (done) return { scanned: 0, bundled: 0 };
  const rows = db.all(
    `SELECT id, amount, occurred_at AS occurredAt FROM transactions
      WHERE kind = 'airtime' AND direction = 'in' AND bundle_id IS NULL
        AND template NOT LIKE 'airtel.airtime_loan%'
        AND template NOT LIKE 'airtel.kopa_repay%'
      ORDER BY occurred_at`,
  ) as Array<{ id: number; amount: number; occurredAt: number }>;
  let bundled = 0;
  for (const r of rows) {
    if (linkAirtimeCredit(db, Number(r.id), Number(r.amount), Number(r.occurredAt), now)) bundled++;
  }
  db.run(`INSERT INTO meta (key, value) VALUES ('airtime_bundle_backfill_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  return { scanned: rows.length, bundled };
}


/** Ensure existing bundle parents carry the high-precision airtime rule. */
export function promoteAirtimeBundles(db: DbAdapter, now = Date.now()): number {
  const label = db.get(`SELECT id FROM labels WHERE name = 'Airtime & data' AND status = 'active' LIMIT 1`) as { id?: number } | undefined;
  if (!label?.id) return 0;
  const rows = db.all(
    `SELECT b.primary_tx_id AS txId FROM tx_bundles b JOIN transactions t ON t.id = b.primary_tx_id
      WHERE t.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM tx_labels c WHERE c.tx_id = t.id AND c.confirmed_at IS NOT NULL)`,
  ) as Array<{ txId: number }>;
  for (const r of rows) {
    db.run(
      `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
       VALUES (?, ?, 'bundle', 0.9, ?, ?)
       ON CONFLICT(tx_id, label_id) DO UPDATE SET source = 'bundle', confidence = 0.9, confirmed_at = excluded.confirmed_at`,
      [r.txId, label.id, now, now],
    );
    db.run(`UPDATE transactions SET status = 'auto' WHERE id = ?`, [r.txId]);
  }
  return rows.length;
}
