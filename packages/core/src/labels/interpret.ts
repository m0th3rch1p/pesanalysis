/**
 * Description -> structured label. The user can type anything ("cigarettes 30",
 * "dog food for the dog", "recreation fun") and the deterministic layer maps it to
 * taxonomy + detail. The same function runs in the app (Review) and in the gold
 * migration, so a correction means the same thing everywhere.
 *
 * Layering, strongest first:
 *   1. exact taxonomy name
 *   2. per-user lexicon (learned from confirmations: "dog food" -> Pets)
 *   3. keyword rules (business/merchant vocabulary)
 *   4. message context (repayment, airtime, withdrawal, direction)
 * The LLM is NOT used here. It only normalises language the rules miss, and its
 * output must validate against the taxonomy before it is accepted.
 */
import { SEED_LABELS } from "./taxonomy.js";

export type InterpretSource = "lexicon" | "exact" | "keyword" | "context" | "none";

export interface InterpretContext {
  direction?: "in" | "out" | "neutral";
  kind?: string | null;
  template?: string | null;
  counterpartyName?: string | null;
  funding?: "wallet" | "fuliza" | "okoa" | "airtel_loan" | "bank" | null;
}

export interface Interpreted {
  category: string | null;
  detail: string;
  confidence: number;
  source: InterpretSource;
  alternates: Array<{ category: string; confidence: number; source: InterpretSource }>;
}

/** Learned token -> category. Keys are lowercase; values must be taxonomy names. */
export type UserLexicon = Record<string, string>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const CATEGORIES = SEED_LABELS.map((l) => l.name);
const BY_NORM = new Map(CATEGORIES.map((c) => [norm(c), c]));

interface Rule { re: RegExp; category: string; conf: number }
const R = (re: RegExp, category: string, conf: number): Rule => ({ re, category, conf });

// Specific before generic so equal-confidence ties resolve toward detail.
const RULES: Rule[] = [
  R(/\b(dog|puppy|cat|kitten)\s+(food|feed)\b|\bpet food\b|petcare|\bvet\b|veterinar|kennel|animal feed/, "Pets", 0.9),
  R(/netflix|spotify|youtube premium|google one|openai|chatgpt|deepseek|opencode|subscription|saas|\bonline\b/, "Subscriptions", 0.85),
  R(/supermarket|grocer|groceries/, "Groceries", 0.85),
  R(/airtime|okoa|bundle|\bdata\b|safaricom|airtel/, "Airtime & data", 0.8),
  R(/\b(chapo|mutura|roho|fries|mandazi|restaurant|cafe|eatery)\b/, "Eating out", 0.8),
  R(/fuel|petrol|diesel|shell|total energ|rubis|kenol/, "Fuel", 0.85),
  R(/kplc|kenya power|electricity|water bill|utilit/, "Utilities", 0.85),
  R(/\brent\b|landlord/, "Rent", 0.8),
  R(/hospital|clinic|pharmacy|chemist|dawa|medical/, "Health", 0.85),
  R(/school|college|university|academy|\bfees\b/, "School fees", 0.8),
  R(/recreation|\bdrinks?\b|beer|movie|club|party|game/, "Entertainment", 0.8),
  R(/clothes|shoes|electronics|furniture|\bshopping\b/, "Shopping", 0.75),
  R(/savings|sacco|mshwari|ziidi|invest/, "Savings & investment", 0.8),
  R(/\bsalary\b/, "Salary", 0.9),
  R(/sales|sold|\bcustomer\b/, "Sales (business)", 0.7),
  R(/payout|prize|award|hackathon|bonus|refund/, "Other income", 0.8),
  R(/\b(debt|loan|repay|fuliza)\b/, "Debt repayment", 0.7),
  R(/\bfees?\b|charges?/, "Fees & charges", 0.65),
  R(/\bfamily\b|\bmum\b|\bmom\b|\bdad\b|sister|brother|\bwife\b|husband|\bchild\b/, "Family support", 0.7),
  R(/\bfriend\b|homie|\bbro\b|dude/, "Personal transfer", 0.7),
  R(/matatu|\bbus\b|\bfare\b|uber|bolt|transport|bike|motorcycle|maintenance/, "Transport", 0.7),
  R(/eggs?|milk|sugar|unga|bread|bananas?|lemon|rice|flour|cooking oil|maize|poshomill|posho mill|soap|detergent|carrier bag|cigarettes?|cigarrettes?|kiosk|duka|\bshop\b/, "Groceries", 0.7),
  R(/\b(food|meal|lunch|dinner|breakfast|snack)\b/, "Eating out", 0.6),
  R(/\bfood\b/, "Groceries", 0.45),
  R(/\bbank\b|equity|transfer/, "Transfer out", 0.55),
];

const AMOUNT = /\b(?:ksh|kes)\s*[\d,.]+|\b\d+(?:\.\d+)?\s*(?:bob|bucks|\/=)\b/gi;

function cleanDetail(raw: string): string {
  return raw
    .replace(AMOUNT, " ")
    .replace(/\b(?:paid|pay|sent|send|received|receive|bought|buy|gave|give)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:+-]+|[\s,.;:+-]+$/g, "")
    .replace(/^\d+(?:\.\d+)?\s+/, "")
    .replace(/\s+\d+(?:\.\d+)?$/, "")
    .slice(0, 160)
    .trim();
}

function lexiconHit(text: string, lexicon?: UserLexicon): string | null {
  if (!lexicon) return null;
  for (const token of norm(text).split(" ")) {
    const hit = lexicon[token];
    if (hit && BY_NORM.has(norm(hit))) return BY_NORM.get(norm(hit))!;
  }
  return null;
}

function byContext(ctx: InterpretContext): Interpreted | null {
  const kind = ctx.kind ?? "";
  const tpl = ctx.template ?? "";
  const dir = ctx.direction;
  if (/repay/.test(tpl) || kind === "loan_repay") return { category: "Debt repayment", detail: "", confidence: 0.9, source: "context", alternates: [] };
  if (kind === "fee") return { category: "Fees & charges", detail: "", confidence: 0.85, source: "context", alternates: [] };
  if (kind === "airtime" || kind === "bundle") return { category: "Airtime & data", detail: "", confidence: 0.85, source: "context", alternates: [] };
  if (kind === "withdraw") return { category: "Cash withdrawal", detail: "", confidence: 0.8, source: "context", alternates: [] };
  if (kind === "loan_draw") {
    if (/okoa|airtime_loan/.test(tpl)) return { category: "Airtime & data", detail: "", confidence: 0.75, source: "context", alternates: [] };
    if (tpl === "mpesa.fuliza_draw") return { category: null, detail: "", confidence: 0, source: "none", alternates: [] };
  }
  if (dir !== "out" && /^(receive|deposit|bank_credit|reversal)$/.test(kind)) {
    return { category: "Transfer in", detail: "", confidence: 0.55, source: "context", alternates: [] };
  }
  return null;
}

export function interpret(text: string | null | undefined, ctx: InterpretContext = {}, lexicon?: UserLexicon): Interpreted {
  const raw = (text ?? "").trim();
  const n = norm(raw);

  // 1. exact taxonomy name ("Debt repayment", "Airtime & data")
  if (n && BY_NORM.has(n)) {
    return { category: BY_NORM.get(n)!, detail: "", confidence: 0.95, source: "exact", alternates: [] };
  }

  // 2. learned personal vocabulary ("dog food" -> Pets)
  const learned = raw ? lexiconHit(raw, lexicon) : null;

  // 3. keyword rules
  const hits = new Map<string, { conf: number; source: InterpretSource }>();
  if (raw) {
    for (const r of RULES) {
      if (!r.re.test(raw.toLowerCase())) continue;
      const prev = hits.get(r.category);
      if (!prev || r.conf > prev.conf) hits.set(r.category, { conf: r.conf, source: "keyword" });
    }
  }
  if (learned) {
    const prev = hits.get(learned);
    if (!prev || prev.conf < 0.92) hits.set(learned, { conf: 0.92, source: "lexicon" });
  }

  // direction fixes for person/transfer labels
  if (ctx.direction === "in") {
    for (const c of ["Personal transfer", "Family support", "Transfer out"]) {
      const h = hits.get(c);
      if (h) { hits.delete(c); hits.set("Transfer in", { conf: h.conf, source: h.source }); }
    }
  }

  // 4. context fallback / definitive message types
  if (!hits.size) {
    const c = byContext(ctx);
    if (c) return { ...c, detail: raw ? cleanDetail(raw) : "" };
    return { category: null, detail: raw ? cleanDetail(raw) : "", confidence: 0, source: "none", alternates: [] };
  }

  // repayments/fees are definitive message types even if the words say otherwise
  const definitive = byContext({ ...ctx, direction: ctx.direction });
  if (definitive && definitive.confidence >= 0.85 && definitive.category) {
    const prev = hits.get(definitive.category);
    if (!prev || prev.conf < definitive.confidence) hits.set(definitive.category, { conf: definitive.confidence, source: "context" });
  }

  const ranked = [...hits.entries()]
    .map(([category, v]) => ({ category, confidence: v.conf, source: v.source }))
    .sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0]!;
  return {
    category: top.category,
    detail: cleanDetail(raw),
    confidence: top.confidence,
    source: top.source,
    alternates: ranked.slice(1, 4),
  };
}

const STOP = new Set(["the", "a", "an", "for", "and", "with", "from", "this", "that", "was", "is", "my", "our", "of", "to", "at", "on", "paid", "pay", "sent", "send", "received", "receive", "bought", "buy", "gave", "give", "some", "ksh", "kes", "bob", "bucks", "shillings", "amount"]);

/**
 * Merge a confirmation into the learned vocabulary. Keeps single words only and
 * refuses generic words that already mean another category ("food" must not
 * become Pets just because one dog-food description was confirmed).
 */
export function learnLexicon(text: string, category: string, base: UserLexicon = {}): UserLexicon {
  if (!BY_NORM.has(norm(category))) return base;
  const out = { ...base };
  for (const token of norm(text).split(" ")) {
    if (token.length < 2 || token.length > 24) continue;
    if (STOP.has(token) || BY_NORM.has(token) || /^\d+$/.test(token)) continue;
    if (RULES.some((r) => r.category !== category && r.re.test(token))) continue;
    out[token] = category;
  }
  return out;
}
