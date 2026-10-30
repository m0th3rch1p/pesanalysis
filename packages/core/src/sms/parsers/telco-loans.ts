import type { ParsedSms, SmsMessage, TxKind, Direction } from "../../types.js";
import { parseKes } from "../money.js";
import { parseEatDateTime } from "../time.js";

export const TELCO_PARSER_VERSION = "telco-0.1.1";

/**
 * Telco micro-credit (Okoa Jahazi / Safaricom Okoa minutes / Airtel handled in its own parser).
 * Real fingerprints (Safaricom, Okoa Jahazi senders; 25 Oct 2026):
 *  draw:   "You have received Sh20.00. The fee is Sh2.50. Your debt of Sh22.50 should be paid by 25-10-26."
 *  draw2:  "Your Okoa Chap Chap request was successful. Your call costs through Okoa was 20.00 to be paid by 26-10-26."
 *  repay:  "20.00 KSH has been deducted to repay your Okoa Jahazi."
 * Everything else (overdue notices, lockouts, limits, adverts) -> skip.
 */
const NUM = String.raw`(?<amt>[\d,]+(?:\.\d{1,2})?)`;
const SH = String.raw`(?:Shs?\.?|KSH|Ksh)\s?`;

const SKIPPERS: RegExp[] = [
  /^(You will not be able|Dear Customer|You can (?:now successfully )?borrow|Dial \*\d{3}#|Airtime Bal:|Dear customer|Last Call Duration|Changamkia|Send money with confidence|Pay with confidence|Dear customer, you do not)/i,
  /overdue Okoa debt/i,
  /Okoa Jahazi for the next/i,
  /Thank [Yy]ou [Ff]or (?:Purchasing|Choosing)/i,
  /bundle with No expiry/i,
  /Bonga Points/i,
  /Your Free Airtime/i,
  /^Unpaid Okoa balance/i,
  /^Stay connected with our love/i,
  /^You have redeemed/i,
  /^You have received \d+ (?:Calls|Minutes|min)/i,
  /valid \d+ ?(?:hrs|hr|Day|days)\b/i, // rewards counted in units, not KES
  /^Recharge of /i, // Safaricom-side airtime recharge notice; wallet side already captured via MPESA
  /^Please enter/i,
  /^Click on/i,
  /^Make your own bundle/i,
  /^Welcome back/i,
  /Chapa Dimba/i,
  /App is now My OneApp/i,
  /^You have (?:successfully )?purchased/i,
  /Baze:/i,
  /^You have received S-/i,
  /^Did you know/i,
  /S-Hook/i,
  /^Dear \w+, Your/i,
];

/** Dates: ISO "2026-05-10" or "24-10-2026" (d-m-YYYY) or slashed "26/10/26". */
const ISO_D = String.raw`(?<d>\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})`;

interface Tpl { name: string; re: RegExp; kind: TxKind; direction: Direction }
const TEMPLATES: Tpl[] = [
  // "You have received Sh45.00. The fee is Sh5. Your debt of Sh50 should be paid by 2026-10-24."
  // Okoa-sender variant has no Sh prefix and glues ".Your": "...The fee is 10.00.Your debt of 110.00..."
  { name: "telco.okoa_draw", kind: "loan_draw", direction: "neutral",
    re: new RegExp(String.raw`You have received ${SH}?${NUM}\. The fee is ${SH}?([\d,]+(?:\.\d{1,2})?)\.?\s*Your debt of ${SH}?([\d,]+(?:\.\d{1,2})?) should be paid by ${ISO_D}`, "i") },
  { name: "telco.okoa_chapchap_draw", kind: "loan_draw", direction: "neutral",
    re: new RegExp(String.raw`Okoa Chap Chap request was successful\. Your call costs through \w+ was (?:Ksh\s?)?${NUM} to be paid by ${ISO_D}`, "i") },
  { name: "telco.okoa_repay", kind: "loan_repay", direction: "out",
    re: new RegExp(String.raw`${NUM}\s?KSH has been deducted to repay your Okoa Jahazi`, "i") },
];

export function parseTelcoLoans(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (SKIPPERS.some((re) => re.test(body))) return "skip";

  for (const t of TEMPLATES) {
    const m = t.re.exec(body);
    if (!m) continue;
    const g = m.groups ?? {};
    const feeStr = t.name === "telco.okoa_draw" ? m[2] : null;
    return {
      provider: "telco",
      ref: null,
      kind: t.kind,
      direction: t.direction,
      amount: parseKes(g.amt!),
      fee: feeStr ? parseKes(feeStr) : null,
      balanceAfter: null, // the stated figure is the AIRTIME-LOAN debt, not a wallet balance; keep it out of the chain
      counterpartyName: "Okoa",
      counterpartyId: null,
      account: null,
      occurredAt: msg.receivedAt,
      template: t.name,
      parserVersion: TELCO_PARSER_VERSION,
    };
  }
  return null;
}
