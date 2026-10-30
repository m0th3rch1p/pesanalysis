import type { Direction, ParsedSms, SmsMessage, TxKind } from "../../types.js";
import { parseKes } from "../money.js";
import { parseEatDateTime } from "../time.js";

export const MPESA_SAVINGS_PARSER_VERSION = "mpesa-savings-0.1.0";

/**
 * M-Shwari and KCB M-PESA movements. Formats taken from the founder's real inbox (one sample each);
 * wording quirks preserved: "transfered" (single r) on KCB, no space after "Confirmed.", a stray
 * space before ".M-PESA balance" on M-Shwari.
 *
 * Each movement produces TWO SMS: the MPESA-sender confirmation (has receipt ref, date, M-PESA
 * balance) and a mirror from the "KCB M-PESA" sender (no ref, no date). Only the MPESA-sender
 * message is parsed; the mirror is "skip" so one movement is never counted twice.
 * M-Shwari/KCB balances are NOT the wallet balance: they go to savingsBalanceAfter, never balanceAfter.
 */
const AMT = String.raw`(?:Ksh|KSH|KSh)\.?\s?(?<amt>[\d,]+(?:\.\d{1,2})?)`;
const DT = String.raw`on (?<d>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<t>\d{1,2}:\d{2}\s?[AaPp][Mm])`;
const REF = /^([A-Z0-9]{10})\s+confirmed\.?\s*/i;
const MONEY = String.raw`(?:Ksh|KSH|KSh)\.?\s?([\d,]+(?:\.\d{1,2})?)`;
const WALLET_BAL = new RegExp(String.raw`(?<!KCB )(?:New )?M-?PESA balance is ${MONEY}`, "i");
const SAVINGS_BAL = new RegExp(String.raw`(?:M-Shwari|KCB M-PESA)\s+(?:saving\s+)?(?:account\s+)?balance is ${MONEY}`, "i");
const COST = new RegExp(String.raw`Transaction cost,?\s*${MONEY}`, "i");

interface Tpl { name: string; re: RegExp; kind: TxKind; direction: Direction; party: string }

const TEMPLATES: Tpl[] = [
  { name: "mpesa.mshwari.deposit", kind: "send", direction: "out", party: "M-Shwari",
    re: new RegExp(String.raw`^${AMT} transfer+ed to M-Shwari account ${DT}`, "i") },
  { name: "mpesa.mshwari.withdraw", kind: "receive", direction: "in", party: "M-Shwari",
    re: new RegExp(String.raw`^${AMT} transfer+ed from M-Shwari account ${DT}`, "i") },
  { name: "mpesa.kcb.deposit", kind: "send", direction: "out", party: "KCB M-PESA",
    re: new RegExp(String.raw`^${AMT} transfer+ed to KCB M-PESA account ${DT}`, "i") },
  { name: "mpesa.kcb.withdraw", kind: "receive", direction: "in", party: "KCB M-PESA",
    re: new RegExp(String.raw`^You have transfer+ed ${AMT} from your KCB M-PESA account ${DT}`, "i") },
];

/** Mirror notices from the "KCB M-PESA" sender and non-transaction notices. */
const KCB_SENDER_SKIP: RegExp[] = [
  /^Confirmed\.? (?:KES|Ksh)\.? ?[\d,.]+ transfer+ed to KCB M-PESA account\./i,
  /^Confirmed\.? You have transfer+ed (?:KES|Ksh)\.? ?[\d,.]+ from your M-PESA savings Account to M-PESA\./i,
  /^Dear customer, we are unable to process your loan request/i,
];
const MPESA_SENDER_SKIP: RegExp[] = [
  /^Your KCB M-PESA loan request will be processed shortly/i,
];
const MSHWARI_SENDER_SKIP: RegExp[] = [/^Dear Customer, /i];

/** Body parser for MPESA-sender messages. Returns null when the message is not an M-Shwari/KCB one. */
export function parseMpesaSavings(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  const refMatch = REF.exec(body);
  const rest = refMatch ? body.slice(refMatch[0].length) : body;
  if (MPESA_SENDER_SKIP.some((re) => re.test(rest))) return "skip";
  for (const t of TEMPLATES) {
    const m = t.re.exec(rest);
    if (!m) continue;
    const g = m.groups!;
    const wallet = WALLET_BAL.exec(rest);
    const savings = SAVINGS_BAL.exec(rest);
    const cost = COST.exec(rest);
    return {
      provider: "mpesa",
      ref: refMatch ? refMatch[1]!.toUpperCase() : null,
      kind: t.kind,
      direction: t.direction,
      amount: parseKes(g.amt!),
      fee: cost ? parseKes(cost[1]!) : null,
      balanceAfter: wallet ? parseKes(wallet[1]!) : null,
      counterpartyName: t.party,
      counterpartyId: null,
      account: null,
      occurredAt: parseEatDateTime(g.d!, g.t!),
      savingsBalanceAfter: savings ? parseKes(savings[1]!) : null,
      template: t.name,
      parserVersion: MPESA_SAVINGS_PARSER_VERSION,
    };
  }
  return null;
}

/** Sender-specific entry for "KCB M-PESA" / "MShwari" sender IDs. Everything recognised is non-transactional mirror/promo. */
export function parseSavingsSender(sender: string, msg: SmsMessage): "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  const list = /^kcb/i.test(sender.trim()) ? KCB_SENDER_SKIP : MSHWARI_SENDER_SKIP;
  return list.some((re) => re.test(body)) ? "skip" : null;
}

export function isSavingsSender(sender: string): boolean {
  return /^(kcb m-?pesa|m-?shwari)$/i.test(sender.trim());
}
