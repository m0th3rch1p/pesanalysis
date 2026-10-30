import type { Direction, ParsedSms, Provider, SmsMessage, TxKind } from "../types.js";
import { parseKes } from "./money.js";
import { parseEatDateTime } from "./time.js";
import { railForSender, railForPaybill } from "./rails-directory.js";

/** Zero-shot parser for unseen alphanumeric bank/SACCO/card messages. Deterministic. */
const CURRENCY = /(?:KES|Kshs?\.?|KShs?\.?|KSH)\s*([\d,]+(?:\.\d{1,2})?)/gi;
const DIRECTION_OUT = /\b(debited|debit|sent|paid|withdrawn|withdraw|purchase|payment of|transferred to|charged)\b/i;
const DIRECTION_IN = /\b(credited|credit|received|deposited|deposit|refunded|reversal|has sent .+ to your|in favour of)\b/i;
const FINANCIAL = /\b(confirmed|transaction|balance|debited|credited|received|sent|paid|withdrawn|deposited|purchase|transfer|fee|charges)\b/i;

export interface SpoofAlert {
  severity: "critical";
  kind: "msisdn_spoof" | "reversal_trap" | "phishing";
  sender: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

/**
 * Social-engineering patterns that are not fake receipts but still target money:
 *  - "I sent you money by mistake, please send it back" (reversal plea), typically from a person;
 *  - a link that is NOT the provider's own domain inside a bank/lender message that asks for a login,
 *    PIN, OTP or a "small fee" (phishing). Legitimate M-Pesa/Airtel receipts use saf.cx / airtel.co.ke.
 * Returns null when nothing matches; never throws.
 */
export function detectSocialScam(msg: SmsMessage): SpoofAlert | null {
  const body = msg.body;
  const sender = msg.sender.trim();
  const personal = /^(?:\+?254|0)[17]\d{8}$/.test(sender.replace(/[\s-]/g, ""));
  const plea = /\b(sent (?:you )?(?:money|\d[\d,]*)\s+(?:by mistake|wrongly)|wrong number|please (?:reverse|refund|send (?:it )?back)|return (?:the )?money|nilikosea|nimetuma kimakosa)\b/i.test(body);
  if (plea) {
    return {
      severity: "critical", kind: "reversal_trap", sender,
      title: "Possible reversal scam",
      detail: "Someone is asking you to send money back. A real reversal is done by the provider, never by sending your own money. Do not send anything; call the provider.",
      evidence: { pattern: "reversal_plea", personal },
    };
  }
  const loginAsk = /\b(pin|password|otp|one[- ]?time|verification code|activate|blocked|suspended|update your (?:account|details)|pay a small fee|processing fee|registration fee)\b/i.test(body);
  const link = /\b(?:https?:\/\/|www\.)([^\s/]+)/i.exec(body);
  if (loginAsk && link) {
    const host = (link[1] ?? "").toLowerCase();
    const trusted = /(?:^|\.)(?:safaricom\.co\.ke|saf\.cx|airtel\.co\.ke|airtelmoney\.co\.ke|equitybank\.co\.ke|kcbgroup\.com|kcb\.co\.ke|ncbagroup\.com|absabank\.co\.ke|stanbic\.co\.ke|co-opbank\.co\.ke|familybank\.co\.ke|dtbkenya\.com)$/.test(host);
    if (!trusted) {
      return {
        severity: "critical", kind: "phishing", sender,
        title: "Possible phishing message",
        detail: `This message asks for a PIN, code or details and links to ${host}. Open your provider's app or dial the official number instead; never enter a PIN on a link.`,
        evidence: { pattern: "phishing_link", host },
      };
    }
  }
  return null;
}

export function detectSmsSpoof(msg: SmsMessage): SpoofAlert | null {
  const sender = msg.sender.trim();
  if (!/^(?:\+?254|0)[17]\d{8}$/.test(sender.replace(/[\s-]/g, ""))) return null;
  const body = msg.body;
  const financialReceipt = /\b(confirmed|new m-?pesa balance|you have received|credited to your account|transaction cost|paid to|sent to)\b/i.test(body);
  const currency = /(?:KES|Ksh|KSh)\s*[\d,]+/i.test(body);
  if (!financialReceipt || !currency) return null;
  return {
    severity: "critical",
    kind: "msisdn_spoof",
    sender,
    title: "Possible fake transaction SMS",
    detail: "A personal phone number sent a message that looks like a bank/wallet confirmation. It was blocked from your ledger.",
    evidence: { sender, markers: "receipt_language" },
  };
}

function amountAt(body: string, re: RegExp): number | null {
  re.lastIndex = 0;
  const m = re.exec(body);
  if (!m) return null;
  try { return parseKes(m[1]!); } catch { return null; }
}

function inferDirection(body: string): Direction | null {
  if (DIRECTION_IN.test(body) && !DIRECTION_OUT.test(body)) return "in";
  if (DIRECTION_OUT.test(body) && !DIRECTION_IN.test(body)) return "out";
  if (/\b(credited|received|deposited|refunded)\b/i.test(body)) return "in";
  if (/\b(debited|sent|paid|withdrawn|purchase)\b/i.test(body)) return "out";
  return null;
}

function inferKind(body: string, dir: Direction, provider: Provider): TxKind {
  if (/withdraw/i.test(body)) return "withdraw";
  if (/\b(paybill|bill|account no|account number|kplc|prepaid|postpaid|token|units?|kwh)\b/i.test(body)) return "paybill";
  if (/\b(till|merchant|pos|card|purchase)\b/i.test(body)) return /\bcard\b/i.test(body) ? "bank_debit" : "till";
  if (/\b(airtime|bundle)\b/i.test(body)) return "airtime";
  if (/\b(loan|fuliza|okoa|m-?shwari)\b/i.test(body) && dir === "out") return "loan_repay";
  if (dir === "in") return "bank_credit";
  if (provider === "bank") return "bank_debit";
  return "send";
}

function extractDate(body: string, fallback: number): number {
  const iso = /\b(\d{4}-\d{1,2}-\d{1,2})\b(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/.exec(body);
  if (iso) {
    const datePart = iso[1]!;
    const timePart = iso[2] ?? "12:00";
    const [y, m, d] = datePart.split("-").map(Number) as [number, number, number];
    const [hh, mm, ss = "0"] = timePart.split(":") as [string, string, string?];
    const utc = Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss));
    return utc - 3 * 3_600_000;
  }
  const dm = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b(?:\s*(?:at\s*)?(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?))?/.exec(body);
  if (dm) {
    try { return parseEatDateTime(dm[1]!, dm[2] ?? "12:00"); } catch { return fallback; }
  }
  return fallback;
}

function cleanName(s: string | undefined): string | null {
  if (!s) return null;
  const n = s.replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim();
  if (!n || /^(your|the|a|an|account|card|bank|m-?pesa)$/i.test(n)) return null;
  return n.slice(0, 80);
}

/** Parse any financial-looking alphanumeric sender, even if no template exists. */
export function parseUniversalFinancialSms(msg: SmsMessage, provider: Provider = "bank"): ParsedSms | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (!FINANCIAL.test(body)) return null;
  const dir = inferDirection(body);
  if (!dir) return null;
  const amount = amountAt(body, CURRENCY);
  if (amount == null || amount <= 0) return null;

  const rail = railForSender(msg.sender);
  const paybill = /\b(?:paybill|bill)\s*(?:no\.?|number)?\s*(\d{5,10})/i.exec(body)?.[1]
    ?? /\b(?:acct|account|a\/c)\s*(?:no\.?|number)?\s*([Xx*\d]{5,20})/i.exec(body)?.[1]
    ?? null;
  const targetRail = railForPaybill(paybill);

  const fee = amountAt(body, /(?:fee|transaction cost|charges?|levy)[^0-9]{0,20}(?:KES|Ksh|KSh)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const balance = amountAt(body, /(?:balance|bal)[^0-9]{0,25}(?:KES|Ksh|KSh)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const ref = /\b(?:ref(?:erence)?|transaction id|txn id|receipt)\b[^A-Z0-9]{0,8}([A-Z0-9]{6,24})/i.exec(body)?.[1]
    ?? /^([A-Z0-9]{8,24})\b/.exec(body)?.[1]
    ?? null;
  const account = /\b(?:account|acct|a\/c|card)\b[^A-Za-z0-9]{0,10}([Xx*\d]{4,24})/i.exec(body)?.[1] ?? null;
  const cp = cleanName(
    /\b(?:to|from|in favour of|in favor of)\s+([A-Za-z0-9&' -]{2,80}?)(?=\s+(?:on|for|ref|account|a\/c|via)|[.;]|$)/i.exec(body)?.[1]
    ?? rail?.displayName ?? targetRail?.displayName,
  );

  return {
    provider,
    ref: ref ? ref.toUpperCase() : null,
    kind: inferKind(body, dir, provider),
    direction: dir,
    amount,
    fee,
    balanceAfter: balance,
    counterpartyName: cp,
    counterpartyId: paybill,
    account,
    occurredAt: extractDate(body, msg.receivedAt),
    template: "ufg.v1",
    parserVersion: "ufg-0.1.0",
  };
}
