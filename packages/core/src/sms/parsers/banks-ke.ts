import type { ParsedSms, SmsMessage } from "../../types.js";
import { parseUniversalFinancialSms } from "../universal-lexer.js";
import { railForSender } from "../rails-directory.js";
import { parseKes } from "../money.js";

/** Tier-1 bank/utility/card capable parser; falls back to the Universal Financial Grammar. */
export function parseBankKe(msg: SmsMessage): ParsedSms | "skip" | null {
  const body = msg.body.replace(/\s+/g, " ").trim();
  if (/^(promotion|offer|dear customer,? (?:get|apply|enjoy))/i.test(body)) return "skip";

  const rail = railForSender(msg.sender);
  const kplc = /(?:kplc|kenya power)/i.test(`${msg.sender} ${body}`);
  if (kplc && /(?:token|units?|kwh)/i.test(body)) {
    const amt = /(?:KES|Ksh|KSh)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(body)?.[1];
    if (amt) {
      return {
        provider: "bank", ref: /(?:token|ref)[^A-Z0-9]{0,5}([A-Z0-9]{6,24})/i.exec(body)?.[1]?.toUpperCase() ?? null,
        kind: "paybill", direction: "out", amount: parseKes(amt), fee: null, balanceAfter: null,
        counterpartyName: "KPLC", counterpartyId: "888880", account: /(\d{6,12})/.exec(body)?.[1] ?? null,
        occurredAt: msg.receivedAt, template: "kplc.tokens", parserVersion: "banks-ke-0.1.0",
      };
    }
  }

  const u = parseUniversalFinancialSms(msg, "bank");
  if (!u) return null;
  if (rail) {
    u.counterpartyName = u.counterpartyName ?? rail.displayName;
    u.template = `${rail.provider}.ufg`;
  }
  return u;
}
