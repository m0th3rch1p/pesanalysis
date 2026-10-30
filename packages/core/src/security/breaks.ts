/**
 * Post-pass classification for balance-chain breaks (WS4.2). Suppressed breaks stay in the
 * ledger as audit rows; they are never deleted. A break is only suppressed when a known
 * bookkeeping cause explains it, not because the amount looks odd.
 */
import type { DbAdapter } from "../db/migrate.js";
import { maskPhones } from "./mask.js";

export type BreakReason = "fuliza_reorder" | "opposite_pair" | "airtel_model";

const R = (s: string) => s;

interface AlertRow {
  id: number; txId: number | null; sender: string; occurredAt: number;
  evidence: Record<string, unknown>; visibility: string | null; suppressedReason: string | null; resolvedAt: number | null;
}

function alert(db: DbAdapter, id: number): AlertRow | null {
  const r = db.get(
    `SELECT id, tx_id AS txId, sender, occurred_at AS occurredAt, evidence_json AS evidenceJson,
            visibility, suppressed_reason AS suppressedReason, resolved_at AS resolvedAt
       FROM security_alerts WHERE id = ?`, [id],
  ) as Record<string, unknown> | undefined;
  if (!r) return null;
  let evidence: Record<string, unknown> = {};
  try { evidence = JSON.parse(String(r.evidenceJson ?? "{}")) as Record<string, unknown>; } catch { /* empty */ }
  return {
    id: Number(r.id), txId: r.txId == null ? null : Number(r.txId), sender: String(r.sender), occurredAt: Number(r.occurredAt),
    evidence, visibility: r.visibility == null ? null : String(r.visibility),
    suppressedReason: r.suppressedReason == null ? null : String(r.suppressedReason),
    resolvedAt: r.resolvedAt == null ? null : Number(r.resolvedAt),
  };
}

function suppress(db: DbAdapter, id: number, reason: BreakReason): void {
  db.run(`UPDATE security_alerts SET visibility = 'audit', suppressed_reason = ? WHERE id = ?`, [reason, id]);
}

/** Returns the suppression reason, or null when the break remains prominent. */
export function classifyBalanceBreak(db: DbAdapter, alertId: number): BreakReason | null {
  const a = alert(db, alertId);
  if (!a || a.resolvedAt != null || a.visibility === "audit") return null;
  const d = Number(a.evidence.discrepancy ?? 0);
  if (!Number.isFinite(d) || d === 0 || a.txId == null) return null;
  const tx = db.get(
    `SELECT provider, kind, direction, amount, fee, balance_after AS balanceAfter, occurred_at AS occurredAt
       FROM transactions WHERE id = ?`, [a.txId],
  ) as { provider?: string; kind?: string; direction?: string; amount?: number; fee?: number; balanceAfter?: number | null; occurredAt?: number } | undefined;
  if (!tx) return null;

  if (tx.provider === "airtel_money" && (tx.kind === "airtime" || tx.kind === "bundle")) {
    suppress(db, a.id, "airtel_model");
    return "airtel_model";
  }

  // A missing balance-less loan movement (or a combination of them) can explain the gap
  // when the loan arrived out of order. Try every subset of nearby effects, not just one.
  const loans = db.all(
    `SELECT kind, amount, fee FROM transactions
      WHERE provider = ? AND balance_after IS NULL AND kind IN ('loan_draw','loan_repay')
        AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at LIMIT 8`,
    [tx.provider, a.occurredAt - 300_000, a.occurredAt + 300_000],
  ) as Array<{ kind: string; amount: number; fee: number | null }>;
  const effects = loans.map((l) => l.kind === "loan_draw" ? (tx.provider === "mpesa" ? l.amount : 0) : -(l.amount + (l.fee ?? 0))).filter((n) => n !== 0);
  const target = Math.abs(d);
  if (effects.length && effects.length <= 12) {
    let found = false;
    for (let mask = 1; mask < (1 << effects.length) && !found; mask++) {
      let sum = 0;
      for (let i = 0; i < effects.length; i++) if (mask & (1 << i)) sum += effects[i]!;
      if (Math.abs(Math.abs(sum) - target) <= 1) found = true;
    }
    if (found) { suppress(db, a.id, "fuliza_reorder"); return "fuliza_reorder"; }
  }

  const pair = db.get(
    `SELECT id FROM security_alerts
      WHERE kind = 'balance_break' AND id <> ? AND resolved_at IS NULL
        AND COALESCE(visibility,'prominent') = 'prominent'
        AND ABS(occurred_at - ?) <= 1800000
        AND CAST(json_extract(evidence_json, '$.discrepancy') AS INTEGER) = ?
      LIMIT 1`,
    [a.id, a.occurredAt, -d],
  ) as { id?: number } | undefined;
  if (pair?.id) {
    suppress(db, a.id, "opposite_pair");
    suppress(db, Number(pair.id), "opposite_pair");
    return "opposite_pair";
  }
  return null;
}

/** Run after ingest/nightly so late-arriving neighbours can explain an earlier break. */
export function suppressBalanceBreaks(db: DbAdapter, since = 0): { suppressed: number } {
  const rows = db.all(
    `SELECT id FROM security_alerts
      WHERE kind = 'balance_break' AND resolved_at IS NULL AND occurred_at >= ?
      ORDER BY occurred_at`, [since],
  ) as Array<{ id: number }>;
  let suppressed = 0;
  for (const r of rows) {
    if (classifyBalanceBreak(db, Number(r.id))) suppressed++;
    const a = alert(db, Number(r.id));
    if (!a) continue;
    const d = Number(a.evidence.discrepancy ?? 0);
    const provider = String(a.evidence.provider ?? "mpesa");
    db.run(`UPDATE security_alerts SET title = ?, detail = ? WHERE id = ?`,
      ["Balance doesn't add up after this payment", BALANCE_BREAK_COPY(provider, d), a.id]);
  }
  return { suppressed };
}

export interface BalanceBreakEvidence {
  discrepancyCents: number;
  previousBalanceCents: number | null;
  statedBalanceCents: number | null;
  expectedBalanceCents: number | null;
  previousAt: number | null;
  steps: Array<{ id: number; at: number; direction: string; amountCents: number; feeCents: number; kind: string }>;
}

export function balanceBreakEvidence(db: DbAdapter, alertId: number): BalanceBreakEvidence | null {
  const a = alert(db, alertId);
  if (!a || a.txId == null) return null;
  const tx = db.get(
    `SELECT balance_after AS stated, occurred_at AS at FROM transactions WHERE id = ?`, [a.txId],
  ) as { stated?: number | null; at?: number } | undefined;
  if (!tx) return null;
  const prev = db.get(
    `SELECT balance_after AS balance, occurred_at AS at FROM transactions
      WHERE id <> ? AND balance_after IS NOT NULL AND occurred_at < ? ORDER BY occurred_at DESC LIMIT 1`,
    [a.txId, tx.at],
  ) as { balance?: number; at?: number } | undefined;
  const steps = db.all(
    `SELECT id, occurred_at AS at, direction, amount, fee, kind FROM transactions
      WHERE occurred_at > ? AND occurred_at <= ? AND role IN ('transaction','funding_notice')
      ORDER BY occurred_at LIMIT 6`,
    [prev?.at ?? tx.at! - 86_400_000, tx.at],
  ) as Array<Record<string, unknown>>;
  const d = Number(a.evidence.discrepancy ?? 0);
  const stated = tx.stated ?? null;
  return {
    discrepancyCents: d, previousBalanceCents: prev?.balance ?? null, statedBalanceCents: stated,
    expectedBalanceCents: stated == null ? null : stated + d, previousAt: prev?.at ?? null,
    steps: steps.map((s) => ({
      id: Number(s.id), at: Number(s.at), direction: String(s.direction), amountCents: Number(s.amount),
      feeCents: Number(s.fee ?? 0), kind: String(s.kind),
    })),
  };
}

export interface NeighbourMessage { id: number; at: number; sender: string; body: string; amountCents: number | null; direction: string | null }

/** Three messages before and three after, same provider, phone numbers masked. */
export function neighbouringMessages(db: DbAdapter, txId: number, radius = 3): NeighbourMessage[] {
  const tx = db.get(`SELECT provider, occurred_at AS at FROM transactions WHERE id = ?`, [txId]) as { provider?: string; at?: number } | undefined;
  if (!tx?.at) return [];
  const before = db.all(
    `SELECT t.id, s.received_at AS at, s.sender, s.body, t.amount, t.direction
       FROM transactions t JOIN sms_raw s ON s.id = t.sms_id
      WHERE t.provider = ? AND t.id <> ? AND t.occurred_at < ? ORDER BY t.occurred_at DESC LIMIT ?`,
    [tx.provider, txId, tx.at, radius],
  ) as Array<Record<string, unknown>>;
  const after = db.all(
    `SELECT t.id, s.received_at AS at, s.sender, s.body, t.amount, t.direction
       FROM transactions t JOIN sms_raw s ON s.id = t.sms_id
      WHERE t.provider = ? AND t.id <> ? AND t.occurred_at > ? ORDER BY t.occurred_at ASC LIMIT ?`,
    [tx.provider, txId, tx.at, radius],
  ) as Array<Record<string, unknown>>;
  return [...before.reverse(), ...after].map((r) => ({
    id: Number(r.id), at: Number(r.at), sender: String(r.sender), body: maskPhones(String(r.body ?? "")),
    amountCents: r.amount == null ? null : Number(r.amount), direction: r.direction == null ? null : String(r.direction),
  }));
}

export function breakExplanation(reason: string): string {
  switch (reason) {
    case "fuliza_reorder": return "A Fuliza draw or repayment arrived out of order around this message. The balance is consistent once the loan movement is moved next to it.";
    case "opposite_pair": return "Two balance gaps cancel each other within 30 minutes. This is usually message ordering, not missing money.";
    case "airtel_model": return "Airtel airtime and bundle balances are not fully modelled yet, so this gap is kept in the audit view instead of being shown as a warning.";
    case "user_fine": return "You marked this sender pattern as fine. Future alerts of the same kind and sender will stay here.";
    default: return "Kept in the audit view for review.";
  }
}

export const BALANCE_BREAK_COPY = (provider: string, d: number) => R(
  `Your ${provider === "mpesa" ? "M-Pesa" : provider} balance doesn't add up after this payment (off by KES ${Math.abs(d) / 100}). Usually a message arrived late or is missing. Check the messages.`,
);

export interface AlertMessageView {
  sender: string; receivedAt: number | null; body: string | null;
  provider: string | null; ref: string | null; kind: string | null; direction: string | null;
  amountCents: number | null; feeCents: number | null; balanceAfterCents: number | null;
  counterparty: string | null; occurredAt: number | null;
}

/** Message + parsed fields for the evidence sheet, with phone numbers masked. */
export function alertMessageView(db: DbAdapter, a: { smsId?: number | null; txId?: number | null; sender: string }): AlertMessageView {
  let sms: Record<string, unknown> | undefined;
  if (a.smsId != null) sms = db.get(`SELECT sender, received_at AS at, body FROM sms_raw WHERE id = ?`, [a.smsId]) as Record<string, unknown> | undefined;
  let tx: Record<string, unknown> | undefined;
  if (a.txId != null) {
    tx = db.get(
      `SELECT t.provider, t.ref, t.kind, t.direction, t.amount, t.fee, t.balance_after AS balanceAfter,
              t.occurred_at AS occurredAt, COALESCE(c.display_name, json_extract(c.raw_names,'$[0]')) AS counterparty
         FROM transactions t LEFT JOIN counterparties c ON c.id = t.counterparty_id WHERE t.id = ?`, [a.txId],
    ) as Record<string, unknown> | undefined;
    if (!sms && tx) {
      const smsId = db.get(`SELECT sms_id AS id FROM transactions WHERE id = ?`, [a.txId]) as { id?: number } | undefined;
      if (smsId?.id) sms = db.get(`SELECT sender, received_at AS at, body FROM sms_raw WHERE id = ?`, [smsId.id]) as Record<string, unknown> | undefined;
    }
  }
  return {
    sender: String(sms?.sender ?? a.sender), receivedAt: sms?.at == null ? null : Number(sms.at),
    body: sms?.body == null ? null : maskPhones(String(sms.body)),
    provider: tx?.provider == null ? null : String(tx.provider), ref: tx?.ref == null ? null : String(tx.ref),
    kind: tx?.kind == null ? null : String(tx.kind), direction: tx?.direction == null ? null : String(tx.direction),
    amountCents: tx?.amount == null ? null : Number(tx.amount), feeCents: tx?.fee == null ? null : Number(tx.fee),
    balanceAfterCents: tx?.balanceAfter == null ? null : Number(tx.balanceAfter),
    counterparty: tx?.counterparty == null ? null : String(tx.counterparty),
    occurredAt: tx?.occurredAt == null ? null : Number(tx.occurredAt),
  };
}
