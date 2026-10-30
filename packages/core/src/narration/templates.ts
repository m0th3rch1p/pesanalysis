import type { Finding } from "../detectors/types.js";
import { formatKes } from "../sms/money.js";
import { plainTerms } from "./plain.js";

/**
 * Deterministic narration: findings -> plain language. The LLM may REWRITE these (English or
 * Swahili via AfriSLM) but the numbers come from the finding, never from the model.
 * The glossary exists because the desktop spike showed AfriSLM mistranslating domain terms
 * ("till" -> "kadi/card", "restock" -> "return goods"): protected terms are pinned in Swahili.
 */

const SW: Record<string, string> = {
  "till": "tila ya duka",
  "paybill": "pebi",
  "balance": "salio",
  "fees": "gharama",
  "fee": "gharama",
  "withdrawal": "kutoa pesa",
  "deposit": "kuweka pesa",
  "restock": "kujaza bidhaa",
  "float": "furoto",
  "loan": "mkopo",
  "repay": "lipa mkopo",
  "sales": "mauzo",
  "stock": "bidhaa",
  "rent": "kodi ya pango",
  "salary": "mshahara",
  "airtime": "airtime",
  "bundle": "bando",
};

export function glossary(term: string): string {
  return SW[term.toLowerCase()] ?? term;
}

/** Protected-term pre-pass for LLM narration: replace domain terms with placeholders so the model cannot mistranslate them. */
export function protectTerms(text: string): { text: string; restore: (t: string) => string } {
  const map = new Map<string, string>();
  let i = 0;
  const out = text.replace(/(till|paybill|balance|fees?|withdrawal|deposit|restock|float|loan|repay|sales|stock)/gi, (m) => {
    const key = `\u2039${i++}\u203a`;
    map.set(key, m);
    return key;
  });
  return { text: out, restore: (t) => t.replace(/\u2039\d+\u203a/g, (k) => map.get(k) ?? k) };
}

export function narrateFinding(f: Finding): string {
  const e = f.evidence as Record<string, any>;
  switch (f.detector) {
    case "amount_multiples":
      return `${formatKes(e.base * 100).replace("Ksh", "KES ")} multiples: ${plainTerms(f.title)}.`;
    case "time_of_day": {
      const [s, en] = e.window as [number, number];
      return `Most of these happen between ${String(s).padStart(2, "0")}:00 and ${String(en).padStart(2, "0")}:00.`;
    }
    case "periodic":
      return `Recurring: ${plainTerms(f.title)}`;
    case "fee_drag":
      return `Fees: ${plainTerms(f.title)}`;
    case "debt_cycle":
      return `Debt: ${plainTerms(f.title)}`;
    case "scope_mix":
      return `Mixing purposes: ${plainTerms(f.title)}`;
    case "episodes":
      return plainTerms(f.title);
    case "balance_break":
      return `Something does not add up: ${plainTerms(f.title)}`;
    default:
      return plainTerms(f.title);
  }
}

/** The deterministic daily summary shown even when no model is loaded. */
export function narrateDaily(day: { date: string; inCents: number; outCents: number; feesCents: number; topLabels: Array<{ label: string; cents: number }> }): string {
  const net = day.inCents - day.outCents;
  const parts = [
    `${day.date}: in ${formatKes(day.inCents)}, out ${formatKes(day.outCents)} (net ${formatKes(net)}), fees ${formatKes(day.feesCents)}.`,
  ];
  if (day.topLabels.length) parts.push(`Top: ${day.topLabels.slice(0, 3).map((l) => `${l.label} ${formatKes(l.cents)}`).join(", ")}.`);
  return parts.join(" ");
}
