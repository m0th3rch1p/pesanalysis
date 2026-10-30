import type { Provider } from "../types.js";
import { BANK_SENDERS } from "./rails-directory.js";

/**
 * Sender-ID families observed in the founder's inbox (headers only; bodies never inspected
 * when this was written). Matching is case-insensitive on the alphanumeric sender ID.
 * SECURITY: a sender ID alone is NOT proof of authenticity (SMS sender spoofing exists).
 * Second check = balance-chain audit (ledger/balance-chain.ts).
 */
const FAMILIES: Array<{ re: RegExp; provider: Provider; note: string }> = [
  { re: /^mpesa$/i, provider: "mpesa", note: "M-PESA transaction messages" },
  { re: /^(safaricom|saf_balance|saf_ofamoto)$/i, provider: "telco", note: "airtime/data + Okoa airtime loans; promos skipped in parser" },
  { re: /^okoa ?jahazi$/i, provider: "telco", note: "airtime-credit loans (Safaricom)" },
  { re: /^(airtel|airtelalert|airtel_info|airtelmoney|airtel money|myairtime)$/i, provider: "airtel_money", note: "Airtel Money txs + telco notices (Kopa Credo loans; promos skipped)" },
  { re: /^(kcb m-?pesa|m-?shwari)$/i, provider: "mpesa", note: "KCB M-PESA / M-Shwari mirror notices (parsed via MPESA sender; these are skipped as duplicates/promos)" },
  { re: /^equity ?bank$/i, provider: "bank", note: "Equity Bank alerts" },
  ...BANK_SENDERS.map((b) => ({ re: b.re, provider: "bank" as Provider, note: "Kenyan bank / SACCO / utility rail" })),
  { re: /^(hustlerfund|xpresscredo|credosure|credotosha|bridge loan|finley int)$/i, provider: "lender", note: "digital lenders / loans (notices; disbursements arrive via MPESA)" },
  { re: /^vet_mkononi$/i, provider: "platform", note: "vet-service platform: payment confirmations" },
];

/** Senders that LOOK financial but are pure marketing in this inbox (verified 25 Oct 2026). */
const NON_FINANCIAL = /^(masters_ltd|airtel_info|myairtime)$/i;

export function classifySender(sender: string): { financial: boolean; provider: Provider; reason?: "phone_number_sender" | "not_financial_sender" } {
  const s = sender.trim();
  if (!/[A-Za-z]/.test(s)) return { financial: false, provider: "unknown", reason: "phone_number_sender" };
  if (NON_FINANCIAL.test(s)) return { financial: false, provider: "unknown", reason: "not_financial_sender" };
  for (const f of FAMILIES) if (f.re.test(s)) return { financial: true, provider: f.provider };
  return { financial: false, provider: "unknown", reason: "not_financial_sender" };
}
