import type { ParsedSms, SmsMessage, TxKind, Direction } from "../../types.js";
import { parseKes } from "../money.js";
import { parseEatDateTime } from "../time.js";

export const AIRTEL_PARSER_VERSION = "airtel-0.2.1";

/**
 * Templates built from the founder's real-inbox fingerprints (Airtel / airtelmoney senders, 25 Oct 2026).
 * Airtel uses hyphen dates and often drops the "at" in datetimes: "on 24-10-26 18:32".
 * "skip" = recognisably not a transaction (bundle promos, app ads, voicemail notices).
 */
const AMT = String.raw`(?:Ksh|KSH|KSh)\.?\s?(?<amt>-?[\d,]+(?:\.\d{1,2})?)`;
const AMT_PLAIN = String.raw`(?:Ksh|KSH|KSh)\.?\s?(-?[\d,]+(?:\.\d{1,2})?)`;
/** "on 24-10-26 18:04" or "on 24/10/26 at 6:04 PM" */
const DT = String.raw`on (?<d>\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})(?: at)? (?<t>\d{1,2}:\d{2}(?::\d{2})?)\s*(?<ampm>[AaPp][Mm])?`;
const TID = /(?:Transaction ?ID|TID|Receipt ?No)\.?[:\s]+([A-Z0-9]{8,})/i;
const LEADING_REF = /^([A-Z0-9]{10,12})\.\s+/;
const BAL = new RegExp(String.raw`(?:new )?(?:Airtel Money )?Bal(?:ance)?(?: is|:)?\s*${AMT_PLAIN}`, "i");
const FEE = new RegExp(String.raw`Fee:? ${AMT_PLAIN}`, "i");

const SKIPPERS: RegExp[] = [
  /^(Dear customer|Your (?:balance is|data bundle)|We noticed|To easily manage|Introducing|Pay your .* loan today|Don't let your|Transaction Failed|New .* can not|New .* cannot|You've spent |You have (?:successfully )?subscribed|Just for You!|Need to check on family|Did you know|Your Airtel Money balance is|Your balance is insufficient|Kamakis has a new|Happy Customer Service Week|Don't be conned|Today we launch|We are live!|Send \d+ more |Congratulations|^You are currently using|Great news!|Wrong )/i,
  /download/i, // app ads
  /My Airtel/i,
  /voicemail/i,
  /valid \d+ ?hrs/i,
  /Dial \*\d{3}# > Bundle Offers/i,
  /set successfully/i,
  /^You have received Kopa \d/i, // data/minutes loans: no KES amount, not financial
];

interface Tpl { name: string; re: RegExp; kind: TxKind; direction: Direction }
const TEMPLATES: Tpl[] = [
  // P2P: "AB12345678. Ksh500 sent to JANE DOE 254712345678 on 24/10/26 18:04. Fee: Ksh15. Bal: Ksh1,200. Transaction ID: AB12345678"
  { name: "airtel.send.v1", kind: "send", direction: "out",
    re: new RegExp(String.raw`${AMT} sent to (?<name>.+?)(?: (?<id>\d{9,15}))? ${DT}`, "i") },
  { name: "airtel.receive.v1", kind: "receive", direction: "in",
    re: new RegExp(String.raw`(?:You have received |Received )${AMT} from (?<name>.+?)(?: (?<id>\d{9,15}))? ${DT}`, "i") },
  // "M9QA9G9CKIB. Ksh500 paid to Lipa Na SUPERMARKET via Airtel Money on 24/10/26 18:04. Fee: Ksh5. Bal: Ksh1,200. Transaction ID: AB12345678"
  { name: "airtel.till.v1", kind: "till", direction: "out",
    re: new RegExp(String.raw`${AMT} paid to Lipa Na (?<name>.+?) via Airtel Money ${DT}`, "i") },
  { name: "airtel.paybill.v1", kind: "paybill", direction: "out",
    re: new RegExp(String.raw`${AMT} paid to (?<name>.+?) account (?<acct>[\dA-Za-z]+) ${DT}`, "i") },
  { name: "airtel.bundle.v1", kind: "bundle", direction: "out",
    re: new RegExp(String.raw`(?:Bundle purchase successful of|You have successfully purchased a bundle of) ${AMT} via Airtel Networks Kenya Ltd ${DT}`, "i") },
  // airtime gift received: "You have received Ksh50.00 Airtime from 254712345678.Balance is Ksh98.50."
  { name: "airtel.airtime.receive.v1", kind: "airtime", direction: "in",
    re: new RegExp(String.raw`You have received ${AMT} Airtime from (?<id>[\d+]{9,15})\.?Balance is ${AMT_PLAIN}`, "i") },
  // airtime loan draw: "You have received airtime of Ksh9 at a service fee of Ksh1. A total of Ksh10 will be recovered on your next top up."
  { name: "airtel.airtime_loan.v1", kind: "loan_draw", direction: "neutral",
    re: new RegExp(String.raw`You have received airtime of ${AMT} at a service fee of ${AMT_PLAIN}\. A total of ${AMT_PLAIN} will be recovered`, "i") },
  // Kopa Credo repayment by airtime deduction: "Ksh52.00 has been deducted to repay your Kopa Credo of Ksh500.00 taken on 24-10-26. Your airtime loan has been fully repaid."
  { name: "airtel.kopa_repay.v1", kind: "loan_repay", direction: "out",
    re: new RegExp(String.raw`${AMT} has been deducted to repay your Kopa Credo of ${AMT_PLAIN}`, "i") },
];

export function parseAirtel(msg: SmsMessage): ParsedSms | "skip" | null {
  const body0 = msg.body.replace(/\s+/g, " ").trim();
  if (SKIPPERS.some((re) => re.test(body0))) return "skip";
  // strip optional "TID:"-style label before the leading receipt number
  const body = body0.replace(/^[A-Za-z]{1,10}:\s*/, "");

  const leadRef = LEADING_REF.exec(body);
  const rest = leadRef ? body.slice(leadRef[0].length) : body;

  for (const t of TEMPLATES) {
    const m = t.re.exec(rest);
    if (!m) continue;
    const g = m.groups ?? {};
    const bal = BAL.exec(rest);
    const fee = FEE.exec(rest);
    const tid = TID.exec(rest);
    const d = g.d ? g.d.replace(/-/g, "/") : undefined;
    let t12 = `${(g.t ?? "").trim()} ${(g.ampm ?? "").trim()}`.trim();
    const occurredAt = d && t12 ? parseEatDateTime(d, t12) : msg.receivedAt;
    return {
      provider: "airtel_money",
      ref: tid ? tid[1]!.toUpperCase() : leadRef ? leadRef[1]!.toUpperCase() : null,
      kind: t.kind,
      direction: t.direction,
      amount: parseKes(g.amt!),
      fee: fee ? parseKes(fee[1]!) : null,
      balanceAfter: bal ? parseKes(bal[1]!) : null,
      counterpartyName: t.kind === "bundle" || t.kind === "airtime" || t.kind === "loan_draw" ? null : g.name?.trim() || null,
      counterpartyId: g.id?.trim() || null,
      account: g.acct?.trim() || null,
      occurredAt,
      template: t.name,
      parserVersion: AIRTEL_PARSER_VERSION,
    };
  }
  return null;
}
