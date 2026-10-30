/**
 * Message -> event linking. A provider receipt is not an event: Safaricom reuses
 * the M-Pesa receipt on the Fuliza draw notice, Equity repeats the M-Pesa receipt
 * on its mirror, and Okoa sends the same draw twice (Safaricom + Okoa Jahazi).
 *
 * Every message still gets its own row (unique sms_id). `event_ref` groups rows
 * that describe ONE movement; `role` says which row is canonical. The ledger and
 * stats read the `tx_events` view, so notices never double-count.
 */
import type { ParsedSms } from "../types.js";

export type TxRole = "transaction" | "funding_notice" | "bank_mirror" | "duplicate_notice" | "airtime_credit" | "airtime_notice";
export type BaseRole = "transaction" | "funding_notice" | "bank" | "telco" | "airtime";

export function baseRoleFor(p: ParsedSms): BaseRole {
  if (p.template === "mpesa.fuliza_draw") return "funding_notice";
  if (p.template.startsWith("equity.")) return "bank";
  if (/okoa|airtime_loan|kopa_repay/.test(p.template)) return "airtime";
  if (p.kind === "airtime" && p.direction === "in") return "airtime";
  return "transaction";
}

const HALF_HOUR = 30 * 60_000;

export function eventRefFor(p: ParsedSms, body: string): string {
  // Equity -> M-Pesa transfers: the bank SMS names the M-Pesa receipt.
  if (p.template === "equity.sent_to_wallet") {
    const ref = /MPESA receipt number is\s+([A-Z0-9]+)/i.exec(body)?.[1];
    if (ref) return `ref:${ref}`;
  }
  if (p.ref) return `ref:${p.ref}`;

  // Okoa draw: both copies carry the same outstanding-debt marker. The due-date
  // format differs (19-10-2026 vs 2026-10-19), so use only the amount + total.
  if (/okoa_draw/.test(p.template)) {
    const total = /TOTAL UNPAID OKOA JAHAZI is\s*([\d.,]+)/i.exec(body)?.[1]?.replace(/,/g, "");
    if (total) return `telco:okoa_draw:${p.amount}:${total}`;
  }
  if (/okoa_repay|airtime_loan/.test(p.template)) {
    const kind = /okoa_repay/.test(p.template) ? "okoa_repay" : "airtime_loan";
    return `telco:${kind}:${p.amount}:${Math.floor(p.occurredAt / HALF_HOUR)}`;
  }

  return `raw:${p.provider}:${p.occurredAt}:${p.amount}:${p.kind}`;
}
