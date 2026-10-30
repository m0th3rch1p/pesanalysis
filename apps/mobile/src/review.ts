import type { SQLiteDatabase } from "expo-sqlite";
import { addTxItem, learnItemPricesForTx, parseNote, SEED_LABELS, formatKes, learnLexicon, reindexTx, type UserLexicon } from "@yako/core";
import { asDbAdapter } from "./db/open";

export interface PendingTx {
  txId: number;
  title: string;
  amount: number;
  kind: string;
  direction: "in" | "out" | "neutral";
  template: string;
  occurredAt: number;
  suggested: string | null;
  confidence: number | null;
  cpName: string | null;
  /** quick-pick labels: suggestion first, then common seeds */
  choices: string[];
  /** recency + repetition + amount; used for onboarding and the default queue */
  priority: number;
  cpTxCount: number;
}

const QUICK_SEND = ["Groceries", "Eating out", "Transport", "Airtime & data", "Family support", "Shopping", "Transfer out"];
const QUICK_RECEIVE = ["Transfer in", "Sales (business)", "Salary", "Family support", "Other income", "Savings & investment"];
const BY_KIND: Record<string, string[]> = {
  withdraw: ["Cash withdrawal", "Family support", "Business stock", "Shopping", "Transport", "Other"],
  loan_repay: ["Debt repayment", "Fees & charges", "Business stock", "Family support", "Shopping", "Other"],
  airtime: ["Airtime & data", "Family support", "Transport", "Shopping", "Business stock", "Other"],
  bundle: ["Airtime & data", "Family support", "Transport", "Shopping", "Business stock", "Other"],
  paybill: ["Utilities", "Rent", "Business stock", "Family support", "Fees & charges", "Other"],
  till: ["Groceries", "Eating out", "Fuel", "Business stock", "Transport", "Other"],
};
const INFLOW = new Set(["receive", "deposit", "bank_credit", "reversal"]);

/** Pending = parsed, not yet confirmed by the user (auto-filed rows are 'auto'). */
export function pendingTxs(db: SQLiteDatabase, limit = 50): PendingTx[] {
  const rows = db.getAllSync<{
    txId: number; amount: number; kind: string; direction: string; template: string; occurredAt: number;
    label: string | null; confidence: number | null; cpRaw: string | null; cpDisplay: string | null;
    cpTxCount: number;
  }>(
    `SELECT t.id AS txId, t.amount, t.kind, t.direction, t.template, t.occurred_at AS occurredAt,
            l.name AS label, tl.confidence, c.raw_names AS cpRaw, c.display_name AS cpDisplay,
            (SELECT COUNT(*) FROM transactions x WHERE x.counterparty_id = t.counterparty_id AND x.role = 'transaction') AS cpTxCount
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (
         SELECT x.rowid FROM tx_labels x
          WHERE x.tx_id = t.id AND x.confirmed_at IS NULL
          ORDER BY x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM tx_labels c WHERE c.tx_id = t.id AND c.confirmed_at IS NOT NULL)
      ORDER BY t.occurred_at DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => {
    const suggested = r.label;
    const quick = INFLOW.has(r.kind) ? QUICK_RECEIVE : (BY_KIND[r.kind] ?? QUICK_SEND);
    const choices = [...new Set([...(suggested ? [suggested] : []), ...quick])].slice(0, 6);
    return {
      txId: r.txId,
      title: `${formatKes(r.amount)} · ${r.kind.replace(/_/g, " ")}`,
      amount: r.amount,
      kind: r.kind,
      direction: r.direction as "in" | "out" | "neutral",
      template: r.template,
      occurredAt: r.occurredAt,
      suggested,
      confidence: r.confidence,
      cpName: r.cpDisplay ?? (() => { try { return (JSON.parse(r.cpRaw ?? "[]") as string[])[0] ?? null; } catch { return null; } })(),
      choices,
      cpTxCount: Number(r.cpTxCount ?? 0),
      priority: 0,
    };
  }).map((r) => {
    const ageDays = Math.max(0, (Date.now() - r.occurredAt) / 86_400_000);
    const recency = ageDays <= 3 ? 3 : ageDays <= 7 ? 2.4 : ageDays <= 30 ? 1.3 : 0.3;
    const repetition = Math.min(2.5, r.cpTxCount / 3);
    const size = r.amount >= 100_000 ? 0.8 : r.amount >= 10_000 ? 0.3 : 0;
    return { ...r, priority: recency + repetition + size };
  }).sort((a, b) => b.priority - a.priority || b.occurredAt - a.occurredAt);
}

function labelId(db: SQLiteDatabase, name: string): number {
  const hit = db.getFirstSync<{ id: number }>(`SELECT id FROM labels WHERE name = ? AND status = 'active' LIMIT 1`, [name]);
  if (hit) return hit.id;
  const r = db.runSync(`INSERT INTO labels (name, is_custom, created_at) VALUES (?, 1, ?)`, [name, Date.now()]);
  return Number(r.lastInsertRowId);
}

/**
 * The one tap. Writes ground truth for learning (tx_labels.confirmed_at) and
 * flips the tx to 'confirmed'. Idempotent: re-confirming a different label keeps
 * both rows but marks only the latest as confirmed.
 */
export function confirmTx(db: SQLiteDatabase, txId: number, label: string, source = "user", detail?: string): void {
  const id = labelId(db, label);
  const now = Date.now();
  const note = (detail ?? "").trim();
  db.runSync(`UPDATE tx_labels SET confirmed_at = NULL WHERE tx_id = ? AND label_id <> ?`, [txId, id]);
  db.runSync(
    `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
     VALUES (?, ?, ?, 1.0, ?, ?)
     ON CONFLICT(tx_id, label_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, source = excluded.source, confidence = 1.0`,
    [txId, id, source, now, now],
  );
  db.runSync(`UPDATE transactions SET status = 'confirmed' WHERE id = ?`, [txId]);
  db.runSync(
    `UPDATE counterparties SET default_label_id = ?
      WHERE id = (SELECT counterparty_id FROM transactions WHERE id = ?)`,
    [id, txId],
  );

  if (note) {
    db.runSync(`DELETE FROM tx_notes WHERE tx_id = ? AND kind = 'note'`, [txId]);
    db.runSync(
      `INSERT INTO tx_notes (tx_id, kind, text, created_at) VALUES (?, 'note', ?, ?)`,
      [txId, note, now],
    );
    saveLexicon(db, learnLexicon(note, label, loadLexicon(db)));
    const tx = db.getFirstSync<{ amount: number; direction: string; kind: string; template: string; cpName: string | null }>(
      `SELECT t.amount, t.direction, t.kind, t.template,
              COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName
         FROM transactions t LEFT JOIN counterparties c ON c.id = t.counterparty_id WHERE t.id = ?`, [txId],
    );
    if (tx) {
      const parsed = parseNote(note, {
        direction: tx.direction === "in" ? "in" : "out", txAmountCents: tx.amount,
        interpretCtx: { direction: tx.direction === "in" ? "in" : "out", kind: tx.kind, template: tx.template, counterpartyName: tx.cpName },
      });
      if (parsed.items.length) {
        db.runSync(`DELETE FROM tx_items WHERE tx_id = ? AND source IN ('note','inferred')`, [txId]);
        for (const it of parsed.items) {
          addTxItem(asDbAdapter(db), txId, {
            item: it.name, qty: it.qty, unit: it.unit, amountCents: it.amountCents, source: "note", confirmed: true,
          }, now);
        }
        learnItemPricesForTx(asDbAdapter(db), txId, now);
      }
    }
  }
  reindexTx(asDbAdapter(db), txId);
}

const LEXICON_KEY = "user_lexicon_v1";

/** Words the user has taught us ("wiki" -> Pets). Kept in meta, never leaves the phone. */
export function loadLexicon(db: SQLiteDatabase): UserLexicon {
  try {
    const row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [LEXICON_KEY]);
    const raw = JSON.parse(row?.value ?? "{}") as Record<string, unknown>;
    const out: UserLexicon = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}

export function saveLexicon(db: SQLiteDatabase, lexicon: UserLexicon): void {
  db.runSync(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [LEXICON_KEY, JSON.stringify(lexicon)],
  );
}

export function seedLabelNames(): string[] {
  return SEED_LABELS.map((l) => l.name);
}
