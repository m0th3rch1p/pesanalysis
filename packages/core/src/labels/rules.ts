import type { ParsedSms } from "../types.js";
import { KIND_DEFAULTS } from "./taxonomy.js";
import { isOffRadarDestination } from "../sms/rails-directory.js";

export interface LabelRule {
  id: string;
  /** normalized-text substring/regex test over counterparty + account + template */
  test: (ctx: RuleCtx) => boolean;
  label: string;
  /** prior confidence when the rule alone matches (0..1) */
  conf: number;
}

export interface RuleCtx {
  parsed: ParsedSms;
  /** lowercase concatenated haystack: counterparty name + account + template + ref */
  hay: string;
}

/**
 * Deterministic keyword rules, weighted BELOW user confirmations but ABOVE kNN ties.
 * These encode common Kenyan patterns; the evolution loop can add/edit rules as typed proposals.
 * Keep this list SHORT and only high-precision (a wrong confident label poisons learning).
 */
export const SEED_RULES: LabelRule[] = [
  { id: "r_offradar", test: (c) => isOffRadarDestination(c.parsed), label: "Off-radar transfer", conf: 0.92 },
  { id: "r_kplc", test: (c) => /kplc|kenya power|electricity|tokens?/.test(c.hay), label: "Utilities", conf: 0.9 },
  { id: "r_water", test: (c) => /nairobi water|water bill|gerishon ikawa/.test(c.hay), label: "Utilities", conf: 0.9 },
  { id: "r_fuel", test: (c) => /\b(total energ|shell|rubis|kenol|oilcom|gooil|petrol|filling station)/.test(c.hay), label: "Fuel", conf: 0.85 },
  { id: "r_uber", test: (c) => /uber|bolt|little cab|inDrive/.test(c.hay), label: "Transport", conf: 0.9 },
  { id: "r_supermarket", test: (c) => /naivas|quickmart|carrefour|cleo|chandarana|East Mahiti|mahiti/.test(c.hay), label: "Groceries", conf: 0.85 },
  { id: "r_school", test: (c) => /school|academy|college|university|fees/.test(c.hay), label: "School fees", conf: 0.8 },
  { id: "r_hospital", test: (c) => /hospital|clinic|pharmacy|chemists?|medical|agakhan|nairobi west|ppea|avenues/.test(c.hay), label: "Health", conf: 0.85 },
  { id: "r_rent", test: (c) => /rent|properties|estates|landlord/.test(c.hay), label: "Rent", conf: 0.7 },
  { id: "r_stock", test: (c) => /wholesal|gikomba|kongowea|market ltd|distribut/.test(c.hay), label: "Business stock", conf: 0.7 },
  { id: "r_saccosave", test: (c) => /sacco|stima|deposit.*(savings|mshwari|ziidi)|m-?shwari|ziidi/.test(c.hay), label: "Savings & investment", conf: 0.75 },
  { id: "r_fuliza", test: (c) => c.parsed.kind === "loan_repay" && /fuliza/.test(c.hay), label: "Debt repayment", conf: 0.85 },
  { id: "r_okoa", test: (c) => c.parsed.kind === "loan_repay" && /okoa|kopa credo/.test(c.hay), label: "Debt repayment", conf: 0.85 },
  { id: "r_airtime", test: (c) => /airtime|data bundles?|safaricom data|airtel data/.test(c.hay), label: "Airtime & data", conf: 0.8 },
  { id: "r_pets", test: (c) => /\b(dog|puppy|cat|kitten)\b.*\bfood\b|\bpet food\b|petcare|\bvet\b|veterinar|kennel|animal feed/.test(c.hay), label: "Pets", conf: 0.85 },
  { id: "r_subscriptions", test: (c) => /netflix|spotify|youtube premium|google one|openai|chatgpt|deepseek|opencode|subscription/.test(c.hay), label: "Subscriptions", conf: 0.85 },
];

/** Kind defaults are the weakest rules (they only fill gaps). */
export function kindDefaultLabel(kind: string): string | null {
  return KIND_DEFAULTS[kind] ?? null;
}
