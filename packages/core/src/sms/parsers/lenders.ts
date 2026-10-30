import type { ParsedSms, SmsMessage } from "../../types.js";
import { parseKes } from "../money.js";

export const LENDER_PARSER_VERSION = "lender-0.1.0";

/**
 * Digital-lender senders (HUSTLERFUND, BRIDGE LOAN, Zenka/FINLEY INT, Credotosha, ...).
 * In this inbox they are ALL reminders/marketing ("Did you know?", "we have not received your
 * Zenka loan payment", Swahili airtime ads). Real disbursements arrive via the MPESA sender
 * ("You have received KshX from FINLEY...") and are handled by mpesa.receive.
 * So: recognize and SKIP, so they count as understood rather than unparsed.
 */
const SKIPPERS: RegExp[] = [
  /Did you know\?/i,
  /Repay your outstanding .* loan using Bonga/i,
  /we have not received your .* loan payment/i,
  /New month, new chance to re-borrow/i,
  /waiver Expires/i,
  /Nunua Airtel Airtime/i,
  /PayBill Fiti/i,
  /reminded to clear your balance/i,
  /kindly reminded/i,
  /Download .* here/i,
  /Welcome to Vet Mkononi/i,
  /Pet Name:/i,
];

/** Vet-style payment confirmations on a service platform: "Payment received: Ksh1,200.00 Prev Bal: Ksh2,500.00 Bal: Ksh1,300.00" */
const PAYMENT_RECEIVED = /Payment received:\s*(?:Kshs?\.?\s?)?(?<amt>[\d,]+(?:\.\d{1,2})?)(?:\.?\s*Prev Bal:\s*(?:Kshs?\.?\s?)?[\d,]+(?:\.\d{1,2})?)?(?:\.?\s*Bal:\s*(?:Kshs?\.?\s?)?(?<bal>[\d,]+(?:\.\d{1,2})?))?/i;

export function parsePlatform(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (SKIPPERS.some((re) => re.test(body))) return "skip";
  const m = PAYMENT_RECEIVED.exec(body);
  if (m && m.groups?.amt) {
    return {
      provider: "platform",
      ref: null,
      kind: "receive",
      direction: "in",
      amount: parseKes(m.groups.amt),
      fee: null,
      balanceAfter: m.groups.bal ? parseKes(m.groups.bal) : null,
      counterpartyName: "The Animal Doctor",
      counterpartyId: null,
      account: null,
      occurredAt: msg.receivedAt,
      template: "platform.payment_received",
      parserVersion: LENDER_PARSER_VERSION,
    };
  }
  return null;
}

/** Lender notices: currently always skip (marketing/reminder shapes above). */
export function parseLenderNotice(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (SKIPPERS.some((re) => re.test(body))) return "skip";
  return null;
}
