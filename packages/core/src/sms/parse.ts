import type { ParseOutcome, ParsedSms, SmsMessage } from "../types.js";
import { classifySender } from "./senders.js";
import { parseMpesa } from "./parsers/mpesa.js";
import { parseMpesaSavings, parseSavingsSender, isSavingsSender } from "./parsers/mpesa-savings.js";
import { parseAirtel } from "./parsers/airtel.js";
import { parseEquity } from "./parsers/equity.js";
import { parseTelcoLoans } from "./parsers/telco-loans.js";
import { parseLenderNotice, parsePlatform } from "./parsers/lenders.js";
import { parseBankKe } from "./parsers/banks-ke.js";
import { parseUniversalFinancialSms } from "./universal-lexer.js";
import { fingerprint } from "./fingerprint.js";

/** Single entry point for every incoming SMS. Deterministic; no LLM. */
export function parseSms(msg: SmsMessage): ParseOutcome {
  const c = classifySender(msg.sender);
  if (!c.financial) {
    // Tier 2: unknown alphanumeric bank/SACCO/card sender -> Universal Financial Grammar.
    if (c.reason === "not_financial_sender" && /[A-Za-z]/.test(msg.sender)) {
      const u = parseUniversalFinancialSms(msg, "bank");
      if (u) return { ok: true, parsed: u };
    }
    return { ok: false, reason: c.reason! };
  }

  let r: ParsedSms | "skip" | null =
    c.provider === "mpesa" ? (isSavingsSender(msg.sender) ? parseSavingsSender(msg.sender, msg) : (parseMpesaSavings(msg) ?? parseMpesa(msg)))
    : c.provider === "airtel_money" ? parseAirtel(msg)
    : c.provider === "bank" ? (parseEquity(msg) ?? parseBankKe(msg))
    : c.provider === "telco" ? parseTelcoLoans(msg)
    : c.provider === "lender" ? parseLenderNotice(msg)
    : c.provider === "platform" ? parsePlatform(msg)
    : null;
  if (r === null && /[A-Za-z]/.test(msg.sender)) r = parseUniversalFinancialSms(msg, "bank");

  if (r === "skip") return { ok: false, reason: "not_a_transaction" };
  if (r) return { ok: true, parsed: r };
  return { ok: false, reason: "no_template_match", fingerprint: fingerprint(msg.body) };
}
