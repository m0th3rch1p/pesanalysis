import type { ParsedSms, SmsMessage, TxKind, Direction } from "../../types.js";
import { parseKes } from "../money.js";
import { parseEatDateTime } from "../time.js";

export const MPESA_PARSER_VERSION = "mpesa-0.2.3";

/**
 * Templates verified against: (a) the founder's real inbox via coverage fingerprints (1119 msgs),
 * (b) public format corpora (DenoGeek/mpesaledger sample_messages.txt, otikev gist 2018, kaluwanjala 2023).
 * Pure regex. No LLM. Whitespace normalised before matching.
 * "skip" = recognised but not a transaction (failure notices, promotions, balance summaries).
 */
const AMT = String.raw`(?:Ksh|KSH|KSh)\.?\s?(?<amt>-?[\d,]+(?:\.\d{1,2})?)`;
const AMT_PLAIN = String.raw`(?:Ksh|KSH|KSh)\.?\s?(-?[\d,]+(?:\.\d{1,2})?)`;
const DT = String.raw`on (?<d>\d{1,2}\/\d{1,2}\/\d{2,4}) at (?<t>\d{1,2}:\d{2}\s?[AaPp][Mm])`;
const REF = /^([A-Z0-9]{10})\s+confirmed\.?\s*/i;
const BAL = new RegExp(String.raw`(?:New|Your) M-?PESA balance is ${AMT_PLAIN}`, "i");
const COST = new RegExp(String.raw`Transaction cost,?\s*${AMT_PLAIN}`, "i");

/** Recognised-but-not-a-transaction bodies (checked FIRST, before kind templates). */
const SKIPPERS: RegExp[] = [
  /^(Invalid input|Failed\.|Insufficient funds in your M-?PESA|REVERSAL FAILED|Failure Reason)/i,
  /^Your M-?PESA balance is /i, // balance inquiry summary
  /^Dear customer[, ]/i, // generic telco notices sent via MPESA sender are non-transactional
  /^Your M-?PESA card has been activated/i,
  /^Your SIM card has been activated/i,
  /^You have cancelled the transaction of/i,
  /^Your account balance was:/i, // Ziidi/M-Shwari style summaries
];

interface Tpl {
  name: string;
  re: RegExp;
  kind: TxKind;
  direction: Direction;
}

const TEMPLATES: Tpl[] = [
  { name: "mpesa.receive", kind: "receive", direction: "in",
    re: new RegExp(String.raw`You have received ${AMT} from (?<name>.+?)(?: (?<id>[\d*+]{7,15}))? ${DT}`, "i") },
  { name: "mpesa.pochi.receive", kind: "receive", direction: "in",
    re: new RegExp(String.raw`You have received ${AMT} from (?<name>.+?)(?: (?<id>[\d*+]{7,15}))? via Pochi la Biashara ${DT}`, "i") },
  { name: "mpesa.pochi.send", kind: "send", direction: "out",
    re: new RegExp(String.raw`${AMT} sent to (?<name>.+?)(?: (?<id>[\d*+]{7,15}))? via Pochi la Biashara ${DT}`, "i") },
  // paybill BEFORE generic send/till: "KshX paid to PAYBILL 555555 Account ELECTRICITY BILL"
  { name: "mpesa.paybill.pay", kind: "paybill", direction: "out",
    re: new RegExp(String.raw`You paid ${AMT} to PAYBILL (?<id>\d{5,12}) Account (?<acct>.+?) ${DT}`, "i") },
  { name: "mpesa.paybill.sent", kind: "paybill", direction: "out",
    re: new RegExp(String.raw`${AMT} sent to (?<name>.+?) for account (?<acct>\S+(?: \S+?)?) ${DT}`, "i") },
  // common paybill form: "KshX paid to NAME. Account ACCOUNT on d/m/y at t" (must beat generic till)
  { name: "mpesa.paybill.account", kind: "paybill", direction: "out",
    re: new RegExp(String.raw`${AMT} paid to (?<name>.+?)\. Account (?<acct>.+?) ${DT}`, "i") },
  { name: "mpesa.send", kind: "send", direction: "out",
    re: new RegExp(String.raw`${AMT} sent to (?<name>.+?)(?: (?<id>[\d*+]{7,15}))? ${DT}`, "i") },
  { name: "mpesa.send.noid", kind: "send", direction: "out",
    re: new RegExp(String.raw`You sent ${AMT} to (?<name>.+?) ${DT}`, "i") },
  // buy goods BEFORE generic till: "KshX paid to BUY GOODS 987654 SUPERMARKET"
  { name: "mpesa.till.numbered", kind: "till", direction: "out",
    re: new RegExp(String.raw`(?:You paid )?${AMT} paid to (?:BUY GOODS|Buy Goods) (?<id>\d{5,12})(?: (?<name>.+?))? ${DT}`, "i") },
  { name: "mpesa.till", kind: "till", direction: "out",
    re: new RegExp(String.raw`${AMT} paid to (?<name>.+?)\.? ${DT}`, "i") },
  // withdrawals: "You have withdrawn KshX from Agent 123456" | "from ATM 789012" | memory-variant "Withdraw KshX from NAME ..."
  { name: "mpesa.withdraw.agent", kind: "withdraw", direction: "out",
    re: new RegExp(String.raw`You have withdrawn ${AMT} from (?<name>Agent|ATM) (?<id>\d+) ${DT}`, "i") },
  // glued variant: "...on 24/10/26 at 9:15 PMWithdraw Ksh1,000.00 from 123456 - AGENT NAME New M-PESA balance is..." (spacing varies)
  { name: "mpesa.withdraw.glued", kind: "withdraw", direction: "out",
    re: new RegExp(String.raw`^${DT}\s*Withdraw ${AMT} from (?<id>\d+) - (?<name>.+?) New M-?PESA balance is`, "i") },
  { name: "mpesa.withdraw", kind: "withdraw", direction: "out",
    re: new RegExp(String.raw`${DT} Withdraw ${AMT} from (?<name>.+?) (?<id>\d+) New M-?PESA`, "i") },
  { name: "mpesa.deposit", kind: "deposit", direction: "in",
    re: new RegExp(String.raw`${DT} Give ${AMT} cash to (?<name>.+?) (?<id>\d+) New M-?PESA`, "i") },
  { name: "mpesa.deposit2", kind: "deposit", direction: "in",
    re: new RegExp(String.raw`${DT} Give ${AMT} cash to (?<name>.+?) New M-?PESA`, "i") },
  { name: "mpesa.airtime", kind: "airtime", direction: "out",
    re: new RegExp(String.raw`You bought ${AMT} of airtime (?:for (?<name>.+?) )?${DT}`, "i") },
  // reversal: "Transaction reversed. KshX has been credited to your account on d/m/y at t."
  { name: "mpesa.reversal", kind: "reversal", direction: "in",
    re: new RegExp(String.raw`Transaction reversed\.? ${AMT} has been credited to your account ${DT}`, "i") },
  // fee deduction: "A fee of Ksh27.00 has been deducted from your account on ..."
  { name: "mpesa.fee", kind: "fee", direction: "out",
    re: new RegExp(String.raw`A fee of ${AMT} has been deducted from your account ${DT}`, "i") },
  // Fuliza: full disbursement, e.g. "Fuliza M-PESA amount is Ksh X"
  { name: "mpesa.fuliza_draw", kind: "loan_draw", direction: "neutral",
    re: new RegExp(String.raw`Fuliza M-?PESA amount is ${AMT}`, "i") },
  // Fuliza repay (outstanding fully / partially paid). Amount = the AMT used to pay.
  { name: "mpesa.fuliza_repay_full", kind: "loan_repay", direction: "out",
    re: new RegExp(String.raw`${AMT} from your M-?PESA has been used to (?:fully|partially) pay your outstanding Fuliza`, "i") },
  { name: "mpesa.fuliza_repay", kind: "loan_repay", direction: "out",
    re: new RegExp(String.raw`${AMT} from your M-?PESA has been used to (?:partially )?pay`, "i") },
];

/** Fuliza messages never name the counterparty; bind them to the Fuliza entity for entity resolution. */
const FULIZA_TEMPLATES = new Set(["mpesa.fuliza_draw", "mpesa.fuliza_repay_full", "mpesa.fuliza_repay"]);

const MONEY = String.raw`(?:Ksh|KSH|KSh)\.?\s?([\d,]+(?:\.\d{1,2})?)`;

/** Read the credit-line facts Safaricom states in Fuliza draw/repay notices. */
type FulizaFacts = { creditLimitCents?: number; availableCreditCents?: number; outstandingCents?: number; dueAt?: number; fee?: number };

function fulizaFacts(body: string): FulizaFacts {
  const out: FulizaFacts = {};
  // One-off 1% access fee stated on draws ("Access Fee charged Ksh 5.00"). Goes into `fee` so fee flows count it.
  const access = new RegExp(String.raw`Access Fee(?: charged)?(?: is|:)? ${MONEY}`, "i").exec(body);
  if (access) out.fee = parseKes(access[1]!);
  const limit = new RegExp(String.raw`Fuliza M-?PESA limit(?: is|:)? ${MONEY}`, "i").exec(body);
  if (limit) out.creditLimitCents = parseKes(limit[1]!);
  const available = new RegExp(String.raw`available Fuliza M-?PESA limit is ${MONEY}`, "i").exec(body);
  if (available) out.availableCreditCents = parseKes(available[1]!);
  const outstanding = new RegExp(String.raw`(?:Total Fuliza M-?PESA outstanding amount is|outstanding Fuliza M-?PESA(?: amount)? is) ${MONEY}`, "i").exec(body);
  if (outstanding) out.outstandingCents = parseKes(outstanding[1]!);
  const due = /due on (\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(body);
  if (due) {
    try { out.dueAt = parseEatDateTime(due[1]!, "12:00 AM"); } catch { /* ignore malformed date */ }
  }
  return out;
}

export function parseMpesa(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  const refMatch = REF.exec(body);
  const rest = refMatch ? body.slice(refMatch[0].length) : body;
  // skip on either the raw body or the ref-stripped form
  if (SKIPPERS.some((re) => re.test(body) || re.test(rest))) return "skip";

  for (const t of TEMPLATES) {
    const m = t.re.exec(rest);
    if (!m) continue;
    const g = m.groups ?? {};
    const bal = BAL.exec(rest);
    const cost = COST.exec(rest);
    const occurredAt = g.d && g.t ? parseEatDateTime(g.d, g.t) : msg.receivedAt;
    return {
      provider: "mpesa",
      ref: refMatch ? refMatch[1]!.toUpperCase() : null,
      kind: t.kind,
      direction: t.direction,
      amount: parseKes(g.amt!),
      fee: cost ? parseKes(cost[1]!) : null,
      balanceAfter: bal ? parseKes(bal[1]!) : null,
      counterpartyName: g.name?.trim() || (FULIZA_TEMPLATES.has(t.name) ? "Fuliza M-PESA" : null),
      counterpartyId: g.id?.trim() || null,
      account: g.acct?.trim() || null,
      occurredAt,
      template: t.name,
      parserVersion: MPESA_PARSER_VERSION,
      ...(FULIZA_TEMPLATES.has(t.name) ? fulizaFacts(rest) : {}),
    };
  }
  return null;
}
