/**
 * First-class debt tracking. A debt is a liability, not a spending category:
 * the form stores the contract facts, then the ledger links repayments that
 * already exist. Linking is suggested, never silent, because a payment to a
 * person can be a gift, rent or a loan repayment.
 */
import type { DbAdapter } from "../db/migrate.js";
import { lastInsertId } from "../db/migrate.js";
import { normalizeName, normalizePhone } from "../entities/normalize.js";
import { reindexTx } from "../search/service.js";

export type DebtKind = "personal" | "business" | "loan" | "informal" | "other";
export type DebtFrequency = "weekly" | "biweekly" | "monthly" | "oneoff" | "irregular";

export interface DebtInput {
  name: string;
  creditor?: string | null;
  creditorPhone?: string | null;
  kind?: DebtKind;
  principalCents?: number | null;
  balanceCents?: number | null;
  interestRateBps?: number | null;
  interestType?: "none" | "simple" | "compound";
  paymentCents?: number | null;
  paymentFrequency?: DebtFrequency;
  startAt?: number | null;
  nextDueAt?: number | null;
  endAt?: number | null;
  source?: "manual" | "contract" | "web" | "inferred";
  contractUri?: string | null;
  notes?: string | null;
  confidence?: number | null;
}

export interface DebtRow {
  id: number;
  name: string; creditor: string | null; creditorPhone: string | null;
  kind: DebtKind;
  principalCents: number | null; balanceCents: number | null; interestRateBps: number | null;
  interestType: "none" | "simple" | "compound";
  paymentCents: number | null; paymentFrequency: DebtFrequency;
  startAt: number | null; nextDueAt: number | null; endAt: number | null;
  status: "active" | "settled" | "paused";
  source: "manual" | "contract" | "web" | "inferred";
  contractUri: string | null; notes: string | null; confidence: number | null;
  createdAt: number; updatedAt: number;
  linkedCount: number; paidCents: number;
}

export interface DebtLinkCandidate {
  debtId: number;
  txId: number;
  occurredAt: number;
  amountCents: number;
  cpName: string | null;
  label: string | null;
  score: number;
  reason: string;
}

function mapDebt(r: Record<string, unknown>): DebtRow {
  return {
    id: Number(r.id), name: String(r.name), creditor: r.creditor == null ? null : String(r.creditor),
    creditorPhone: r.creditor_phone == null ? null : String(r.creditor_phone),
    kind: String(r.kind) as DebtKind,
    principalCents: r.principal_cents == null ? null : Number(r.principal_cents),
    balanceCents: r.balance_cents == null ? null : Number(r.balance_cents),
    interestRateBps: r.interest_rate_bps == null ? null : Number(r.interest_rate_bps),
    interestType: String(r.interest_type ?? "none") as DebtRow["interestType"],
    paymentCents: r.payment_cents == null ? null : Number(r.payment_cents),
    paymentFrequency: String(r.payment_frequency ?? "monthly") as DebtFrequency,
    startAt: r.start_at == null ? null : Number(r.start_at),
    nextDueAt: r.next_due_at == null ? null : Number(r.next_due_at),
    endAt: r.end_at == null ? null : Number(r.end_at),
    status: String(r.status ?? "active") as DebtRow["status"],
    source: String(r.source ?? "manual") as DebtRow["source"],
    contractUri: r.contract_uri == null ? null : String(r.contract_uri),
    notes: r.notes == null ? null : String(r.notes),
    confidence: r.confidence == null ? null : Number(r.confidence),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    linkedCount: Number(r.linked_count ?? 0), paidCents: Number(r.paid_cents ?? 0),
  };
}

export function listDebts(db: DbAdapter, status: "active" | "settled" | "paused" | "all" = "active"): DebtRow[] {
  const where = status === "all" ? "" : "WHERE d.status = ?";
  const params = status === "all" ? [] : [status];
  return (db.all(
    `SELECT d.*,
            (SELECT COUNT(*) FROM debt_links dl WHERE dl.debt_id = d.id AND dl.status = 'accepted') AS linked_count,
            (SELECT COALESCE(SUM(t.amount), 0) FROM debt_links dl JOIN transactions t ON t.id = dl.tx_id
              WHERE dl.debt_id = d.id AND dl.status = 'accepted') AS paid_cents
       FROM debts d ${where} ORDER BY (d.status = 'active') DESC, COALESCE(d.next_due_at, 9e15), d.name`,
    params,
  ) as Array<Record<string, unknown>>).map(mapDebt);
}

export function getDebt(db: DbAdapter, id: number): DebtRow | null {
  const row = db.get(
    `SELECT d.*,
            (SELECT COUNT(*) FROM debt_links dl WHERE dl.debt_id = d.id AND dl.status = 'accepted') AS linked_count,
            (SELECT COALESCE(SUM(t.amount), 0) FROM debt_links dl JOIN transactions t ON t.id = dl.tx_id
              WHERE dl.debt_id = d.id AND dl.status = 'accepted') AS paid_cents
       FROM debts d WHERE d.id = ?`,
    [id],
  );
  return row ? mapDebt(row) : null;
}

function addFrequency(at: number | null, freq: DebtFrequency): number | null {
  if (at == null) return null;
  const d = new Date(at + 3 * 3_600_000);
  if (freq === "weekly") return at + 7 * 86_400_000;
  if (freq === "biweekly") return at + 14 * 86_400_000;
  if (freq === "monthly") {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) - 3 * 3_600_000);
    return next.getTime();
  }
  return null;
}

export function createDebt(db: DbAdapter, input: DebtInput, now = Date.now()): number {
  const name = input.name.trim();
  if (!name) throw new Error("debt name is required");
  const start = input.startAt ?? null;
  const next = input.nextDueAt ?? addFrequency(start, input.paymentFrequency ?? "monthly");
  const r = db.run(
    `INSERT INTO debts
      (name, creditor, creditor_phone, kind, principal_cents, balance_cents, interest_rate_bps, interest_type,
       payment_cents, payment_frequency, start_at, next_due_at, end_at, status, source, contract_uri, notes, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [name, input.creditor ?? null, normalizePhone(input.creditorPhone) ?? input.creditorPhone ?? null,
      input.kind ?? "personal", input.principalCents ?? null, input.balanceCents ?? input.principalCents ?? null,
      input.interestRateBps ?? null, input.interestType ?? "none", input.paymentCents ?? null,
      input.paymentFrequency ?? "monthly", start, next, input.endAt ?? null, input.source ?? "manual",
      input.contractUri ?? null, input.notes ?? null, input.confidence ?? null, now, now],
  );
  const id = lastInsertId(r) || Number((db.get(`SELECT id FROM debts WHERE name = ? ORDER BY id DESC LIMIT 1`, [name]) as { id?: number } | undefined)?.id ?? 0);
  suggestDebtLinks(db, id, now);
  return id;
}

export function updateDebt(db: DbAdapter, id: number, patch: Partial<DebtInput>, now = Date.now()): void {
  const fields: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, string> = {
    name: "name", creditor: "creditor", creditorPhone: "creditor_phone", kind: "kind",
    principalCents: "principal_cents", balanceCents: "balance_cents", interestRateBps: "interest_rate_bps",
    interestType: "interest_type", paymentCents: "payment_cents", paymentFrequency: "payment_frequency",
    startAt: "start_at", nextDueAt: "next_due_at", endAt: "end_at", contractUri: "contract_uri",
    notes: "notes", confidence: "confidence",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      fields.push(`${col} = ?`);
      const v = (patch as Record<string, unknown>)[k];
      params.push(k === "creditorPhone" ? normalizePhone(v as string) ?? v : v ?? null);
    }
  }
  if (!fields.length) return;
  fields.push("updated_at = ?");
  params.push(now, id);
  db.run(`UPDATE debts SET ${fields.join(", ")} WHERE id = ?`, params);
}

export function settleDebt(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE debts SET status = 'settled', balance_cents = 0, updated_at = ? WHERE id = ?`, [now, id]);
}

function nameMatch(a: string | null, b: string | null): number {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return x.includes(y) || y.includes(x) ? 0.75 : 0;
}

function amountMatch(amount: number, payment: number | null): number {
  if (!payment || payment <= 0) return 0.2;
  const diff = Math.abs(amount - payment) / payment;
  if (diff <= 0.02) return 1;
  if (diff <= 0.2) return 0.8;
  if (diff <= 0.5) return 0.45;
  return 0;
}

/**
 * Find repayment candidates. We require either a creditor match or a close
 * payment amount; a candidate is never auto-accepted.
 */
export function suggestDebtLinks(db: DbAdapter, debtId: number, now = Date.now(), max = 20): DebtLinkCandidate[] {
  const debt = getDebt(db, debtId);
  if (!debt) return [];
  const since = debt.startAt ?? 0;
  const phone = debt.creditorPhone ? normalizePhone(debt.creditorPhone) : null;
  const rows = db.all(
    `SELECT t.id AS txId, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') AS cpName,
            c.key AS cpKey,
            (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
              WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL LIMIT 1) AS label
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = 'out' AND t.occurred_at >= ?
        AND t.kind IN ('send','paybill','till','bank_debit','other')
      ORDER BY t.occurred_at DESC LIMIT 500`,
    [since],
  ) as Array<{ txId: number; occurredAt: number; amount: number; direction: string; kind: string; cpName: string; cpKey: string | null; label: string | null }>;
  const out: DebtLinkCandidate[] = [];
  for (const r of rows) {
    const existing = db.get(`SELECT status FROM debt_links WHERE debt_id = ? AND tx_id = ?`, [debtId, r.txId]) as { status?: string } | undefined;
    if (existing?.status === "accepted" || existing?.status === "dismissed") continue;
    const nm = nameMatch(r.cpName, debt.creditor);
    const phoneMatch = !!(phone && r.cpKey === `p:${phone}`);
    const am = amountMatch(Number(r.amount), debt.paymentCents);
    const score = Math.min(0.99, (phoneMatch ? 0.45 : nm * 0.5) + am * 0.45 + (r.kind === "send" ? 0.05 : 0));
    if (score < 0.55) continue;
    const reason = phoneMatch ? "Matches the creditor phone"
      : nm > 0.7 ? "Creditor name matches"
      : "Payment amount matches the repayment";
    db.run(
      `INSERT INTO debt_links (debt_id, tx_id, source, confidence, status, created_at)
       VALUES (?, ?, 'suggested', ?, 'pending', ?)
       ON CONFLICT(debt_id, tx_id) DO UPDATE SET confidence = excluded.confidence`,
      [debtId, r.txId, score, now],
    );
    out.push({
      debtId, txId: Number(r.txId), occurredAt: Number(r.occurredAt), amountCents: Number(r.amount),
      cpName: r.cpName || null, label: r.label, score, reason,
    });
  }
  out.sort((a, b) => b.score - a.score || b.occurredAt - a.occurredAt);
  return out.slice(0, max);
}

export function pendingDebtLinks(db: DbAdapter, debtId?: number): DebtLinkCandidate[] {
  const rows = db.all(
    `SELECT dl.debt_id AS debtId, dl.tx_id AS txId, dl.confidence AS score, t.occurred_at AS occurredAt,
            t.amount AS amountCents, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName,
            (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id LIMIT 1) AS label,
            'Suggested repayment' AS reason
       FROM debt_links dl JOIN transactions t ON t.id = dl.tx_id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE dl.status = 'pending' ${debtId == null ? "" : "AND dl.debt_id = ?"}
      ORDER BY dl.confidence DESC, t.occurred_at DESC LIMIT 100`,
    debtId == null ? [] : [debtId],
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    debtId: Number(r.debtId), txId: Number(r.txId), occurredAt: Number(r.occurredAt),
    amountCents: Number(r.amountCents), cpName: r.cpName == null ? null : String(r.cpName),
    label: r.label == null ? null : String(r.label), score: Number(r.score), reason: String(r.reason),
  }));
}

/** Link accepted repayments to the debt and give them a confirmed Debt repayment label/tag. */
export function acceptDebtLink(db: DbAdapter, debtId: number, txId: number, now = Date.now()): void {
  const debt = getDebt(db, debtId);
  if (!debt) throw new Error("debt not found");
  db.run(`UPDATE debt_links SET status = 'accepted', source = 'user', resolved_at = ? WHERE debt_id = ? AND tx_id = ?`, [now, debtId, txId]);
  const label = db.get(`SELECT id FROM labels WHERE name = 'Debt repayment' AND status = 'active' LIMIT 1`) as { id?: number } | undefined;
  if (label?.id) {
    db.run(
      `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
       VALUES (?, ?, 'debt', 1, ?, ?)
       ON CONFLICT(tx_id, label_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, source = 'debt', confidence = 1`,
      [txId, label.id, now, now],
    );
  }
  db.run(`UPDATE transactions SET status = 'confirmed' WHERE id = ?`, [txId]);
  const tagName = `Debt: ${debt.name}`;
  db.run(`INSERT OR IGNORE INTO tags (name, kind, created_at) VALUES (?, 'auto', ?)`, [tagName, now]);
  const tag = db.get(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`, [tagName]) as { id?: number } | undefined;
  if (tag?.id) db.run(`INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, 'rule', 1, ?)`, [txId, tag.id, now]);
  const tx = db.get(`SELECT occurred_at AS at, amount FROM transactions WHERE id = ?`, [txId]) as { at?: number; amount?: number } | undefined;
  if (debt.startAt == null && tx?.at != null) {
    db.run(`UPDATE debts SET start_at = ?, updated_at = ? WHERE id = ?`, [Number(tx.at), now, debtId]);
  }
  if (tx?.amount != null) {
    const remaining = Math.max(0, Number(debt.balanceCents ?? debt.principalCents ?? 0) - Number(tx.amount));
    const next = debt.nextDueAt != null && tx.at != null && debt.nextDueAt <= tx.at
      ? addFrequency(Number(tx.at), debt.paymentFrequency)
      : debt.nextDueAt;
    db.run(`UPDATE debts SET balance_cents = ?, next_due_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      [remaining, next, remaining === 0 ? "settled" : debt.status, now, debtId]);
  }
  reindexTx(db, txId);
}

export function dismissDebtLink(db: DbAdapter, debtId: number, txId: number, now = Date.now()): void {
  db.run(`UPDATE debt_links SET status = 'dismissed', resolved_at = ? WHERE debt_id = ? AND tx_id = ?`, [now, debtId, txId]);
}

export interface DebtSummary {
  active: number; outstandingCents: number; monthlyCents: number;
  nextDueAt: number | null; linkedRepayments: number;
}

export function debtSummary(db: DbAdapter): DebtSummary {
  const debts = listDebts(db, "active");
  return {
    active: debts.length,
    outstandingCents: debts.reduce((s, d) => s + Math.max(0, Number(d.balanceCents ?? 0)), 0),
    monthlyCents: debts.reduce((s, d) => {
      if (!d.paymentCents) return s;
      const factor = d.paymentFrequency === "weekly" ? 52 / 12 : d.paymentFrequency === "biweekly" ? 26 / 12 : d.paymentFrequency === "monthly" ? 1 : 0;
      return s + Math.round(d.paymentCents * factor);
    }, 0),
    nextDueAt: debts.map((d) => d.nextDueAt).filter((x): x is number => x != null).sort((a, b) => a - b)[0] ?? null,
    linkedRepayments: debts.reduce((s, d) => s + d.linkedCount, 0),
  };
}

/**
 * Local contract text extraction. Deterministic, no LLM and no network; it
 * returns only fields it can see and lets the user correct every value.
 */
export function extractDebtTerms(text: string): Partial<DebtInput> & { confidence: number } {
  const t = text.replace(/\s+/g, " ");
  const out: Partial<DebtInput> & { confidence: number } = { confidence: 0.35 };
  const amount = /(?:principal|loan amount|amount borrowed|kes|ksh)[^0-9]{0,20}([\d,]+(?:\.\d{1,2})?)/i.exec(t);
  if (amount) { out.principalCents = Math.round(Number(amount[1]!.replace(/,/g, "")) * 100); out.confidence += 0.2; }
  const rate = /(\d+(?:\.\d+)?)\s*%\s*(?:per|a|each)?\s*(month|monthly|year|annum|annual)/i.exec(t);
  if (rate) {
    const bps = Math.round(Number(rate[1]) * 100 * (/year|annum|annual/i.test(rate[2]!) ? 1 : 12));
    out.interestRateBps = bps; out.interestType = "simple"; out.confidence += 0.2;
  }
  const payment = /(?:repay|payment|installment|instalment)[^0-9]{0,30}([\d,]+(?:\.\d{1,2})?)\s*(?:per|a|each)?\s*(week|month|year)/i.exec(t);
  if (payment) {
    out.paymentCents = Math.round(Number(payment[1]!.replace(/,/g, "")) * 100);
    out.paymentFrequency = /week/i.test(payment[2]!) ? "weekly" : /year/i.test(payment[2]!) ? "monthly" : "monthly";
    out.confidence += 0.2;
  }
  const date = /(?:dated|date|start(?:ed|ing)?(?: on)?)[^0-9]{0,12}(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i.exec(t);
  if (date) {
    const s = date[1]!.replace(/\//g, "-");
    const m = /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/.exec(s);
    const iso = m ? `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : s;
    const at = Date.parse(`${iso}T00:00:00+03:00`);
    if (Number.isFinite(at)) { out.startAt = at; out.confidence += 0.15; }
  }
  return out;
}
