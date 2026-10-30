/**
 * Validators for LOCAL model output used by QVAC features (D85, F-QVAC rule 5: "every output is
 * validated by code before it can change anything"). Pure functions, no I/O. Every validator
 * returns `{ accepted, reasons[] }`; a model proposal is DATA until `accepted` is true, and even
 * then it is only ever a suggestion the user confirms (source = "llm").
 *
 * Bias: zero false acceptance over recall. When in doubt, reject; the message falls back to the
 * review queue.
 */
import { SEED_LABELS } from "../labels/taxonomy.js";
import type { Provider } from "../types.js";

export interface Verdict { accepted: boolean; reasons: string[] }

// ---------------------------------------------------------------------------------------------
// 1a. SMS classification: Laya `decide()` answers
// ---------------------------------------------------------------------------------------------

export type DecideQuestion = "is_financial" | "direction" | "category" | "due";
export interface DecideAnswer { choice: string; probability: number }

/** Per-question minimum probability. Category is hardest, so it is the lowest bar but still high. */
export const DECIDE_THRESHOLDS: Record<DecideQuestion, number> = {
  is_financial: 0.9,
  direction: 0.9,
  category: 0.8,
  due: 0.85,
};

const CATEGORY_SET = new Set(SEED_LABELS.map((l) => l.name));
const CHOICES: Record<Exclude<DecideQuestion, "category">, readonly string[]> = {
  is_financial: ["yes", "no"],
  direction: ["in", "out", "none"],
  due: ["yes", "no"],
};

/** What the deterministic parser already decided. When `parsed` is true the model is not consulted. */
export interface DeterministicResult { parsed: boolean }

export interface ClassificationInput {
  answers: Partial<Record<DecideQuestion, DecideAnswer>>;
  deterministic?: DeterministicResult | null;
}
export interface ClassificationVerdict extends Verdict {
  /** Only the answers that cleared their threshold. Empty when `accepted` is false. */
  fields: { is_financial?: boolean; direction?: "in" | "out" | "none"; category?: string; due?: boolean };
}

export function validateClassification(input: ClassificationInput): ClassificationVerdict {
  const reasons: string[] = [];
  const reject = (r: string): ClassificationVerdict => ({ accepted: false, reasons: [...reasons, r], fields: {} });

  // Never override a deterministic parser result, whatever the model says.
  if (input.deterministic?.parsed) return reject("deterministic_parser_result_takes_precedence");
  if (!input.answers || typeof input.answers !== "object") return reject("answers_not_object");

  const known = new Set<string>(["is_financial", "direction", "category", "due"]);
  for (const k of Object.keys(input.answers)) if (!known.has(k)) reasons.push(`unknown_question:${k}`);

  const fields: ClassificationVerdict["fields"] = {};
  const answers = input.answers;
  let rejectedAny = reasons.length > 0;

  for (const q of ["is_financial", "direction", "category", "due"] as const) {
    if (!Object.prototype.hasOwnProperty.call(answers, q)) continue;
    const a = answers[q];
    if (!a || typeof a.choice !== "string" || typeof a.probability !== "number" || !Number.isFinite(a.probability) || a.probability < 0 || a.probability > 1) {
      reasons.push(`${q}:malformed_answer`);
      rejectedAny = true;
      continue;
    }
    const allowed = q === "category" ? CATEGORY_SET.has(a.choice) : CHOICES[q].includes(a.choice);
    if (!allowed) { reasons.push(`${q}:choice_not_in_vocabulary`); rejectedAny = true; continue; }
    if (a.probability < DECIDE_THRESHOLDS[q]) { reasons.push(`${q}:below_threshold`); rejectedAny = true; continue; }
    if (q === "is_financial") fields.is_financial = a.choice === "yes";
    else if (q === "direction") fields.direction = a.choice as "in" | "out" | "none";
    else if (q === "category") fields.category = a.choice;
    else fields.due = a.choice === "yes";
  }

  // Coherence: dependent answers are dropped unless the message is accepted as financial.
  if (fields.is_financial === false) {
    for (const q of ["direction", "category", "due"] as const) {
      if (q in fields && !(q === "direction" && fields.direction === "none")) {
        reasons.push(`${q}:contradicts_not_financial`);
        rejectedAny = true;
      }
    }
    if (rejectedAny) return reject("incoherent_answers");
  }
  if (Object.keys(fields).length === 0) return reject("no_answer_cleared_threshold");
  // Strict: a partially acceptable answer set is still rejected as a whole. The caller may inspect
  // `fields` of a rejected verdict (empty) - it cannot cherry-pick below-threshold answers.
  if (rejectedAny) return { accepted: false, reasons, fields: {} };
  return { accepted: true, reasons, fields };
}

// ---------------------------------------------------------------------------------------------
// 1b. Field-extraction proposal validated against the raw text
// ---------------------------------------------------------------------------------------------

export interface ExtractionProposal {
  /** Major units (KES), e.g. 1234.5 */
  amount: number;
  direction: "in" | "out";
  counterparty?: string | null;
  /** ISO date or datetime. No zone => EAT. */
  date: string;
  ref?: string | null;
}
export interface ExtractionContext {
  body: string;
  /** Epoch ms when the SMS reached the phone. */
  receivedAt: number;
  provider?: Provider;
  /** Default true: the verbatim amount must sit next to a currency marker (Ksh/KES/Sh/USD or "/="). */
  requireCurrencyMarker?: boolean;
}

const EAT_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const PROPOSAL_KEYS = new Set(["is_transaction", "amount", "direction", "counterparty", "date", "ref"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_AMOUNT = 10_000_000;

export const REF_SHAPES: Record<Provider, RegExp> = {
  mpesa: /^[A-Z0-9]{10}$/,
  airtel_money: /^[A-Z0-9]{8,12}$/,
  bank: /^[A-Z0-9]{6,24}$/,
  lender: /^[A-Z0-9]{6,24}$/,
  telco: /^[A-Z0-9]{6,24}$/,
  platform: /^[A-Z0-9]{6,24}$/,
  unknown: /^[A-Z0-9]{6,24}$/,
};

const IN_WORDS = /\b(?:you have received|received|deposited|deposit of|credited|credit(?:ed)? to your|sent you|has sent you|refund(?:ed)?)\b/i;
const OUT_WORDS = /\b(?:sent to|paid to|you have sent|withdraw(?:n|al)?|debited|you bought|bought|purchased|transferred to|payment to|paid)\b/i;

/**
 * Deterministic direction from wording. Returns null when the text has no evidence or both directions,
 * so a model answer is only used when the text itself is ambiguous (and then still needs keywords).
 */
export function directionFromKeywords(body: string): "in" | "out" | null {
  const inHit = IN_WORDS.test(body);
  const outHit = OUT_WORDS.test(body);
  if (inHit === outHit) return null;
  return inHit ? "in" : "out";
}

const CURRENCY_PREFIX = new Set(["ksh", "kes", "sh", "shs", "usd", "ksh.", "kshs"]);

interface AmountToken { cents: number; marked: boolean }

/** Normalise separators: comma / thin space / nbsp as thousands, dot as decimal point. */
export function amountTokens(body: string): AmountToken[] {
  const out: AmountToken[] = [];
  const NUM = String.raw`\d{1,3}(?:[,\u00A0\u202F ]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
  // (?<![\d/:.,]) keeps date/time/decimal fragments out; the lookahead refuses "10/26", "9:05", "1.2.3".
  const re = new RegExp(String.raw`(?<![\d/:.,])([A-Za-z]*\.?)(\s?)(${NUM})(?![\d]|[/:](?!=)|\.\d)`, "g");
  for (const m of body.matchAll(re)) {
    const prefix = (m[1] ?? "").toLowerCase();
    const spaced = m[2] === " ";
    const isCurrency = CURRENCY_PREFIX.has(prefix) || CURRENCY_PREFIX.has(prefix.replace(/\.$/, ""));
    if (prefix && !spaced && !isCurrency) continue; // glued to letters: part of a ref/code
    const raw = m[3]!;
    const digitsOnly = raw.replace(/[^\d]/g, "");
    if (!raw.includes(".") && /^(?:0[17]\d{8}|254\d{9})$/.test(digitsOnly)) continue; // phone number
    const n = Number(raw.replace(/[,\u00A0\u202F ]/g, ""));
    if (!Number.isFinite(n)) continue;
    const after = body.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    out.push({ cents: Math.round(n * 100), marked: isCurrency || after === "/=" });
  }
  return out;
}

function eatDayNumber(ms: number): number { return Math.floor((ms + EAT_MS) / DAY_MS); }

function parseProposalDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  if (m[4] !== undefined) {
    const h = Number(m[4]), mi = Number(m[5]);
    if (h > 23 || mi > 59 || Number(m[6] ?? 0) > 59) return null;
    if (m[7]) {
      const off = m[7] === "Z" ? 0 : (m[7][0] === "-" ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(-2)));
      const instant = Date.UTC(y, mo - 1, d, h, mi, Number(m[6] ?? 0)) - off * 60_000;
      return eatDayNumber(instant);
    }
  }
  return Math.floor(probe.getTime() / DAY_MS);
}

/** Dates written in the body (dd/mm/yy, dd/mm/yyyy, yyyy-mm-dd) as EAT day numbers. */
function bodyDays(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/(?<![\d/])(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?![\d])/g)) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = Number(m[1]), mo = Number(m[2]);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d) out.push(Math.floor(probe.getTime() / DAY_MS));
  }
  for (const m of body.matchAll(/(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/g)) {
    const day = parseProposalDay(m[0]);
    if (day !== null) out.push(day);
  }
  return out;
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function validateExtraction(proposal: unknown, ctx: ExtractionContext): Verdict {
  const reasons: string[] = [];
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return { accepted: false, reasons: ["proposal_not_object"] };
  const p = proposal as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (FORBIDDEN_KEYS.has(k)) reasons.push(`forbidden_key:${k}`);
    else if (!PROPOSAL_KEYS.has(k)) reasons.push(`unknown_key:${k}`);
  }
  if (typeof ctx.body !== "string" || ctx.body.length === 0 || ctx.body.length > 2000) reasons.push("body_invalid");
  if (!Number.isFinite(ctx.receivedAt)) reasons.push("received_at_invalid");
  if (reasons.length) return { accepted: false, reasons };

  // A model that says "this is not a transaction" is never overridden by field checks.
  if (p.is_transaction !== undefined) {
    if (typeof p.is_transaction !== "boolean") reasons.push("is_transaction_invalid");
    else if (p.is_transaction === false) return { accepted: false, reasons: [...reasons, "not_transaction"] };
  }

  // amount: must appear verbatim (after separator normalisation) in the body.
  const amount = p.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    reasons.push("amount_invalid");
  } else {
    const cents = Math.round(amount * 100);
    if (Math.abs(amount * 100 - cents) > 1e-6) reasons.push("amount_more_than_2_decimals");
    const hits = amountTokens(ctx.body).filter((t) => t.cents === cents);
    if (hits.length === 0) reasons.push("amount_not_in_text");
    else if ((ctx.requireCurrencyMarker ?? true) && !hits.some((t) => t.marked)) reasons.push("amount_without_currency_marker");
  }

  // direction vs keywords. Missing or contradictory evidence is a rejection.
  const dir = p.direction;
  if (dir !== "in" && dir !== "out") reasons.push("direction_invalid");
  else {
    const kw = directionFromKeywords(ctx.body);
    if (kw === null) reasons.push(IN_WORDS.test(ctx.body) ? "direction_keywords_ambiguous" : "direction_no_keyword_evidence");
    else if (kw !== dir) reasons.push("direction_contradicts_keywords");
  }

  // date: plausible within +-1 day of receipt, and consistent with any date written in the body.
  if (typeof p.date !== "string") reasons.push("date_invalid");
  else {
    const day = parseProposalDay(p.date);
    if (day === null) reasons.push("date_unparseable");
    else {
      if (Math.abs(day - eatDayNumber(ctx.receivedAt)) > 1) reasons.push("date_outside_1_day_of_receipt");
      const written = bodyDays(ctx.body);
      if (written.length && !written.includes(day)) reasons.push("date_contradicts_text");
    }
  }

  // counterparty (optional): must be literally present, bounded, clean.
  if (p.counterparty !== undefined && p.counterparty !== null) {
    const c = p.counterparty;
    if (typeof c !== "string" || c.trim().length === 0 || c.length > 60 || CONTROL.test(c)) reasons.push("counterparty_invalid");
    else if (!norm(ctx.body).includes(norm(c))) reasons.push("counterparty_not_in_text");
  }

  // ref (optional): provider shape, verbatim in body.
  if (p.ref !== undefined && p.ref !== null) {
    const r = p.ref;
    const shape = REF_SHAPES[ctx.provider ?? "unknown"] ?? REF_SHAPES.unknown;
    if (typeof r !== "string" || !shape.test(r)) reasons.push("ref_wrong_shape");
    else if (!new RegExp(String.raw`(?<![A-Za-z0-9])${r}(?![A-Za-z0-9])`).test(ctx.body)) reasons.push("ref_not_in_text");
  }

  return { accepted: reasons.length === 0, reasons };
}
