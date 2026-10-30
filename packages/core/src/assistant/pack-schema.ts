/**
 * Personalization pack: schema, strict validator (docs/plan/09 I-6). A pack is typed JSON from an
 * untrusted source (a model, a paste). It is DATA: it can fill a closed set of preference sections
 * and nothing else. Validation is allowlist-based, never throws, and returns a normalised copy so
 * downstream code only ever sees values that passed.
 *
 * Cannot be expressed at all (unknown key => reject, with a specific reason when the key names a
 * protected area): zones, permissions, connectors, network/endpoints, backup/encryption, tariffs,
 * safety alerts (balance_break, spoof, scam), notification redaction, the pack mechanism itself.
 * Strings: NFKC, Latin letters/digits/limited punctuation only (no confusable scripts, no markup,
 * no control or bidi characters), no URLs, no prompt-injection phrasing. No user-supplied regex:
 * vocabulary terms are literal.
 */
import { SEED_LABELS } from "../labels/taxonomy.js";
import { StrictJsonError, canonicalJson, strictParseJson, utf8Length } from "./json.js";

export const PACK_SCHEMA_ID = "yako-pack/1" as const;
export const MAX_PACK_BYTES = 32_768;

export const ALERT_KINDS = ["large_spend", "budget_warn", "weekly_digest", "income_late", "bill_due"] as const;
export const WIDGET_IDS = ["today", "float", "budgets", "savings", "debts", "insights", "expected", "journal"] as const;
export const THRESHOLD_RANGES = {
  large_spend_kes: { min: 500, max: 200_000, def: 10_000 },
  budget_warn_pct: { min: 50, max: 95, def: 80 },
  income_late_days: { min: 1, max: 14, def: 3 },
  bill_due_lead_days: { min: 1, max: 14, def: 3 },
} as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type WidgetId = (typeof WIDGET_IDS)[number];
export type ThresholdKey = keyof typeof THRESHOLD_RANGES;

export const SECTION_CAPS = { categories: 30, vocabulary: 100, budgets: 20, alerts: 12, widgets: 12, thresholds: 8, questions: 10, savings: 5, obligations: 10 } as const;
export type SectionName = keyof typeof SECTION_CAPS;
export const SECTION_NAMES = Object.keys(SECTION_CAPS) as SectionName[];

export interface PackCategory { id: string; label: string; kind: "spending" | "income"; baseLabel?: string }
export interface PackVocab { term: string; category: string }
export interface PackBudget { id: string; category: string; amountKes: number; period: "week" | "month" }
/** One entry per kind (keyed by `kind`): a pack can toggle a convenience alert, never add a second one or a new kind. */
export interface PackAlert { kind: AlertKind; enabled: boolean }
export interface PackWidget { id: WidgetId; order: number; enabled: boolean }
export interface PackThreshold { key: ThresholdKey; value: number }
export interface PackQuestion { id: string; prompt: string; kind: "choice" | "number" | "text"; options?: string[] }
export interface PackSaving { id: string; name: string; targetKes?: number }
export interface PackObligation { id: string; name: string; amountKes: number; cadence: "weekly" | "monthly" | "yearly"; dueDay?: number }

export interface PersonalizationPack {
  schema: typeof PACK_SCHEMA_ID;
  title: string;
  summary?: string;
  categories?: PackCategory[];
  vocabulary?: PackVocab[];
  budgets?: PackBudget[];
  alerts?: PackAlert[];
  widgets?: PackWidget[];
  thresholds?: PackThreshold[];
  questions?: PackQuestion[];
  savings?: PackSaving[];
  obligations?: PackObligation[];
}

export interface PackVerdict { accepted: boolean; reasons: string[]; pack?: PersonalizationPack }

// ----- vocab / reserved names ------------------------------------------------------------------
const slugify = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const ROOT_NAMES = new Set(["Income", "Expenses", "Personal"]);
export const SEED_CATEGORY_IDS: ReadonlySet<string> = new Set(SEED_LABELS.filter((l) => !ROOT_NAMES.has(l.name)).map((l) => slugify(l.name)));
const SEED_BY_NAME = new Map(SEED_LABELS.map((l) => [l.name, l] as const));
const rootOf = (name: string): string => {
  let cur = SEED_BY_NAME.get(name);
  while (cur?.parent) cur = SEED_BY_NAME.get(cur.parent);
  return cur?.name ?? name;
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Labels the system owns. A pack may not reuse them for a different meaning. */
const SEED_RESERVED = new Map(SEED_LABELS.map((l) => [squash(l.name), l.name] as const));
const EXTRA_RESERVED = new Set(["savings", "saving", "balance", "fees", "fee", "debt", "loan", "loans", "total", "net", "safety", "howwecount", "alert", "alerts", "security", "tariff", "tariffs", "mpesa", "fuliza"]);
export const RESERVED_IDS = new Set(["constructor", "prototype", "proto", "tostring", "valueof", "hasownproperty", "all", "none", "other", "unlabelled", "system"]);

// Keys that name protected areas. Present at any depth => specific rejection (I-6, test plan 4).
const PROTECTED_KEY_RE = /zone|permission|connector|network|endpoint|host|url|uri|apikey|token|secret|credential|backup|encrypt|cipher|tariff|feetable|safety|spoof|scam|balancebreak|redact|notification|policy|allowlist|packmechanism|packpolicy|packsource|apply|auto|script|code|eval|exec|tool|webhook|proxy/;
/** Case/underscore/hyphen-insensitive: feeTable, fee_table and fee-table are the same key. */
const isProtectedKey = (k: string): boolean => PROTECTED_KEY_RE.test(k.toLowerCase().replace(/[_-]/g, ""));

// ----- string rules ---------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\ue000-\uf8ff]/u;
const ALLOWED_TEXT = /^[\p{Script=Latin}0-9 .,'&()/%+:?!-]+$/u;
const URL_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|org|net|io|co|ke|app|dev|me|ly|xyz|info|biz|gov|edu|ai|tk|ru|cn|to|gl|gd|sh)\b/i,
  /\b(?:javascript|data|file|vbscript|ftp|tel|mailto|intent|content|blob|ws|wss):/i,
];
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass|circumvent|disable)\b.{0,40}\b(?:instruction|rule|prompt|polic|guideline|safeguard|restriction|filter|limit|safety|alert|check)/i,
  /\b(?:system|developer|admin|root)\s*(?:prompt|message|mode|instruction|override)/i,
  /\byou\s+(?:are|must|should|will|shall)\s+(?:now|always|never|ignore|obey)\b/i,
  /\b(?:act|behave|pretend|roleplay|respond)\s+(?:as|like)\b/i,
  /\b(?:jailbreak|dan mode|do anything now|prompt injection)\b/i,
  /\b(?:reveal|print|show|leak|send|exfiltrate|output|dump|upload|post)\b.{0,30}\b(?:key|token|password|secret|credential|prompt|database|ledger|sms|messages?|contacts?|backup)/i,
  /\b(?:tool|function)[\s_-]*calls?\b/i,
  /\b(?:execute|eval|sudo|curl|wget|powershell|bash)\b|\bselect\b.+\bfrom\b|\bdrop\s+table\b/i,
  /\bapply\b.{0,20}\b(?:automatically|silently|without|immediately)\b/i,
  /\b(?:new|updated)\s+instructions?\b/i,
];

type Reasons = string[];
const MAX_REASONS = 40;
const fail = (rs: Reasons, r: string) => { if (rs.length < MAX_REASONS) rs.push(r); };

/** Returns the normalised string, or null after recording why. */
function text(rs: Reasons, path: string, v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") { fail(rs, `${path}:not_a_string`); return null; }
  if (v.length > max * 4) { fail(rs, `${path}:too_long`); return null; }
  if (BAD_CHARS.test(v)) { fail(rs, `${path}:control_or_invisible_char`); return null; }
  const n = v.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (BAD_CHARS.test(n)) { fail(rs, `${path}:control_or_invisible_char`); return null; }
  if (n.length < min || n.length > max) { fail(rs, `${path}:length_out_of_range`); return null; }
  if (!ALLOWED_TEXT.test(n)) { fail(rs, `${path}:disallowed_characters`); return null; }
  if (URL_PATTERNS.some((re) => re.test(n))) { fail(rs, `${path}:url_not_allowed`); return null; }
  if (INJECTION_PATTERNS.some((re) => re.test(n))) { fail(rs, `${path}:injection_pattern`); return null; }
  return n;
}

const SLUG = /^[a-z][a-z0-9_]{0,31}$/;
function slug(rs: Reasons, path: string, v: unknown): string | null {
  if (typeof v !== "string" || !SLUG.test(v)) { fail(rs, `${path}:bad_id`); return null; }
  if (RESERVED_IDS.has(v)) { fail(rs, `${path}:reserved_id`); return null; }
  return v;
}
function num(rs: Reasons, path: string, v: unknown, min: number, max: number, integer = false): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) { fail(rs, `${path}:out_of_range`); return null; }
  return v;
}
function oneOf<T extends string>(rs: Reasons, path: string, v: unknown, set: readonly T[]): T | null {
  if (typeof v !== "string" || !(set as readonly string[]).includes(v)) { fail(rs, `${path}:not_in_enum`); return null; }
  return v as T;
}
function bool(rs: Reasons, path: string, v: unknown): boolean | null {
  if (typeof v !== "boolean") { fail(rs, `${path}:not_boolean`); return null; }
  return v;
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Closed key set. Unknown keys are rejected; protected-area names get a specific reason. */
function keys(rs: Reasons, path: string, o: Record<string, unknown>, allowed: readonly string[]): boolean {
  let ok = true;
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    ok = false;
    fail(rs, `${isProtectedKey(k) || /^__|constructor|prototype/.test(k) ? "forbidden_field" : "unknown_key"}:${path ? `${path}.` : ""}${k}`);
  }
  return ok;
}
function list(rs: Reasons, name: SectionName, v: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(v)) { fail(rs, `${name}:not_an_array`); return null; }
  if (v.length > SECTION_CAPS[name]) { fail(rs, `${name}:too_many_items`); return null; }
  const out: Array<Record<string, unknown>> = [];
  v.forEach((it, i) => { if (isPlain(it)) out.push(it); else fail(rs, `${name}[${i}]:not_an_object`); });
  return out.length === v.length ? out : null;
}
function unique(rs: Reasons, name: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) fail(rs, `${name}:duplicate_id`);
}

export interface ValidateContext {
  /** Category ids that already exist in the user's state (so references can resolve). */
  existingCategoryIds?: readonly string[];
}

/** Validate an already-parsed value. Never throws. */
export function validatePack(input: unknown, ctx: ValidateContext = {}): PackVerdict {
  const rs: Reasons = [];
  try {
    return validateInner(input, ctx, rs);
  } catch (e) {
    return { accepted: false, reasons: [`internal_validation_error:${e instanceof Error ? e.name : "unknown"}`] };
  }
}

function validateInner(input: unknown, ctx: ValidateContext, rs: Reasons): PackVerdict {
  if (!isPlain(input)) return { accepted: false, reasons: ["pack_not_an_object"] };
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return { accepted: false, reasons: ["pack_not_plain_object"] };
  let size: number;
  try { size = utf8Length(canonicalJson(input)); } catch { return { accepted: false, reasons: ["pack_not_serialisable"] }; }
  if (size > MAX_PACK_BYTES) return { accepted: false, reasons: ["pack_too_large"] };
  if (depth(input) > 6) return { accepted: false, reasons: ["pack_too_deep"] };

  keys(rs, "", input, ["schema", "title", "summary", ...SECTION_NAMES]);
  if (input.schema !== PACK_SCHEMA_ID) fail(rs, "schema:unsupported");
  const out: PersonalizationPack = { schema: PACK_SCHEMA_ID, title: "" };
  out.title = text(rs, "title", input.title, 2, 60) ?? "";
  if (input.summary !== undefined) { const s = text(rs, "summary", input.summary, 0, 200); if (s !== null) out.summary = s; }

  // categories
  const catIds = new Set<string>([...SEED_CATEGORY_IDS, ...(ctx.existingCategoryIds ?? [])]);
  const packCatIds: string[] = [];
  if (input.categories !== undefined) {
    const items = list(rs, "categories", input.categories);
    const res: PackCategory[] = [];
    items?.forEach((it, i) => {
      const p = `categories[${i}]`;
      keys(rs, p, it, ["id", "label", "kind", "baseLabel"]);
      const id = slug(rs, `${p}.id`, it.id);
      const label = text(rs, `${p}.label`, it.label, 2, 32);
      const kind = oneOf(rs, `${p}.kind`, it.kind, ["spending", "income"] as const);
      let baseLabel: string | undefined;
      if (it.baseLabel !== undefined) {
        if (typeof it.baseLabel !== "string" || !SEED_BY_NAME.has(it.baseLabel) || ROOT_NAMES.has(it.baseLabel)) fail(rs, `${p}.baseLabel:not_a_system_label`);
        else baseLabel = it.baseLabel;
      }
      if (id && SEED_CATEGORY_IDS.has(id)) fail(rs, `${p}.id:collides_with_system_category`);
      if (label && kind) {
        const sq = squash(label);
        const seedName = SEED_RESERVED.get(sq);
        if (seedName !== undefined && baseLabel !== seedName) fail(rs, `${p}.label:reserved_label`);
        if (EXTRA_RESERVED.has(sq)) fail(rs, `${p}.label:reserved_label`);
        if (baseLabel) {
          const k = rootOf(baseLabel) === "Income" ? "income" : "spending";
          if (k !== kind) fail(rs, `${p}.kind:contradicts_base_label`);
        }
      }
      if (id && label && kind) { res.push(baseLabel ? { id, label, kind, baseLabel } : { id, label, kind }); packCatIds.push(id); }
    });
    unique(rs, "categories", packCatIds);
    if (items && res.length === items.length) out.categories = res;
  }
  for (const id of packCatIds) catIds.add(id);
  const refOk = (rs2: Reasons, path: string, v: unknown): string | null => {
    if (typeof v !== "string" || !catIds.has(v)) { fail(rs2, `${path}:unknown_category`); return null; }
    return v;
  };

  if (input.vocabulary !== undefined) {
    const items = list(rs, "vocabulary", input.vocabulary);
    const res: PackVocab[] = [];
    items?.forEach((it, i) => {
      const p = `vocabulary[${i}]`;
      keys(rs, p, it, ["term", "category"]);
      const term = text(rs, `${p}.term`, it.term, 2, 32);
      const category = refOk(rs, `${p}.category`, it.category);
      if (term && category) res.push({ term: term.toLowerCase(), category });
    });
    unique(rs, "vocabulary", res.map((r) => r.term));
    if (items && res.length === items.length) out.vocabulary = res;
  }

  if (input.budgets !== undefined) {
    const items = list(rs, "budgets", input.budgets);
    const res: PackBudget[] = [];
    items?.forEach((it, i) => {
      const p = `budgets[${i}]`;
      keys(rs, p, it, ["id", "category", "amountKes", "period"]);
      const id = slug(rs, `${p}.id`, it.id);
      const category = refOk(rs, `${p}.category`, it.category);
      const amountKes = num(rs, `${p}.amountKes`, it.amountKes, 1, 1_000_000);
      const period = oneOf(rs, `${p}.period`, it.period, ["week", "month"] as const);
      if (id && category && amountKes !== null && period) res.push({ id, category, amountKes, period });
    });
    unique(rs, "budgets", res.map((r) => r.id));
    if (items && res.length === items.length) out.budgets = res;
  }

  if (input.alerts !== undefined) {
    const items = list(rs, "alerts", input.alerts);
    const res: PackAlert[] = [];
    items?.forEach((it, i) => {
      const p = `alerts[${i}]`;
      keys(rs, p, it, ["kind", "enabled"]);
      if (typeof it.kind === "string" && /balance|spoof|scam|safety|fraud|break|security|sim|reversal|duplicate/i.test(it.kind)) fail(rs, `${p}.kind:safety_alert_not_packable`);
      const kind = oneOf(rs, `${p}.kind`, it.kind, ALERT_KINDS);
      const enabled = bool(rs, `${p}.enabled`, it.enabled);
      if (kind && enabled !== null) res.push({ kind, enabled });
    });
    unique(rs, "alerts", res.map((r) => r.kind));
    if (items && res.length === items.length) out.alerts = res;
  }

  if (input.widgets !== undefined) {
    const items = list(rs, "widgets", input.widgets);
    const res: PackWidget[] = [];
    items?.forEach((it, i) => {
      const p = `widgets[${i}]`;
      keys(rs, p, it, ["id", "order", "enabled"]);
      if (typeof it.id === "string" && /fee|how_we_count|howwecount|definition|safety|alert/i.test(it.id)) fail(rs, `${p}.id:protected_widget`);
      const id = oneOf(rs, `${p}.id`, it.id, WIDGET_IDS);
      const order = num(rs, `${p}.order`, it.order, 0, 99, true);
      const enabled = bool(rs, `${p}.enabled`, it.enabled);
      if (id && order !== null && enabled !== null) res.push({ id, order, enabled });
    });
    unique(rs, "widgets", res.map((r) => r.id));
    if (items && res.length === items.length) out.widgets = res;
  }

  if (input.thresholds !== undefined) {
    const items = list(rs, "thresholds", input.thresholds);
    const res: PackThreshold[] = [];
    items?.forEach((it, i) => {
      const p = `thresholds[${i}]`;
      keys(rs, p, it, ["key", "value"]);
      const key = oneOf(rs, `${p}.key`, it.key, Object.keys(THRESHOLD_RANGES) as ThresholdKey[]);
      if (key) {
        const r = THRESHOLD_RANGES[key];
        const value = num(rs, `${p}.value`, it.value, r.min, r.max, key !== "large_spend_kes");
        if (value !== null) res.push({ key, value });
      }
    });
    unique(rs, "thresholds", res.map((r) => r.key));
    if (items && res.length === items.length) out.thresholds = res;
  }

  if (input.questions !== undefined) {
    const items = list(rs, "questions", input.questions);
    const res: PackQuestion[] = [];
    items?.forEach((it, i) => {
      const p = `questions[${i}]`;
      keys(rs, p, it, ["id", "prompt", "kind", "options"]);
      const id = slug(rs, `${p}.id`, it.id);
      const prompt = text(rs, `${p}.prompt`, it.prompt, 3, 120);
      const kind = oneOf(rs, `${p}.kind`, it.kind, ["choice", "number", "text"] as const);
      let options: string[] | undefined;
      if (it.options !== undefined) {
        if (kind !== "choice") fail(rs, `${p}.options:only_for_choice`);
        else if (!Array.isArray(it.options) || it.options.length < 2 || it.options.length > 6) fail(rs, `${p}.options:count_out_of_range`);
        else {
          const o = it.options.map((x, j) => text(rs, `${p}.options[${j}]`, x, 1, 40));
          if (o.every((x): x is string => x !== null)) options = o;
        }
      } else if (kind === "choice") fail(rs, `${p}.options:required_for_choice`);
      if (id && prompt && kind && (kind !== "choice" || options)) res.push(options ? { id, prompt, kind, options } : { id, prompt, kind });
    });
    unique(rs, "questions", res.map((r) => r.id));
    if (items && res.length === items.length) out.questions = res;
  }

  if (input.savings !== undefined) {
    const items = list(rs, "savings", input.savings);
    const res: PackSaving[] = [];
    items?.forEach((it, i) => {
      const p = `savings[${i}]`;
      keys(rs, p, it, ["id", "name", "targetKes"]);
      const id = slug(rs, `${p}.id`, it.id);
      const name = text(rs, `${p}.name`, it.name, 2, 40);
      let targetKes: number | undefined;
      if (it.targetKes !== undefined) { const t = num(rs, `${p}.targetKes`, it.targetKes, 1, 100_000_000); if (t !== null) targetKes = t; }
      if (id && name && (it.targetKes === undefined || targetKes !== undefined)) res.push(targetKes !== undefined ? { id, name, targetKes } : { id, name });
    });
    unique(rs, "savings", res.map((r) => r.id));
    if (items && res.length === items.length) out.savings = res;
  }

  if (input.obligations !== undefined) {
    const items = list(rs, "obligations", input.obligations);
    const res: PackObligation[] = [];
    items?.forEach((it, i) => {
      const p = `obligations[${i}]`;
      keys(rs, p, it, ["id", "name", "amountKes", "cadence", "dueDay"]);
      const id = slug(rs, `${p}.id`, it.id);
      const name = text(rs, `${p}.name`, it.name, 2, 40);
      const amountKes = num(rs, `${p}.amountKes`, it.amountKes, 1, 10_000_000);
      const cadence = oneOf(rs, `${p}.cadence`, it.cadence, ["weekly", "monthly", "yearly"] as const);
      let dueDay: number | undefined;
      if (it.dueDay !== undefined) { const d = num(rs, `${p}.dueDay`, it.dueDay, 1, 31, true); if (d !== null) dueDay = d; }
      if (id && name && amountKes !== null && cadence && (it.dueDay === undefined || dueDay !== undefined)) {
        res.push(dueDay !== undefined ? { id, name, amountKes, cadence, dueDay } : { id, name, amountKes, cadence });
      }
    });
    unique(rs, "obligations", res.map((r) => r.id));
    if (items && res.length === items.length) out.obligations = res;
  }

  if (rs.length) return { accepted: false, reasons: rs };
  if (!out.title) return { accepted: false, reasons: ["title:missing"] };
  return { accepted: true, reasons: [], pack: out };
}

function depth(v: unknown, d = 0): number {
  if (d > 12) return d;
  if (Array.isArray(v)) return v.reduce((m: number, x) => Math.max(m, depth(x, d + 1)), d + 1);
  if (v && typeof v === "object") return Object.values(v).reduce((m: number, x) => Math.max(m, depth(x, d + 1)), d + 1);
  return d;
}

/** Parse untrusted pack TEXT (strict JSON: no duplicate keys, no __proto__, depth/size/node caps) then validate. Never throws. */
export function parsePack(textInput: string, ctx: ValidateContext = {}): PackVerdict {
  let v: unknown;
  try {
    v = strictParseJson(textInput, { maxBytes: MAX_PACK_BYTES, maxDepth: 6, maxNodes: 2_000 });
  } catch (e) {
    return { accepted: false, reasons: [`json:${e instanceof StrictJsonError ? e.code : "unparseable"}`] };
  }
  return validatePack(v, ctx);
}

/** Pull a JSON object out of model prose / a ``` fence. The result is still untrusted: pass it to `parsePack`. */
export function extractJsonObject(modelText: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(modelText);
  const body = fenced ? fenced[1]! : modelText;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}
