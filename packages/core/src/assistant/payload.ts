/**
 * Z2 payload builder (docs/plan/09 I-1, I-2, I-3). The ONLY producer of data that the assistant
 * client will send. Properties, all enforced in code and covered by tests:
 *
 *  I-1  `buildZ2Payload` is a pure function of (ledger, consent) returning a typed, frozen,
 *       registry-branded object. Rows are read inside this function, folded straight into
 *       aggregates and never serialised. The client rejects any object not issued here.
 *  I-2  Top-level categories only (<= MAX_CATEGORIES, rest folded into "Other"); amounts and
 *       counts are banded on a 1-2-5 log scale; month granularity; a (month, category, direction)
 *       cell with fewer than K events is dropped (never merged back into a released total, so it
 *       cannot be recovered by subtraction); no max/min/last transaction; size capped.
 *  I-3  Every string is from a closed vocabulary (seed category names, enums, months) or one of the
 *       user's own typed interview answers (sanitised, bounded, previewed before sending).
 *       Counterparty names, notes, refs, phone numbers, places and custom label names can never
 *       be reached: the SQL selects only direction, amount, time and the label NAME, and the label
 *       name is mapped through the closed seed taxonomy (anything else becomes "Other").
 */
import type { DbAdapter } from "../db/migrate.js";
import { SEED_LABELS } from "../labels/taxonomy.js";
import { canonicalJson, utf8Length } from "./json.js";

export const Z2_SCHEMA = "yako-z2/1" as const;
export const K_MIN = 5;
export const MAX_CATEGORIES = 15;
export const MAX_PAYLOAD_BYTES = 16_384;
export const MAX_GOALS = 10;
export const MAX_GOAL_CHARS = 200;
const EAT_MS = 3 * 3_600_000;

export type Direction = "in" | "out";
export type CadenceClass = "daily" | "weekly" | "monthly" | "sparse" | "irregular";

export interface Z2Cell {
  readonly month: string;
  readonly category: string;
  readonly direction: Direction;
  readonly count: string;
  readonly total: string;
  readonly median: string;
}
export interface Z2Goal { readonly id: string; readonly text: string }
export interface Z2Payload {
  readonly schema: typeof Z2_SCHEMA;
  readonly k: number;
  readonly window: { readonly from: string; readonly to: string };
  readonly cells: readonly Z2Cell[];
  readonly cadence: ReadonlyArray<{ readonly category: string; readonly direction: Direction; readonly cls: CadenceClass }>;
  readonly ratios: ReadonlyArray<{ readonly month: string; readonly outToIn: string }>;
  readonly goals: readonly Z2Goal[];
  /** Pack sections the model may fill in (closed vocabulary; the capability schema). */
  readonly capabilities: readonly string[];
}

export interface Z2Consent {
  granted: boolean;
  sessionId: string;
  /** The user's own typed interview answers. Sanitised; shown in the preview. */
  goals?: Array<{ id: string; text: string }>;
  /** Pack sections to advertise as capabilities. Defaults to the closed pack section list. */
  capabilities?: string[];
}
export interface Z2Options { now?: number; k?: number; months?: number; maxCategories?: number }

export class ConsentRequiredError extends Error {
  constructor() { super("consent_required: Z2 payloads need an explicit per-session grant"); this.name = "ConsentRequiredError"; }
}

// ----- registry: only payloads issued by buildZ2Payload are sendable --------------------------
const ISSUED = new WeakSet<object>();
export function isIssuedPayload(p: unknown): p is Z2Payload {
  return typeof p === "object" && p !== null && ISSUED.has(p);
}
/** Canonical wire/preview text for a payload. Throws if the object was not issued by the builder. */
export function serialiseZ2Payload(p: Z2Payload): string {
  if (!isIssuedPayload(p)) throw new Error("not_an_issued_z2_payload");
  return canonicalJson(p);
}
/** Dotted paths of every field present in the payload (I-11 field list). */
export function z2FieldList(p: Z2Payload): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, `${path}[]`); return; }
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); return; }
    out.add(path);
  };
  walk(p, "");
  return [...out].sort();
}

// ----- bands -----------------------------------------------------------------------------------
const EDGES_KES = [0, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
/** 1-2-5 log-scale band for an amount in KES cents. */
export function amountBand(cents: number): string {
  const kes = Math.max(0, cents) / 100;
  let idx = 0;
  for (let i = 0; i < EDGES_KES.length; i++) if (kes >= EDGES_KES[i]!) idx = i;
  if (idx === 0) return `<${EDGES_KES[1]}`;
  if (idx === EDGES_KES.length - 1) return `${EDGES_KES[idx]}+`;
  return `${EDGES_KES[idx]}-${EDGES_KES[idx + 1]! - 1}`;
}
export function countBand(n: number): string {
  if (n < 10) return "5-9";
  if (n < 20) return "10-19";
  if (n < 50) return "20-49";
  if (n < 100) return "50-99";
  return "100+";
}
export function ratioBand(r: number): string {
  if (!Number.isFinite(r) || r < 0) return "n/a";
  if (r < 0.5) return "<0.5";
  if (r < 0.9) return "0.5-0.9";
  if (r < 1.1) return "0.9-1.1";
  if (r < 1.5) return "1.1-1.5";
  return ">1.5";
}

// ----- closed category vocabulary -------------------------------------------------------------
const ROOTS = new Set(["Income", "Expenses", "Personal"]);
const SEED_PARENT = new Map(SEED_LABELS.map((l) => [l.name, l.parent] as const));
/** Roll a seed label up to its top-level category: a child whose parent is not a root folds into the parent (Fuel -> Transport). */
export function topCategory(name: string | null | undefined): string {
  if (!name) return "Unlabelled";
  if (!SEED_PARENT.has(name)) return "Other"; // custom label names never leave
  const parent = SEED_PARENT.get(name);
  return parent && !ROOTS.has(parent) ? parent : name;
}
export const CATEGORY_VOCAB: ReadonlySet<string> = new Set([...SEED_LABELS.map((l) => topCategory(l.name)), "Other", "Unlabelled"]);

export const PACK_SECTIONS = ["categories", "vocabulary", "budgets", "alerts", "widgets", "thresholds", "questions", "savings", "obligations"] as const;

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function sanitiseGoals(goals: Z2Consent["goals"]): Z2Goal[] {
  const out: Z2Goal[] = [];
  for (const g of goals ?? []) {
    if (out.length >= MAX_GOALS) break;
    const id = String(g?.id ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
    const text = String(g?.text ?? "").normalize("NFKC").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_GOAL_CHARS);
    if (id && text) out.push({ id, text });
  }
  return out;
}

const monthOf = (ms: number): string => {
  const d = new Date(ms + EAT_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
function windowMonths(now: number, n: number): string[] {
  const d = new Date(now + EAT_MS);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function cadenceOf(times: number[]): CadenceClass {
  const t = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push((t[i]! - t[i - 1]!) / 86_400_000);
  if (!gaps.length) return "sparse";
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  if (mean > 0 && sd / mean > 1.2) return "irregular";
  const m = median(gaps);
  if (m <= 1.5) return "daily";
  if (m <= 9) return "weekly";
  if (m <= 40) return "monthly";
  return "sparse";
}

interface Ev { month: string; category: string; direction: Direction; cents: number; at: number }

export function buildZ2Payload(db: DbAdapter, consent: Z2Consent, opts: Z2Options = {}): Z2Payload {
  if (!consent || consent.granted !== true || typeof consent.sessionId !== "string" || consent.sessionId.length === 0) throw new ConsentRequiredError();
  const now = opts.now ?? Date.now();
  const k = Math.max(K_MIN, Math.floor(opts.k ?? K_MIN)); // callers may raise k, never lower it
  const nMonths = Math.min(12, Math.max(1, Math.floor(opts.months ?? 6)));
  const maxCats = Math.min(MAX_CATEGORIES, Math.max(2, Math.floor(opts.maxCategories ?? MAX_CATEGORIES)));
  let months = windowMonths(now, nMonths);

  const [fy, fm] = months[0]!.split("-").map(Number) as [number, number];
  const fromMs = Date.UTC(fy, fm - 1, 1) - EAT_MS;
  // Only direction, amount, time and the label NAME are selected. Nothing else is reachable here.
  const rows = db.all(
    `SELECT t.direction AS direction, t.amount AS amount, t.occurred_at AS at, l.name AS label
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
          ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction IN ('in','out') AND t.occurred_at >= ? AND t.occurred_at <= ? AND t.amount > 0`,
    [fromMs, now],
  ) as Array<{ direction: Direction; amount: number; at: number; label: string | null }>;

  let evs: Ev[] = rows.map((r) => ({ month: monthOf(Number(r.at)), category: topCategory(r.label), direction: r.direction, cents: Number(r.amount), at: Number(r.at) }));

  // Category selection: whole-window event counts decide who survives; the rest become "Other".
  const perCat = new Map<string, number>();
  for (const e of evs) perCat.set(e.category, (perCat.get(e.category) ?? 0) + 1);
  const keep = [...perCat.entries()]
    .filter(([c, n]) => c !== "Other" && n >= k)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxCats - 1)
    .map(([c]) => c);
  const keepSet = new Set(keep);
  evs = evs.map((e) => (keepSet.has(e.category) ? e : { ...e, category: "Other" }));

  const cellMap = new Map<string, Ev[]>();
  for (const e of evs) {
    const key = `${e.month}|${e.category}|${e.direction}`;
    const a = cellMap.get(key);
    if (a) a.push(e); else cellMap.set(key, [e]);
  }
  const cells: Z2Cell[] = [];
  for (const [key, list] of cellMap) {
    if (list.length < k) continue; // k-suppression: dropped, never merged into anything released
    const [month, category, direction] = key.split("|") as [string, string, Direction];
    const total = list.reduce((s, e) => s + e.cents, 0);
    cells.push({ month, category, direction, count: countBand(list.length), total: amountBand(total), median: amountBand(median(list.map((e) => e.cents))) });
  }
  cells.sort((a, b) => (a.month + a.category + a.direction < b.month + b.category + b.direction ? -1 : 1));

  const cadence: Array<{ category: string; direction: Direction; cls: CadenceClass }> = [];
  const byCatDir = new Map<string, Ev[]>();
  for (const e of evs) {
    const key = `${e.category}|${e.direction}`;
    const a = byCatDir.get(key);
    if (a) a.push(e); else byCatDir.set(key, [e]);
  }
  for (const [key, list] of byCatDir) {
    if (list.length < k) continue;
    const [category, direction] = key.split("|") as [string, Direction];
    cadence.push({ category, direction, cls: cadenceOf(list.map((e) => e.at)) });
  }
  cadence.sort((a, b) => (a.category + a.direction < b.category + b.direction ? -1 : 1));

  const ratios: Array<{ month: string; outToIn: string }> = [];
  for (const m of months) {
    const inn = evs.filter((e) => e.month === m && e.direction === "in");
    const out = evs.filter((e) => e.month === m && e.direction === "out");
    if (inn.length < k || out.length < k) continue;
    const i = inn.reduce((s, e) => s + e.cents, 0);
    ratios.push({ month: m, outToIn: ratioBand(out.reduce((s, e) => s + e.cents, 0) / i) });
  }

  const goals = sanitiseGoals(consent.goals);
  const capabilities = (consent.capabilities ?? [...PACK_SECTIONS]).filter((c) => (PACK_SECTIONS as readonly string[]).includes(c)).sort();

  const assemble = (): Z2Payload => ({
    schema: Z2_SCHEMA, k,
    window: { from: months[0]!, to: months[months.length - 1]! },
    cells: cells.filter((c) => months.includes(c.month)),
    cadence, ratios: ratios.filter((r) => months.includes(r.month)),
    goals, capabilities,
  });
  let payload = assemble();
  while (utf8Length(canonicalJson(payload)) > MAX_PAYLOAD_BYTES && months.length > 1) {
    months = months.slice(1);
    payload = assemble();
  }
  if (utf8Length(canonicalJson(payload)) > MAX_PAYLOAD_BYTES) payload = { ...payload, goals: [], cells: [], ratios: [], cadence: [] };
  deepFreeze(payload);
  ISSUED.add(payload);
  return payload;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
