import type { ParsedSms, SmsMessage, TxKind, Direction } from "../../types.js";
import { parseKes } from "../money.js";
import { parseEatDateTime } from "../time.js";

export const EQUITY_PARSER_VERSION = "equity-0.1.1";

/**
 * From real-inbox fingerprints (Equity Bank / EQUITY BANK senders, 25 Oct 2026).
 * Variants seen:
 *  1. "Confirmed. Payment of Ksh1,300.00 to ACME Till No. 123456 has been received. Ref. EQ123456789 on 24-10-26 at 18:04. Thank you."   (credit into Equity till/account)
 *  2. "Dear Bret, Your transaction of Ksh500.00 has successfully been deposited to Equity Account in favor of ACME Ref. Number EQ123456789 on 24-10-26 at 18:04. Thank you."
 *  3. "ACME has sent KShs. 500.00 to your M-PESA. The M-PESA receipt number is X and transaction reference is EQA123C456D789EAC."
 *    -> money INTO the wallet via Equity; ref = EQA... (24 chars); wallet receipt = REF.
 */
const AMT = String.raw`(?:Kshs?\.?|KSH|KShs|KES\.?)\s?(?<amt>-?[\d,]+(?:\.\d{1,2})?)`;
const AMT_PLAIN = String.raw`(?:Kshs?\.?|KSH|KShs|KES\.?)\s?([\d,]+(?:\.\d{1,2})?)`;
const DT = String.raw`on (?<d>\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}) at (?<t>\d{1,2}:\d{2}(?::\d{2})?)`;

const SKIPPERS: RegExp[] = [/^To qualify for a digital loan/i, /branches will be closed/i, /never share your account/i];

interface Tpl { name: string; re: RegExp; kind: TxKind; direction: Direction }
const TEMPLATES: Tpl[] = [
  { name: "equity.till_received", kind: "bank_credit", direction: "in",
    re: new RegExp(String.raw`Confirmed\. Payment of ${AMT} to (?<name>.+?) Till No\.? (?<id>\d+) has been received\. Ref\.? (?<ref>[A-Z0-9]+) ${DT}`, "i") },
  { name: "equity.deposited", kind: "bank_credit", direction: "in",
    re: new RegExp(String.raw`Your transaction of ${AMT} has successfully been deposited to Equity Account in favor of (?<name>.+?) ?(?:Ref\.? Number (?<ref>[A-Z0-9]+))? ${DT}`, "i") },
  { name: "equity.sent_to_wallet", kind: "bank_credit", direction: "in",
    re: new RegExp(String.raw`(?<name>.+?) has sent ${AMT} to your M-?PESA\. (?:The M-?PESA receipt number is (?<wallet_ref>[A-Z0-9]+) and )?transaction reference is (?<ref>[A-Z0-9]{10,24})`, "i") },
];

export function parseEquity(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (SKIPPERS.some((re) => re.test(body))) return "skip";

  for (const t of TEMPLATES) {
    const m = t.re.exec(body);
    if (!m) continue;
    const g = m.groups ?? {};
    const d = g.d ? g.d.replace(/-/g, "/") : undefined;
    return {
      provider: "bank",
      ref: g.ref ? g.ref.toUpperCase() : null,
      kind: t.kind,
      direction: t.direction,
      amount: parseKes(g.amt!),
      fee: null,
      balanceAfter: null,
      counterpartyName: t.name === "equity.deposited" ? null : g.name?.trim() || null,
      counterpartyId: g.id?.trim() || null,
      account: g.acct?.trim() || null,
      occurredAt: d && g.t ? parseEatDateTime(d, g.t) : msg.receivedAt,
      template: t.name,
      parserVersion: EQUITY_PARSER_VERSION,
    };
  }
  return null;
}
