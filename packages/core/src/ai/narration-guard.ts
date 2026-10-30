/**
 * Narration guard: pure checks that an LLM rewrite of a deterministic finding kept every fact.
 * Consolidated from the proven checks in the app's former narrate.ts (git 1b17468^), moved into
 * core so the same guard runs for any model path (local QVAC, Swahili output, cloud text).
 * The original behaviour is preserved on purpose; do not loosen without a failing case first.
 */
import type { Verdict } from "./sms-validate.js";

// Protect amounts (3-7 digits) from hallucination. Ignore counts/dates/times and long digit runs
// (msisdn / till keys) which must not be echoed anyway. Join thousands separators first so
// "2,705" / "2.705" / "2 705" match "2705".
export const numbers = (s: string): string[] =>
  (s.replace(/(\d)[,.\u00A0\u202F ](?=\d{3}(?:\D|$))/g, "$1").match(/\d+/g) ?? []).filter((x) => x.length >= 3 && x.length < 8);

export const TIME_WORDS = /\b(day|days|week|weeks|month|months|year|years)\b/i;
/** True when the rewrite introduces a duration word that the finding itself did not contain. */
export function inventsTime(title: string, text: string): boolean {
  return TIME_WORDS.test(text) && !TIME_WORDS.test(title);
}

export function missingNumbers(title: string, text: string): string[] {
  const have = new Set(numbers(text));
  return [...new Set(numbers(title))].filter((n) => !have.has(n));
}

// Small amounts (KES 27) and role swaps slip past the digit heuristic. Track labelled currency
// amounts and require the same label -> amount pairs in the rewrite, so "borrowed 27, repaid 42"
// cannot become "repaid 27 and 42".
const AMOUNT = /(?:KES|Ksh|KSh)\s*([\d][\d,.\u00A0\u202F ]*)/g;
const ROLE_AMOUNT = /\b(borrowed|repaid|spent|spending|received|income|earned|paid|fees?|total|balance|loan(?:s)?)(?:\s+(?:of|is|was|were|at|to|from))?\s*(?:KES|Ksh|KSh)\s*([\d][\d,.\u00A0\u202F ]*)/gi;

export function normaliseAmount(raw: string): string | null {
  const n = Number(raw.replace(/[,\u00A0\u202F ]/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? String(n) : null;
}

export function currencyAmounts(s: string): string[] {
  return [...s.matchAll(AMOUNT)].map((m) => normaliseAmount(m[1]!)).filter((x): x is string => x !== null);
}

export function rolePairs(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(ROLE_AMOUNT)) {
    const amount = normaliseAmount(m[2]!);
    if (amount !== null) out.add(`${m[1]!.toLowerCase()}:${amount}`);
  }
  return out;
}

/** Null when amounts and amount roles survive exactly; otherwise a reason string. */
export function amountIssue(title: string, text: string): string | null {
  // Zero can be expressed as "no fees"; positives must survive exactly.
  const positive = (a: string) => Number(a) > 0;
  const titleAmounts = new Set(currencyAmounts(title).filter(positive));
  const textAmounts = new Set(currencyAmounts(text).filter(positive));
  const missing = [...titleAmounts].filter((a) => !textAmounts.has(a));
  if (missing.length) return `currency amount check failed: missing ${missing.slice(0, 3).join(", ")}`;
  const extra = [...textAmounts].filter((a) => !titleAmounts.has(a));
  if (extra.length) return `currency amount check failed: invented ${extra.slice(0, 3).join(", ")}`;
  const want = new Set([...rolePairs(title)].filter((p) => positive(p.split(":")[1] ?? "0")));
  const got = new Set([...rolePairs(text)].filter((p) => positive(p.split(":")[1] ?? "0")));
  const lost = [...want].filter((p) => !got.has(p));
  const invented = [...got].filter((p) => !want.has(p));
  if (lost.length || invented.length) return "amount role check failed";
  return null;
}

/** A finished sentence ends in terminal punctuation, optionally followed by a closing quote/bracket. */
export function looksComplete(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text);
}

/**
 * Full guard in the original order. `accepted` false means: use the deterministic template.
 * `title` is the deterministic finding text; `text` the model rewrite.
 */
export function checkNarration(title: string, text: string): Verdict {
  const t = (text ?? "").trim();
  if (!t) return { accepted: false, reasons: ["empty model output"] };
  if (!looksComplete(t)) return { accepted: false, reasons: ["model output incomplete"] };
  const missing = missingNumbers(title, t);
  if (missing.length) return { accepted: false, reasons: [`number check failed: missing ${missing.slice(0, 3).join(", ")}`] };
  const amount = amountIssue(title, t);
  if (amount) return { accepted: false, reasons: [amount] };
  if (inventsTime(title, t)) return { accepted: false, reasons: ["time-word check failed"] };
  return { accepted: true, reasons: [] };
}
