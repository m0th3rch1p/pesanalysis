/**
 * Which unparsed SMS are worth handing to the on-device model (F2).
 *
 * The inbox contains far more marketing than money. A candidate must come from a financial-looking
 * sender, state an amount, look like a transaction rather than a promotion/OTP, and be short. False
 * negatives are cheap (the message stays in the inbox); false positives cost the user's attention and
 * battery, so the filter is deliberately strict. The model's answer is validated again afterwards.
 */
import type { Provider } from "../types.js";
import { classifySender } from "../sms/senders.js";

export interface CandidateInput {
  sender: string;
  body: string;
  receivedAt: number;
  /** The deterministic parser's skip reason for this message. */
  skipReason?: string | null;
}

export interface CandidateVerdict {
  candidate: boolean;
  reasons: string[];
  provider: Provider;
  /** True when the sender is not in a known family but the body looks like a transaction. */
  unknownSender: boolean;
}

const MONEY = /(?:ksh|kes|kshs|sh)\s*\.?\s*\d|\b\d[\d,]*(?:\.\d{1,2})?\s*\/=/i;
const TX_LIKE = /\b(confirmed|has been|have been|sent to|sent from|received from|paid to|payment|paid|debited|credited|withdrawn|withdrew|deposited|transferred|transfered|transaction|receipt|balance|loan|repay|due)\b/i;
const PROMO = /\b(congratulat|you have won|you are the lucky|lucky winner|loan offer|pre-?approved|apply now|click|http|www\.|unsubscribe|terms (?:and|&) conditions|dial \*|ussd|customer care|for enquiries|offer valid|promotion)\b/i;
const OTP = /\b(otp|one[- ]?time|verification code|your code|passcode|pin is|do not share)\b/i;
const STRONG_TX = /\b(confirmed|has been (?:sent|received|paid|debited|credited)|transaction (?:cost|complete|id)|new .*balance|m-?pesa balance)\b/i;

const MAX_LEN = 600;

export function modelCandidate(i: CandidateInput): CandidateVerdict {
  const reasons: string[] = [];
  const body = i.body ?? "";
  const sender = i.sender ?? "";
  const base = classifySender(sender);
  const unknownSender = !base.financial && base.reason === "not_financial_sender" && /[A-Za-z]/.test(sender);

  const skip = i.skipReason ?? "";
  if (skip && !["no_template_match", "not_a_transaction"].includes(skip)) reasons.push(`skip_reason:${skip}`);
  if (!sender || !/[A-Za-z]/.test(sender)) reasons.push("sender_not_alphanumeric");
  if (body.length < 12) reasons.push("too_short");
  if (body.length > MAX_LEN) reasons.push("too_long");
  if (!MONEY.test(body)) reasons.push("no_amount");
  if (OTP.test(body)) reasons.push("otp");
  if (PROMO.test(body)) reasons.push("promo");
  if (!base.financial) {
    if (!unknownSender) reasons.push(base.reason ?? "sender_not_financial");
    else if (!STRONG_TX.test(body)) reasons.push("unknown_sender_without_transaction_language");
  }
  const candidate = reasons.length === 0 && TX_LIKE.test(body);
  if (reasons.length === 0 && !candidate) reasons.push("no_transaction_language");
  return { candidate, reasons, provider: base.provider, unknownSender };
}

/** Redaction for logs/UI: keep shape, never the data. */
export function candidateFingerprint(sender: string, body: string): string {
  const digits = (body.match(/\d+/g) ?? []).reduce((n, d) => n + d.length, 0);
  return `${sender.toUpperCase()}:${body.length}:${digits}`;
}
