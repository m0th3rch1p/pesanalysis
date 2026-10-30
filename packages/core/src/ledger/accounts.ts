/**
 * Auto-discovered account graph + visibility-boundary accounting + security alerts.
 * Accounts are activated on first sighting; off-radar destinations are recorded as
 * expenses from the visible wallet AND as capital moved into the target account.
 */
import type { DbAdapter } from "../db/migrate.js";
import { isFinePattern } from "../security/fine.js";
import { suppressBalanceBreaks } from "../security/breaks.js";
import type { ParsedSms } from "../types.js";
import { isOffRadarDestination, railForPaybill, railForSender, isVisibleWallet } from "../sms/rails-directory.js";
import { parseSms } from "../sms/parse.js";

export interface AccountRow {
  id: number; provider: string; kind: string; name: string; sender_id: string | null;
  account_mask: string; paybill_or_till: string | null; visibility: string;
  currency: string; last_balance_cents: number | null; last_balance_at: number | null;
  total_in_cents: number; total_out_cents: number; tx_count: number; status: string;
  discovered_via: string; created_at: number; updated_at: number;
  credit_limit_cents: number | null; available_credit_cents: number | null;
  outstanding_cents: number | null; due_at: number | null;
}

export interface SecurityAlertInput {
  smsId?: number | null; txId?: number | null;
  severity: "critical" | "warning" | "info";
  kind: "msisdn_spoof" | "balance_break" | "unsettled_mirror" | "reversal_trap" | "phishing";
  sender: string; title: string; detail: string;
  evidence: Record<string, unknown>; occurredAt: number;
  verdict?: "fine" | "report" | "unsure" | null;
  suppressedReason?: string | null;
  visibility?: "prominent" | "audit";
}

export interface SecurityAlertRow extends SecurityAlertInput {
  id: number; resolvedAt: number | null;
  verdict: "fine" | "report" | "unsure" | null;
  suppressedReason: string | null;
  visibility: "prominent" | "audit";
}

const now = () => Date.now();

function senderName(sender: string): string {
  return sender.trim().toUpperCase() || "UNKNOWN";
}

function getOrCreate(
  db: DbAdapter,
  a: { provider: string; kind: string; name: string; senderId?: string | null; mask: string; visibility: string; paybill?: string | null; via?: string },
): number {
  const found = db.get(`SELECT id FROM accounts WHERE provider = ? AND account_mask = ?`, [a.provider, a.mask]);
  if (found) return Number(found.id);
  const r = db.run(
    `INSERT INTO accounts (provider, kind, name, sender_id, account_mask, paybill_or_till, visibility, discovered_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.provider, a.kind, a.name, a.senderId ?? null, a.mask, a.paybill ?? null, a.visibility, a.via ?? "auto", now(), now()],
  );
  return Number((r as { lastInsertRowid?: number; lastInsertRowId?: number })?.lastInsertRowid
    ?? (r as { lastInsertRowId?: number })?.lastInsertRowId ?? 0);
}

function bump(
  db: DbAdapter,
  id: number, dir: "in" | "out", amount: number,
  balanceAfter: number | null | undefined, occurredAt: number,
): void {
  db.run(
    `UPDATE accounts SET
       total_in_cents = total_in_cents + ?,
       total_out_cents = total_out_cents + ?,
       tx_count = tx_count + 1,
       last_balance_cents = COALESCE(?, last_balance_cents),
       last_balance_at = CASE WHEN ? IS NULL THEN last_balance_at ELSE ? END,
       updated_at = ?
     WHERE id = ?`,
    [dir === "in" ? amount : 0, dir === "out" ? amount : 0,
      balanceAfter ?? null, balanceAfter ?? null, occurredAt, now(), id],
  );
}

function fulizaAccount(db: DbAdapter): AccountRow | null {
  return listAccounts(db).find((a) => a.kind === "credit" && /fuliza/i.test(a.name)) ?? null;
}

/**
 * A Fuliza snapshot must satisfy `limit = available + outstanding`; the three numbers can arrive in
 * different messages (a draw states the amount, a repayment states the available limit, a fee notice
 * states the outstanding). Filling the gaps and clamping keeps the Home card, the float sweep and the
 * Plan projection using one truth (D102).
 */
export function normaliseFuliza(i: { limit: number | null; available: number | null; outstanding: number | null }): {
  limit: number | null; available: number | null; outstanding: number | null; derived: boolean;
} {
  let { limit, available, outstanding } = i;
  const before = `${limit}|${available}|${outstanding}`;
  if (limit != null && available != null && outstanding == null) outstanding = Math.max(0, limit - available);
  if (limit != null && outstanding != null && available == null) available = Math.max(0, limit - outstanding);
  if (available != null && outstanding != null) limit = Math.max(limit ?? 0, available + outstanding);
  if (limit != null && available != null) available = Math.min(available, limit);
  if (limit != null && outstanding != null) outstanding = Math.min(outstanding, limit);
  return { limit, available, outstanding, derived: `${limit}|${available}|${outstanding}` !== before };
}

function updateFuliza(
  db: DbAdapter, p: ParsedSms, at: number,
): { id: number; availableCents: number | null; outstandingCents: number | null; limitCents: number | null } {
  const prior = fulizaAccount(db);
  const id = prior?.id ?? getOrCreate(db, {
    provider: "mpesa", kind: "credit", name: "Fuliza M-PESA", mask: "FULIZA",
    visibility: "credit", via: "auto",
  });
  const draw = p.kind === "loan_draw";
  const repay = p.kind === "loan_repay";
  const fullRepay = repay && /fuliza_repay_full/.test(p.template);
  const priorAvailable = prior?.available_credit_cents ?? null;
  const priorOutstanding = prior?.outstanding_cents ?? null;
  let available = p.availableCreditCents
    ?? (draw && priorAvailable != null ? Math.max(0, priorAvailable - p.amount) : priorAvailable);
  let outstanding = p.outstandingCents
    ?? (fullRepay ? 0
      : draw ? (priorOutstanding ?? 0) + p.amount
      : repay && priorOutstanding != null ? Math.max(0, priorOutstanding - p.amount)
      : priorOutstanding);
  let limit = p.creditLimitCents ?? prior?.credit_limit_cents ?? null;
  ({ limit, available, outstanding } = normaliseFuliza({ limit, available, outstanding }));
  // A cleared balance has no due date; an open one keeps the last stated date.
  const due = outstanding != null && outstanding <= 0 ? null : (p.dueAt ?? prior?.due_at ?? null);
  db.run(
    `UPDATE accounts SET
       credit_limit_cents = ?,
       available_credit_cents = ?,
       outstanding_cents = ?,
       due_at = ?,
       total_in_cents = total_in_cents + ?,
       total_out_cents = total_out_cents + ?,
       tx_count = tx_count + 1,
       updated_at = ?
     WHERE id = ?`,
    [limit, available, outstanding, due, draw ? p.amount : 0, repay ? p.amount : 0, now(), id],
  );
  return { id, availableCents: available, outstandingCents: outstanding, limitCents: limit };
}

/** Source account seen by the SMS; target account (if any) behind a paybill/till/vault. */
export function discoverAccount(
  db: DbAdapter,
  input: { sender: string; parsed: ParsedSms; occurredAt?: number; txId?: number },
): { sourceId: number; targetId: number | null } {
  const p = input.parsed;
  const at = input.occurredAt ?? p.occurredAt;
  const isFuliza = /fuliza/i.test(p.template) || /fuliza/i.test(p.counterpartyName ?? "");
  // A Fuliza draw is a funding notice: it credits spendable money but must not be booked
  // as an M-PESA outflow. The credit line gets its own node and balance.
  if (isFuliza && p.kind === "loan_draw") {
    const f = updateFuliza(db, p, at);
    if (input.txId) db.run(`UPDATE transactions SET account_id = ?, settlement_status = 'settled' WHERE id = ?`, [f.id, input.txId]);
    return { sourceId: f.id, targetId: null };
  }
  const rail = railForSender(input.sender);
  const provider = p.provider === "mpesa" ? "mpesa"
    : p.provider === "airtel_money" ? "airtel_money"
    : p.provider === "telco" ? "safaricom"
    : rail?.provider ?? (p.provider === "bank" ? senderName(input.sender).toLowerCase() : p.provider);

  const sourceMask = p.provider === "mpesa" ? "MPESA"
    : p.provider === "airtel_money" ? "AIRTEL"
    : p.provider === "telco" ? "SAFARICOM"
    : senderName(input.sender);
  const sourceKind = p.provider === "bank" ? "bank" : "wallet";
  const sourceVisibility = isVisibleWallet(p.provider) ? "full" : rail?.visibility ?? "partial";
  const sourceName = rail?.displayName ?? (p.provider === "mpesa" ? "M-PESA" : p.provider === "airtel_money" ? "Airtel Money" : senderName(input.sender));
  const sourceId = getOrCreate(db, {
    provider, kind: sourceKind, name: sourceName, senderId: input.sender,
    mask: sourceMask, visibility: sourceVisibility, via: "auto",
  });
  bump(db, sourceId, p.direction === "in" ? "in" : "out", p.amount, p.balanceAfter, at);
  if (isFuliza) updateFuliza(db, p, at);

  let targetId: number | null = null;
  if (p.direction === "out" && isOffRadarDestination(p)) {
    const targetRail = railForPaybill(p.counterpartyId) ?? (p.counterpartyName ? railForSender(p.counterpartyName) : null);
    const mask = p.account ?? p.counterpartyId ?? p.counterpartyName ?? "off-radar";
    targetId = getOrCreate(db, {
      provider: targetRail?.provider ?? "offradar",
      kind: targetRail?.kind ?? "vault",
      name: targetRail?.displayName ?? p.counterpartyName ?? "Off-radar destination",
      mask, visibility: targetRail?.visibility ?? "opaque", paybill: p.counterpartyId ?? null, via: "auto",
    });
    if (targetId && targetId !== sourceId) bump(db, targetId, "in", p.amount, null, at);
  }

  if (input.txId) {
    db.run(`UPDATE transactions SET account_id = ?, settlement_status = ? WHERE id = ?`, [
      sourceId, p.balanceAfter != null ? "settled" : "unknown", input.txId,
    ]);
  }
  return { sourceId, targetId };
}

export function insertSecurityAlert(db: DbAdapter, a: SecurityAlertInput): number {
  const dup = db.get(
    `SELECT id FROM security_alerts WHERE kind = ? AND COALESCE(tx_id,-1) = COALESCE(?,-1)
       AND COALESCE(sms_id,-1) = COALESCE(?,-1) AND resolved_at IS NULL LIMIT 1`,
    [a.kind, a.txId ?? null, a.smsId ?? null],
  );
  if (dup) return Number(dup.id);
  const learnedFine = isFinePattern(db, a.kind, a.sender);
  const visibility = a.visibility ?? (learnedFine ? "audit" : "prominent");
  const suppressedReason = a.suppressedReason ?? (learnedFine ? "user_fine" : null);
  const r = db.run(
    `INSERT INTO security_alerts (sms_id, tx_id, severity, kind, sender, title, detail, evidence_json, occurred_at, verdict, suppressed_reason, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.smsId ?? null, a.txId ?? null, a.severity, a.kind, a.sender, a.title, a.detail, JSON.stringify(a.evidence), a.occurredAt,
      a.verdict ?? null, suppressedReason, visibility],
  );
  return Number((r as { lastInsertRowid?: number; lastInsertRowId?: number })?.lastInsertRowid
    ?? (r as { lastInsertRowId?: number })?.lastInsertRowId ?? 0);
}

function mapAlert(r: Record<string, unknown>): SecurityAlertRow {
  return {
    id: Number(r.id), smsId: r.smsId == null ? null : Number(r.smsId), txId: r.txId == null ? null : Number(r.txId),
    severity: r.severity as SecurityAlertInput["severity"], kind: r.kind as SecurityAlertInput["kind"],
    sender: String(r.sender), title: String(r.title), detail: String(r.detail),
    evidence: (() => { try { return JSON.parse(String(r.evidenceJson ?? "{}")); } catch { return {}; } })(),
    occurredAt: Number(r.occurredAt), resolvedAt: r.resolvedAt == null ? null : Number(r.resolvedAt),
    verdict: r.verdict == null ? null : r.verdict as SecurityAlertRow["verdict"],
    suppressedReason: r.suppressedReason == null ? null : String(r.suppressedReason),
    visibility: (r.visibility === "audit" ? "audit" : "prominent"),
  };
}

const ALERT_SELECT = `SELECT id, sms_id AS smsId, tx_id AS txId, severity, kind, sender, title, detail,
  evidence_json AS evidenceJson, occurred_at AS occurredAt, resolved_at AS resolvedAt,
  verdict, suppressed_reason AS suppressedReason, COALESCE(visibility,'prominent') AS visibility
  FROM security_alerts`;

export function listSecurityAlerts(db: DbAdapter, limit = 20, includeAudit = false): SecurityAlertRow[] {
  return db.all(
    `${ALERT_SELECT} WHERE resolved_at IS NULL ${includeAudit ? "" : "AND COALESCE(visibility,'prominent') = 'prominent'"}
     ORDER BY occurred_at DESC LIMIT ?`,
    [limit],
  ).map((r: Record<string, unknown>) => mapAlert(r));
}

export function getSecurityAlert(db: DbAdapter, id: number): SecurityAlertRow | null {
  const r = db.get(`${ALERT_SELECT} WHERE id = ?`, [id]) as Record<string, unknown> | undefined;
  return r ? mapAlert(r) : null;
}

export function listAuditAlerts(db: DbAdapter, limit = 100): SecurityAlertRow[] {
  return db.all(
    `${ALERT_SELECT} WHERE COALESCE(visibility,'prominent') = 'audit' AND resolved_at IS NULL
     ORDER BY occurred_at DESC LIMIT ?`, [limit],
  ).map((r: Record<string, unknown>) => mapAlert(r));
}

export function securityAlertAuditGroups(db: DbAdapter): Array<{ reason: string; count: number }> {
  return db.all(
    `SELECT COALESCE(suppressed_reason,'audit') AS reason, COUNT(*) AS count FROM security_alerts
      WHERE COALESCE(visibility,'prominent') = 'audit' AND resolved_at IS NULL
      GROUP BY reason ORDER BY count DESC`,
  ) as Array<{ reason: string; count: number }>;
}

export function setSecurityAlertVerdict(db: DbAdapter, id: number, verdict: "fine" | "report" | "unsure", resolve = false, at = now()): void {
  db.run(`UPDATE security_alerts SET verdict = ?, resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END WHERE id = ?`, [verdict, resolve ? 1 : 0, at, id]);
}

export function resolveSecurityAlert(db: DbAdapter, id: number, at = now()): void {
  db.run(`UPDATE security_alerts SET resolved_at = ? WHERE id = ?`, [at, id]);
}

export function listAccounts(db: DbAdapter): AccountRow[] {
  return db.all(`SELECT * FROM accounts ORDER BY (visibility = 'full') DESC, total_out_cents DESC, name`).map((r: Record<string, unknown>) => ({
    id: Number(r.id), provider: String(r.provider), kind: String(r.kind), name: String(r.name),
    sender_id: r.sender_id == null ? null : String(r.sender_id), account_mask: String(r.account_mask),
    paybill_or_till: r.paybill_or_till == null ? null : String(r.paybill_or_till), visibility: String(r.visibility),
    currency: String(r.currency ?? "KES"), last_balance_cents: r.last_balance_cents == null ? null : Number(r.last_balance_cents),
    last_balance_at: r.last_balance_at == null ? null : Number(r.last_balance_at),
    total_in_cents: Number(r.total_in_cents ?? 0), total_out_cents: Number(r.total_out_cents ?? 0),
    tx_count: Number(r.tx_count ?? 0), status: String(r.status), discovered_via: String(r.discovered_via),
    created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    credit_limit_cents: r.credit_limit_cents == null ? null : Number(r.credit_limit_cents),
    available_credit_cents: r.available_credit_cents == null ? null : Number(r.available_credit_cents),
    outstanding_cents: r.outstanding_cents == null ? null : Number(r.outstanding_cents),
    due_at: r.due_at == null ? null : Number(r.due_at),
  }));
}

export interface FulizaState {
  accountId: number; limitCents: number | null; availableCents: number | null;
  outstandingCents: number | null; dueAt: number | null;
  /** when the credit-line snapshot last changed; null for a derived (no-account) state */
  asOf: number | null; stale: boolean;
  draws: number; drawCents: number; repayments: number; repayCents: number;
}

/** Latest credit-line state plus draw/repay counts. Null until a Fuliza SMS is seen. */
export function fulizaState(db: DbAdapter): FulizaState | null {
  const a = fulizaAccount(db);
  const rows = db.all(
    `SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total
       FROM transactions WHERE kind IN ('loan_draw','loan_repay') AND template LIKE 'mpesa.fuliza%'
      GROUP BY kind`,
  ) as Array<{ kind: string; n: number; total: number }>;
  const draw = rows.find((r) => r.kind === "loan_draw");
  const repay = rows.find((r) => r.kind === "loan_repay");
  const draws = Number(draw?.n ?? 0), drawCents = Number(draw?.total ?? 0);
  const repayments = Number(repay?.n ?? 0), repayCents = Number(repay?.total ?? 0);
  if (!a) {
    if (!draws && !repayments) return null;
    return {
      accountId: 0, limitCents: null, availableCents: null,
      outstandingCents: Math.max(0, drawCents - repayCents), dueAt: null,
      asOf: null, stale: false,
      draws, drawCents, repayments, repayCents,
    };
  }
  const n = normaliseFuliza({ limit: a.credit_limit_cents, available: a.available_credit_cents, outstanding: a.outstanding_cents });
  return {
    accountId: a.id, limitCents: n.limit, availableCents: n.available,
    outstandingCents: n.outstanding, dueAt: a.due_at, asOf: a.updated_at,
    stale: a.updated_at > 0 && now() - a.updated_at > 7 * 86_400_000,
    draws, drawCents, repayments, repayCents,
  };
}

/**
 * One-time backfill from stored Fuliza messages. Re-parsing is safe: this only updates the
 * credit-line node, not transactions. The available limit is used exactly as stated by Safaricom.
 */
export function backfillFulizaFromSms(db: DbAdapter, now = Date.now()): { scanned: number; updated: number } {
  const done = db.get(`SELECT value FROM meta WHERE key = 'fuliza_backfill_v1'`);
  if (done) return { scanned: 0, updated: 0 };
  const rows = db.all(
    `SELECT sender, body, received_at AS at FROM sms_raw
      WHERE purged_at IS NULL AND body LIKE '%Fuliza%' ORDER BY received_at`,
  ) as Array<{ sender: string; body: string; at: number }>;
  let updated = 0;
  for (const r of rows) {
    const o = parseSms({ sender: r.sender, body: r.body, receivedAt: Number(r.at) });
    if (!o.ok || !/fuliza/i.test(o.parsed.template)) continue;
    updateFuliza(db, o.parsed, o.parsed.occurredAt);
    updated++;
  }
  db.run(`INSERT INTO meta (key, value) VALUES ('fuliza_backfill_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  return { scanned: rows.length, updated };
}

/** Off-radar outflow + visible-wallet totals for the Hub card. */
export function offRadarSummary(db: DbAdapter, since: number): {
  accounts: AccountRow[]; offRadarCents: number; walletOutCents: number; share: number; alerts: number;
} {
  const accounts = listAccounts(db);
  const offRadarCents = Number((db.get(
    `SELECT SUM(t.amount) AS s FROM tx_events t
      WHERE t.occurred_at >= ? AND EXISTS (
        SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL AND l.name = 'Off-radar transfer')`, [since],
  ) as { s?: number } | undefined)?.s ?? 0);
  const walletOutCents = Number((db.get(
    `SELECT SUM(t.amount) AS s FROM tx_events t WHERE t.direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' AND t.occurred_at >= ?`, [since],
  ) as { s?: number } | undefined)?.s ?? 0);
  const alerts = Number((db.get(`SELECT COUNT(*) AS n FROM security_alerts WHERE resolved_at IS NULL`) as { n?: number } | undefined)?.n ?? 0);
  return { accounts, offRadarCents, walletOutCents, share: walletOutCents ? offRadarCents / walletOutCents : 0, alerts };
}

/**
 * Nightly reconciliation: unsettled bank mirrors and rapid send-back after a new inflow.
 * Balance breaks are recorded at ingest time.
 */
export function reconcileSecurity(db: DbAdapter, at = now()): { alerts: number } {
  let alerts = 0;
  const unsettled = db.all(
    `SELECT t.id, t.ref, t.occurred_at AS occurredAt, t.provider
       FROM transactions t WHERE t.role = 'bank_mirror'
        AND t.event_ref IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.event_ref = t.event_ref AND c.role = 'transaction')`,
  );
  for (const m of unsettled as Array<{ id: number; ref: string | null; occurredAt: number; provider: string }>) {
    insertSecurityAlert(db, {
      txId: m.id, severity: "warning", kind: "unsettled_mirror", sender: m.provider,
      title: "Bank notice not matched to a wallet movement",
      detail: "A bank transfer notice has no matching wallet receipt. Check your statement.",
      evidence: { ref: m.ref }, occurredAt: m.occurredAt,
    });
    alerts++;
  }
  const rapid = db.all(
    `SELECT o.id AS outId, o.amount AS outAmount, o.occurred_at AS outAt,
            i.id AS inId, i.amount AS inAmount, i.occurred_at AS inAt,
            c1.display_name AS outName, c2.display_name AS inName
       FROM tx_events o
       JOIN tx_events i ON i.direction = 'in' AND i.occurred_at <= o.occurred_at
        AND i.occurred_at >= o.occurred_at - 3600000 AND i.counterparty_id <> o.counterparty_id
       LEFT JOIN counterparties c1 ON c1.id = o.counterparty_id
       LEFT JOIN counterparties c2 ON c2.id = i.counterparty_id
      WHERE o.direction = 'out' AND o.kind IN ('send','withdraw')
        AND i.amount >= o.amount * 0.8
        AND o.amount >= 100000
      ORDER BY o.occurred_at DESC LIMIT 20`,
  );
  for (const r of rapid as Array<Record<string, unknown>>) {
    insertSecurityAlert(db, {
      txId: Number(r.outId), severity: "warning", kind: "reversal_trap", sender: "ledger",
      title: "Rapid send-back after a new inflow",
      detail: "An incoming payment was followed within an hour by a large send to a different number. Confirm this was you.",
      evidence: { inflowId: Number(r.inId), outflowId: Number(r.outId), inflowName: r.inName, outflowName: r.outName },
      occurredAt: Number(r.outAt),
    });
    alerts++;
  }
  suppressBalanceBreaks(db);
  return { alerts };
}
