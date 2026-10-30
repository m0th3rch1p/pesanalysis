import type { Cents, ParsedSms, SmsContext, SmsMessage } from "./types.js";
import { modelCandidate } from "./ai/candidate.js";
import { formatKes } from "./sms/money.js";
import { parseSms } from "./sms/parse.js";
import { counterpartyKey } from "./entities/normalize.js";
import { balanceEffect } from "./ledger/balance-chain.js";
import { suggestLabel, notificationKind, type KnnItem, type Suggestion } from "./labels/suggest.js";
import { baseRoleFor, eventRefFor, type TxRole } from "./events/link.js";
import type { LedgerTx } from "./detectors/types.js";
import { inferScope, type TxScope } from "./labels/scope.js";
import { detectSmsSpoof, detectSocialScam } from "./sms/universal-lexer.js";
import { isOffRadarDestination } from "./sms/rails-directory.js";
import type { SecurityAlertInput } from "./ledger/accounts.js";
import { BALANCE_BREAK_COPY } from "./security/breaks.js";

/**
 * THE single ingestion entry point. Every path — SMS receiver (Kotlin->JS), inbox backfill,
 * and the debug "replay synthetic feed" (RISKS #16: real phones can't receive adb-injected SMS)
 * — calls ingestSms(). Pure orchestration over an injected Store; no LLM in this path (DECISIONS D3).
 */
export interface Store {
  insertSms(s: SmsMessage): number;
  /** Exact SMS already captured (same sender/time/body hash). Backfills must not replay it. */
  hasSms?(s: SmsMessage): boolean;
  insertTx(tx: { smsId: number; parsed: ParsedSms; counterpartyId: number | null; chainStatus: string; chainDiscrepancy: Cents; status: string; role: TxRole; eventRef: string; scope?: TxScope; suggestedLabelId: number | null; suggestedSource?: string | null; suggestedConfidence?: number | null }): number;
  /** canonical-or-first row for an event_ref (transaction preferred over notices) */
  findTxByEventRef(eventRef: string): { id: number; provider: string; role: string } | null;
  setTxRole(txId: number, role: TxRole): void;
  /** returns row id; creates with firstSeen when absent */
  upsertCounterparty(key: string, rawName: string | null): { id: number; isNew: boolean };
  findLabelIdByName(name: string): number | null;
  /** latest tx for this provider with a balance, strictly before `before` (time-ordered chain) */
  lastBalanceTx(provider: string, before: number): { occurredAt: number; balanceAfter: Cents } | null;
  /**
   * Chain state for live single-message ingest: the anchor (last stated wallet balance for this
   * provider before `before`) plus the SUM of effects of balance-less txs since that anchor
   * (Fuliza draws credit the wallet). SQL sketch:
   *   anchor: SELECT occurred_at, balance_after FROM transactions WHERE provider=? AND balance_after IS NOT NULL AND occurred_at<? ORDER BY occurred_at DESC LIMIT 1
   *   pending: SUM over txs after the anchor with balance_after IS NULL of effect(kind, amount, fee)
   *            (effect by CASE: send/paybill/till/withdraw/airtime/bundle -> -(amount+fee); receive/deposit/reversal -> amount-fee; mpesa loan_draw -> +amount; else 0)
   */
  chainAnchor(provider: string, before: number): { anchor: Cents | null; pending: Cents };
  confirmedHistoryForKnn(limit: number): KnnItem[];
  /** v4: link the transaction to auto-discovered source/target accounts. */
  linkTxAccounts?(txId: number, sender: string, parsed: ParsedSms): void;
  /** v4: write a security/reconciliation alert. */
  recordSecurityAlert?(alert: SecurityAlertInput): void;
  /** v4: persist passive context captured with the SMS. */
  saveContext?(txId: number, context: SmsContext): void;
  /** v6: put an airtime credit/notice outside cash-flow and link it to its purchase. */
  linkAirtimeCredit?(txId: number, creditCents: number, occurredAt: number): boolean;
  /** Sticky category learned from this exact counterparty's confirmed history. */
  counterpartyDefaultLabel?(counterpartyId: number): { label: string; confidence: number } | null;
  /** v10: persist a financial-looking message the deterministic parsers could not read, for on-device model help. */
  recordUnparsed?(smsId: number, info: { sender: string; receivedAt: number; reason: string }): void;
}

export interface IngestActions {
  /** notification kind per DECISIONS D8 */
  notify: "ask" | "auto" | "silent";
  suggestion: Suggestion | null;
  /** human title for the notification: "Ksh500.00 sent to JANE DOE" etc. */
  title: string;
  amount: Cents;
  kind: string;
  provider: string;
  occurredAt: number;
  txId: number;
  chainStatus: "ok" | "break" | "first" | "unknown";
  chainDiscrepancy: Cents;
  duplicate: boolean;
}

export interface IngestResult { stored: boolean; actions: IngestActions | null; skipReason?: string; security?: { kind: "msisdn_spoof" } }

export function ingestSms(msg: SmsMessage, store: Store): IngestResult {
  // Inbox catch-up deliberately re-reads a small overlap. Never replay a captured SMS.
  if (store.hasSms?.(msg)) return { stored: false, actions: null, skipReason: "duplicate_sms" };

  // Anti-scam gate BEFORE parsing: a personal number sending a fake wallet receipt is
  // persisted for audit, alerted, and never allowed into the ledger.
  const spoof = detectSmsSpoof(msg);
  if (spoof) {
    const smsId = store.insertSms(msg);
    store.recordSecurityAlert?.({
      smsId, severity: spoof.severity, kind: spoof.kind, sender: spoof.sender,
      title: spoof.title, detail: spoof.detail, evidence: spoof.evidence, occurredAt: msg.receivedAt,
    });
    return { stored: false, actions: null, skipReason: "phone_number_sender", security: { kind: "msisdn_spoof" } };
  }

  // Social scams are alerted whatever the parse result; a real ledger row is never silently dropped.
  const scam = detectSocialScam(msg);
  if (scam) {
    try {
      const smsId = store.insertSms(msg);
      store.recordSecurityAlert?.({ smsId, severity: scam.severity, kind: scam.kind, sender: scam.sender, title: scam.title, detail: scam.detail, evidence: scam.evidence, occurredAt: msg.receivedAt });
    } catch { /* alerting must never block capture */ }
  }

  const o = parseSms(msg);
  if (!o.ok) {
    // F2: keep financial-looking unread messages so the on-device model can propose fields later.
    const cand = modelCandidate({ sender: msg.sender, body: msg.body, receivedAt: msg.receivedAt, skipReason: o.reason });
    if (cand.candidate) {
      try {
        const smsId = store.insertSms(msg);
        store.recordUnparsed?.(smsId, { sender: msg.sender, receivedAt: msg.receivedAt, reason: o.reason });
      } catch { /* capture must never fail because the model queue could not be written */ }
    }
    return { stored: false, actions: null, skipReason: o.reason };
  }

  // store raw first (persist-first capture, DECISIONS D2)
  const smsId = store.insertSms(msg);
  const p = o.parsed;

  // dedupe on provider ref (natural key); refless messages rely on sms_raw UNIQUE
  const cpKey = counterpartyKey(p.counterpartyId, p.counterpartyName);
  const cp = cpKey ? store.upsertCounterparty(cpKey, p.counterpartyName) : null;

  // balance chain: anchor + pending effects (Fuliza draws between stated balances are real money)
  const cs = store.chainAnchor(p.provider, p.occurredAt);
  let chainStatus: "ok" | "break" | "first" | "unknown" = "unknown";
  let discrepancy: Cents = 0;
  if (p.balanceAfter == null) {
    chainStatus = "unknown";
  } else if (cs.anchor == null) {
    chainStatus = "first";
  } else {
    const eff = balanceEffect(p);
    if (eff == null) chainStatus = "unknown";
    else {
      const expected = cs.anchor + cs.pending + eff;
      discrepancy = expected - p.balanceAfter;
      chainStatus = discrepancy === 0 ? "ok" : "break";
    }
  }

  const defaultLabel = cp ? store.counterpartyDefaultLabel?.(cp.id) ?? null : null;
  const baseSuggestion = suggestLabel(p, { history: store.confirmedHistoryForKnn(200), counterpartyDefault: defaultLabel });
  const offRadar = isOffRadarDestination(p) && store.findLabelIdByName("Off-radar transfer") != null;
  const suggestion: Suggestion | null = offRadar
    ? { label: "Off-radar transfer", confidence: 0.92, source: "rule", alternates: baseSuggestion ? [{ label: baseSuggestion.label, confidence: baseSuggestion.confidence, source: baseSuggestion.source }] : [] }
    : baseSuggestion;
  const labelId = suggestion ? store.findLabelIdByName(suggestion.label) : null;
  const isAirtimeEvidence = (p.kind === "airtime" && p.direction === "in") || baseRoleFor(p) === "airtime";
  const status = isAirtimeEvidence ? "auto" : notificationKind(suggestion, p.kind) === "auto" ? "auto" : "pending";

  // One row per SMS; role/event_ref decide which row is the real movement.
  const eventRef = eventRefFor(p, msg.body);
  const base = baseRoleFor(p);
  const existing = store.findTxByEventRef(eventRef);
  let role: TxRole = "transaction";
  if (base === "airtime") {
    role = p.kind === "airtime" && p.direction === "in" ? "airtime_credit" : "airtime_notice";
  } else if (base === "funding_notice") {
    role = "funding_notice";
  } else if (base === "bank") {
    if (existing?.provider === "mpesa") role = "bank_mirror";
    else if (existing?.provider === p.provider) role = "duplicate_notice";
    else if (existing) role = "bank_mirror";
  } else if (base === "telco") {
    if (existing) role = "duplicate_notice";
  } else {
    // M-Pesa (or another canonical provider) wins over a bank mirror that
    // arrived first; a second canonical copy of the same receipt is a duplicate.
    if (existing && existing.provider !== "mpesa" && existing.role === "transaction") {
      store.setTxRole(existing.id, "bank_mirror");
    } else if (existing && existing.role === "transaction") {
      role = "duplicate_notice";
    }
  }

  const txId = store.insertTx({
    smsId, parsed: p, counterpartyId: cp?.id ?? null,
    chainStatus, chainDiscrepancy: discrepancy, status,
    role, eventRef,
    scope: inferScope({ label: suggestion?.label ?? null, kind: p.kind }),
    suggestedLabelId: labelId,
    suggestedSource: suggestion?.source ?? null,
    suggestedConfidence: suggestion?.confidence ?? null,
  });

  store.linkTxAccounts?.(txId, msg.sender, p);
  if (p.kind === "airtime" && p.direction === "in") {
    store.linkAirtimeCredit?.(txId, p.amount, p.occurredAt);
  }
  if (msg.context) store.saveContext?.(txId, msg.context);
  if (chainStatus === "break") {
    store.recordSecurityAlert?.({
      smsId, txId, severity: "warning", kind: "balance_break", sender: msg.sender,
      title: "Balance doesn't add up after this payment",
      detail: BALANCE_BREAK_COPY(p.provider, discrepancy),
      evidence: { discrepancy, provider: p.provider, ref: p.ref }, occurredAt: p.occurredAt,
    });
  }

  return {
    stored: true,
    skipReason: undefined,
    actions: {
      notify: isAirtimeEvidence ? "silent" : notificationKind(suggestion, p.kind),
      suggestion,
      title: actionTitle(p),
      amount: p.amount,
      kind: p.kind,
      provider: p.provider,
      occurredAt: p.occurredAt,
      txId,
      chainStatus,
      chainDiscrepancy: discrepancy,
      duplicate: false,
    },
  };
}

function actionTitle(p: ParsedSms): string {
  const cp = p.counterpartyName ?? p.counterpartyId ?? "";
  const kes = formatKes(p.amount);
  switch (p.kind) {
    case "receive": return `${kes} received from ${cp}`;
    case "send": return `${kes} sent to ${cp}`;
    case "paybill": return `${kes} paid to ${cp}${p.account ? ` (${p.account})` : ""}`;
    case "till": return `${kes} paid to ${cp}`;
    case "withdraw": return `${kes} withdrawn from ${cp}`;
    case "deposit": return `${kes} deposited via ${cp}`;
    case "airtime": return `${kes} airtime`;
    case "bundle": return `${kes} bundle`;
    case "loan_draw": return `${kes} loan: ${cp}`;
    case "loan_repay": return `${kes} repaid to ${cp}`;
    case "reversal": return `${kes} reversal credited`;
    case "fee": return `${kes} fee`;
    default: return `${kes} transaction${cp ? ` · ${cp}` : ""}`;
  }
}

/** Ledger rows for detectors, straight from a Store-shaped source (kept pure for tests). */
export function toLedgerTxs(rows: Array<{
  id: number; occurredAt: number; direction: string; amount: Cents; cpKey?: string | null;
  cpName?: string | null; kind?: string; fee?: Cents | null; label?: string | null;
  scope?: string; role?: string | null; provider?: string; balanceAfterCents?: number | null;
  lat?: number | null; lng?: number | null; batteryPct?: number | null; isCharging?: boolean | number | null;
  stepDelta?: number | null; circadianPhase?: string | null;
}>): LedgerTx[] {
  return rows.map((r) => ({
    id: String(r.id), occurredAt: r.occurredAt, direction: r.direction as LedgerTx["direction"],
    amount: r.amount, counterpartyKey: r.cpKey ?? null, counterpartyName: r.cpName ?? null,
    kind: r.kind as LedgerTx["kind"], fee: r.fee ?? null, label: r.label ?? null,
    scope: (r.scope as LedgerTx["scope"]) ?? "unknown", role: r.role ?? null, provider: r.provider,
    balanceAfterCents: r.balanceAfterCents ?? null,
    lat: r.lat ?? null, lng: r.lng ?? null,
    batteryPct: r.batteryPct ?? null,
    isCharging: r.isCharging == null ? null : Boolean(r.isCharging),
    stepDelta: r.stepDelta ?? null, circadianPhase: r.circadianPhase ?? null,
  }));
}
