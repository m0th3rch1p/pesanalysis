/**
 * Personalization state, diff, dry-run, apply, rollback (docs/plan/09 I-6, I-7, I-8, I-13).
 *
 *   validatePack (pack-schema)  ->  materialize (pure)  ->  diff/dryRun (pure, on a COPY)
 *        -> applyPack (needs explicit user confirmation bound to the diff hash; atomic; versioned)
 *        -> rollbackLast (exact restore from the stored snapshot)
 *
 * Merge semantics are deliberately asymmetric so a pack cannot remove protections by omission:
 *   categories, vocabulary, budgets, questions, savings, obligations: section REPLACE (listed = new set)
 *   alerts, widgets, thresholds: MERGE BY ID (can add/toggle/retune within range; can never remove an id)
 * `DEFAULT_STATE` is the deterministic default personalization; no cloud model is ever required.
 */
import type { DbAdapter } from "../db/migrate.js";
import { sha256Hex } from "../util/sha256.js";
import { canonicalJson } from "./json.js";
import {
  ALERT_KINDS, SECTION_CAPS, SECTION_NAMES, SEED_CATEGORY_IDS, THRESHOLD_RANGES, WIDGET_IDS,
  type PackAlert, type PackBudget, type PackCategory, type PackObligation, type PackQuestion, type PackSaving,
  type PackVocab, type PackWidget, type PersonalizationPack, type SectionName, type ThresholdKey, validatePack,
} from "./pack-schema.js";
import { getAssistantState, setAssistantState } from "./tables.js";

export interface PersonalizationState {
  categories: PackCategory[];
  vocabulary: PackVocab[];
  budgets: PackBudget[];
  alerts: PackAlert[];
  widgets: PackWidget[];
  thresholds: Record<ThresholdKey, number>;
  questions: PackQuestion[];
  savings: PackSaving[];
  obligations: PackObligation[];
}

export const DEFAULT_STATE: Readonly<PersonalizationState> = Object.freeze({
  categories: [], vocabulary: [], budgets: [],
  alerts: ALERT_KINDS.map((k) => ({ kind: k, enabled: true })),
  widgets: WIDGET_IDS.map((w, i) => ({ id: w, order: i, enabled: true })),
  thresholds: Object.fromEntries(Object.entries(THRESHOLD_RANGES).map(([k, r]) => [k, r.def])) as Record<ThresholdKey, number>,
  questions: [], savings: [], obligations: [],
}) as Readonly<PersonalizationState>;

export const cloneState = (s: PersonalizationState): PersonalizationState => JSON.parse(JSON.stringify(s)) as PersonalizationState;
export const defaultState = (): PersonalizationState => cloneState(DEFAULT_STATE as PersonalizationState);
export const stateJson = (s: PersonalizationState): string => canonicalJson(s);
export const stateHash = (s: PersonalizationState): string => sha256Hex(stateJson(s));
export const packHash = (p: PersonalizationPack): string => sha256Hex(canonicalJson(p));

const clamp = (k: ThresholdKey, v: number): number => {
  const r = THRESHOLD_RANGES[k];
  const x = Number.isFinite(v) ? v : r.def;
  return Math.min(r.max, Math.max(r.min, x));
};

function mergeBy<T>(prev: T[], incoming: T[] | undefined, key: (x: T) => string): T[] {
  if (!incoming) return prev;
  const m = new Map(prev.map((x) => [key(x), x] as const));
  for (const x of incoming) m.set(key(x), x);
  return [...m.values()];
}
const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));

/** Pure: state + validated pack -> new state. Does not validate; callers validate first (applyPack does). */
export function materialize(state: PersonalizationState, pack: PersonalizationPack): PersonalizationState {
  const next = cloneState(state);
  if (pack.categories) next.categories = byId(pack.categories);
  if (pack.vocabulary) next.vocabulary = [...pack.vocabulary].sort((a, b) => (a.term < b.term ? -1 : 1));
  if (pack.budgets) next.budgets = byId(pack.budgets);
  if (pack.questions) next.questions = byId(pack.questions);
  if (pack.savings) next.savings = byId(pack.savings);
  if (pack.obligations) next.obligations = byId(pack.obligations);
  next.alerts = mergeBy(next.alerts, pack.alerts, (x) => x.kind).sort((a, b) => (a.kind < b.kind ? -1 : 1));
  next.widgets = mergeBy(next.widgets, pack.widgets, (x) => x.id).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  for (const t of pack.thresholds ?? []) next.thresholds[t.key] = clamp(t.key, t.value); // defence in depth: validator already range-checks
  for (const k of Object.keys(next.thresholds) as ThresholdKey[]) next.thresholds[k] = clamp(k, next.thresholds[k]);
  return next;
}

// ----- envelope and non-escalation -------------------------------------------------------------
/** Every capability token a state may ever hold. Constant: a pack cannot add to it. */
export const ENVELOPE: readonly string[] = [
  ...SECTION_NAMES.map((s) => `section:${s}`),
  ...ALERT_KINDS.map((a) => `alert:${a}`),
  ...WIDGET_IDS.map((w) => `widget:${w}`),
  ...Object.keys(THRESHOLD_RANGES).map((t) => `threshold:${t}`),
].sort();

/** Capability tokens actually present in a state (what it can currently influence). */
export function scopeOf(s: PersonalizationState): string[] {
  const out = new Set<string>();
  for (const name of SECTION_NAMES) {
    const v = (s as unknown as Record<string, unknown>)[name];
    if (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" && Object.keys(v).length > 0) out.add(`section:${name}`);
  }
  for (const a of s.alerts) out.add(`alert:${a.kind}`);
  for (const w of s.widgets) out.add(`widget:${w.id}`);
  for (const t of Object.keys(s.thresholds)) out.add(`threshold:${t}`);
  return [...out].sort();
}

function stateAsPack(s: PersonalizationState): Record<string, unknown> {
  return {
    schema: "yako-pack/1", title: "state",
    categories: s.categories, vocabulary: s.vocabulary, budgets: s.budgets, alerts: s.alerts, widgets: s.widgets,
    thresholds: Object.entries(s.thresholds).map(([key, value]) => ({ key, value })),
    questions: s.questions, savings: s.savings, obligations: s.obligations,
  };
}

/** True when the state would pass the same strict validator a pack does, with exactly the closed key set. */
export function withinEnvelope(s: PersonalizationState): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const keysNow = Object.keys(s).sort().join(",");
  if (keysNow !== [...SECTION_NAMES].sort().join(",")) reasons.push("state_keys_not_closed_set");
  for (const n of SECTION_NAMES) {
    const v = (s as unknown as Record<string, unknown>)[n];
    if (Array.isArray(v) && v.length > SECTION_CAPS[n]) reasons.push(`${n}:over_cap`);
  }
  const v = validatePack(stateAsPack(s));
  if (!v.accepted) reasons.push(...v.reasons.map((r) => `state:${r}`));
  return { ok: reasons.length === 0, reasons };
}

/** Next state must not widen scope or weaken protections relative to prev. */
export function checkNonEscalation(prev: PersonalizationState, next: PersonalizationState): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const w = withinEnvelope(next);
  if (!w.ok) reasons.push(...w.reasons);
  const env = new Set(ENVELOPE);
  for (const tok of scopeOf(next)) if (!env.has(tok)) reasons.push(`scope_widened:${tok}`);
  const prevScope = new Set(scopeOf(prev));
  const nextScope = new Set(scopeOf(next));
  for (const tok of prevScope) if (tok.startsWith("alert:") || tok.startsWith("widget:") || tok.startsWith("threshold:")) if (!nextScope.has(tok)) reasons.push(`protection_removed:${tok}`);
  for (const k of Object.keys(THRESHOLD_RANGES) as ThresholdKey[]) {
    const r = THRESHOLD_RANGES[k];
    const x = next.thresholds[k];
    if (typeof x !== "number" || x < r.min || x > r.max) reasons.push(`threshold_outside_safe_range:${k}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ----- diff --------------------------------------------------------------------------------------
export interface DiffItem { section: SectionName; key: string; change: "added" | "changed" | "removed"; text: string }
export interface PackDiff {
  items: DiffItem[];
  counts: { added: number; changed: number; removed: number };
  empty: boolean;
  /** Hash of the exact change list. The user's confirmation is bound to this value. */
  hash: string;
}

const fmt = (n: number) => n.toLocaleString("en-US").replace(/\u00a0/g, ",");
function describe(section: SectionName, x: Record<string, unknown>): string {
  switch (section) {
    case "categories": return `category "${x.label}" (${x.kind}${x.baseLabel ? `, based on ${x.baseLabel}` : ""})`;
    case "vocabulary": return `word "${x.term}" counts as ${x.category}`;
    case "budgets": return `budget for ${x.category}: ${fmt(Number(x.amountKes))} KES per ${x.period}`;
    case "alerts": return `alert ${x.kind} is ${x.enabled ? "on" : "off"}`;
    case "widgets": return `home item ${x.id} at position ${Number(x.order) + 1}, ${x.enabled ? "shown" : "hidden"}`;
    case "questions": return `question "${x.prompt}"`;
    case "savings": return `savings pot "${x.name}"${x.targetKes ? ` (target ${fmt(Number(x.targetKes))} KES)` : ""}`;
    case "obligations": return `regular payment "${x.name}": ${fmt(Number(x.amountKes))} KES ${x.cadence}${x.dueDay ? ` on day ${x.dueDay}` : ""}`;
    default: return JSON.stringify(x);
  }
}
const itemKey = (section: SectionName, x: Record<string, unknown>): string => String(section === "vocabulary" ? x.term : section === "alerts" ? x.kind : x.id);

function fieldChanges(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonicalJson(a[k]) !== canonicalJson(b[k])) out.push(`${k}: ${a[k] === undefined ? "none" : JSON.stringify(a[k])} -> ${b[k] === undefined ? "none" : JSON.stringify(b[k])}`);
  }
  return out.join("; ");
}

export function diffStates(before: PersonalizationState, after: PersonalizationState): PackDiff {
  const items: DiffItem[] = [];
  const listSections: Exclude<SectionName, "thresholds">[] = ["categories", "vocabulary", "budgets", "alerts", "widgets", "questions", "savings", "obligations"];
  for (const section of listSections) {
    const a = new Map((before[section] as unknown as Array<Record<string, unknown>>).map((x) => [itemKey(section, x), x] as const));
    const b = new Map((after[section] as unknown as Array<Record<string, unknown>>).map((x) => [itemKey(section, x), x] as const));
    for (const [k, x] of b) {
      const old = a.get(k);
      if (!old) items.push({ section, key: k, change: "added", text: `Add ${describe(section, x)}` });
      else if (canonicalJson(old) !== canonicalJson(x)) {
        const renamed = section === "categories" && old.label !== x.label ? `Rename category "${old.label}" to "${x.label}"; ` : "";
        items.push({ section, key: k, change: "changed", text: `Change ${describe(section, old)}: ${renamed}${fieldChanges(old, x)}` });
      }
    }
    for (const [k, x] of a) if (!b.has(k)) items.push({ section, key: k, change: "removed", text: `Remove ${describe(section, x)}` });
  }
  for (const k of Object.keys(THRESHOLD_RANGES) as ThresholdKey[]) {
    if (before.thresholds[k] !== after.thresholds[k]) items.push({ section: "thresholds", key: k, change: "changed", text: `Change threshold ${k}: ${fmt(before.thresholds[k])} -> ${fmt(after.thresholds[k])}` });
  }
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const i of items) counts[i.change]++;
  return { items, counts, empty: items.length === 0, hash: sha256Hex(canonicalJson(items)) };
}

export function diffPack(state: PersonalizationState, pack: PersonalizationPack): PackDiff {
  return diffStates(state, materialize(state, pack));
}

/** Plain-language rendering with counts and up to `examples` lines per kind of change. */
export function renderDiff(diff: PackDiff, examples = 3): string {
  if (diff.empty) return "No changes. Nothing will be modified.";
  const lines = [`This will add ${diff.counts.added}, change ${diff.counts.changed} and remove ${diff.counts.removed} setting(s).`];
  for (const kind of ["added", "changed", "removed"] as const) {
    const xs = diff.items.filter((i) => i.change === kind);
    if (!xs.length) continue;
    lines.push(`${kind[0]!.toUpperCase()}${kind.slice(1)} (${xs.length}):`);
    for (const x of xs.slice(0, examples)) lines.push(`  - ${x.text}`);
    if (xs.length > examples) lines.push(`  ...and ${xs.length - examples} more`);
  }
  return lines.join("\n");
}

// ----- dry run ------------------------------------------------------------------------------------
/** A local ledger row reduced to what the replay needs. Used on-device only; never sent. */
export interface ReplayRow { month: string; category: string; amountCents: number; direction: "in" | "out" }
export interface ReplayEffects {
  largeSpend: { before: number; after: number };
  /** Months over budget in the replay window, per monthly budget (week budgets are not replayed). */
  budgetBreaches: Array<{ budgetId: string; before: number; after: number }>;
}
export interface DryRun {
  ok: boolean;
  reasons: string[];
  before: PersonalizationState;
  after: PersonalizationState;
  diff: PackDiff;
  effects?: ReplayEffects;
}

const slugName = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function replayEffects(before: PersonalizationState, after: PersonalizationState, rows: ReplayRow[]): ReplayEffects {
  const spend = rows.filter((r) => r.direction === "out");
  const large = (s: PersonalizationState) => {
    const alert = s.alerts.find((a) => a.kind === "large_spend");
    if (!alert?.enabled) return 0;
    return spend.filter((r) => r.amountCents / 100 >= s.thresholds.large_spend_kes).length;
  };
  const breaches = (s: PersonalizationState, b: PackBudget): number => {
    if (b.period !== "month") return 0;
    const cat = s.categories.find((c) => c.id === b.category);
    const want = new Set([b.category, ...(cat?.baseLabel ? [slugName(cat.baseLabel)] : [])]);
    const perMonth = new Map<string, number>();
    for (const r of spend) if (want.has(slugName(r.category))) perMonth.set(r.month, (perMonth.get(r.month) ?? 0) + r.amountCents);
    return [...perMonth.values()].filter((c) => c / 100 > b.amountKes).length;
  };
  const ids = new Set([...before.budgets, ...after.budgets].map((b) => b.id));
  return {
    largeSpend: { before: large(before), after: large(after) },
    budgetBreaches: [...ids].sort().map((id) => {
      const b0 = before.budgets.find((b) => b.id === id), b1 = after.budgets.find((b) => b.id === id);
      return { budgetId: id, before: b0 ? breaches(before, b0) : 0, after: b1 ? breaches(after, b1) : 0 };
    }),
  };
}

/** Apply to a COPY. The input state is never mutated. */
export function dryRun(state: PersonalizationState, pack: unknown, opts: { rows?: ReplayRow[] } = {}): DryRun {
  const before = cloneState(state);
  const v = validatePack(pack, { existingCategoryIds: state.categories.map((c) => c.id) });
  if (!v.accepted || !v.pack) return { ok: false, reasons: v.reasons, before, after: cloneState(state), diff: diffStates(state, state) };
  const after = materialize(state, v.pack);
  const ne = checkNonEscalation(state, after);
  const integrity = integrityIssues(after);
  const diff = diffStates(before, after);
  const reasons = [...ne.reasons, ...integrity];
  return { ok: reasons.length === 0, reasons, before, after, diff, effects: opts.rows ? replayEffects(before, after, opts.rows) : undefined };
}

/** Dangling references after a merge/replace. */
export function integrityIssues(s: PersonalizationState): string[] {
  const ids = new Set<string>([...SEED_CATEGORY_IDS, ...s.categories.map((c) => c.id)]);
  const out: string[] = [];
  for (const v of s.vocabulary) if (!ids.has(v.category)) out.push(`dangling_category:vocabulary:${v.term}`);
  for (const b of s.budgets) if (!ids.has(b.category)) out.push(`dangling_category:budget:${b.id}`);
  return out;
}

// ----- persistence: state, history, apply, rollback --------------------------------------------
const STATE_KEY = "personalization";

export function loadState(db: DbAdapter): PersonalizationState {
  const raw = getAssistantState(db, STATE_KEY);
  if (!raw) return defaultState();
  try {
    const s = JSON.parse(raw) as PersonalizationState;
    return withinEnvelope(s).ok ? s : defaultState(); // a tampered/corrupt row falls back to the deterministic default
  } catch { return defaultState(); }
}
function saveState(db: DbAdapter, s: PersonalizationState, now: number): void {
  setAssistantState(db, STATE_KEY, stateJson(s), now);
}

export interface HistoryRow {
  version: number; contentHash: string; parentHash: string | null; title: string; summary: string;
  appliedAt: number; rolledBackAt: number | null;
}
export function listHistory(db: DbAdapter): HistoryRow[] {
  return db.all(
    `SELECT version, content_hash AS contentHash, parent_hash AS parentHash, title, summary, applied_at AS appliedAt, rolled_back_at AS rolledBackAt
       FROM pack_history ORDER BY version`,
  ) as HistoryRow[];
}

/** The user's explicit confirmation, produced only by the UI after showing the diff (I-7, I-13). */
export interface PackConfirmation { confirmed: true; origin: "user_ui"; diffHash: string }

export type ApplyResult =
  | { ok: true; version: number; contentHash: string; diffHash: string }
  | { ok: false; reasons: string[] };

export interface ApplyOptions {
  now?: number;
  /** TEST SEAM: invoked after history+state are written, before commit. Throwing simulates a mid-apply failure. */
  beforeCommit?: () => void;
}

export function applyPack(db: DbAdapter, packInput: unknown, confirmation: PackConfirmation, opts: ApplyOptions = {}): ApplyResult {
  const now = opts.now ?? Date.now();
  if (!confirmation || confirmation.confirmed !== true || confirmation.origin !== "user_ui" || typeof confirmation.diffHash !== "string") {
    return { ok: false, reasons: ["not_confirmed_by_user"] };
  }
  const state = loadState(db);
  const v = validatePack(packInput, { existingCategoryIds: state.categories.map((c) => c.id) });
  if (!v.accepted || !v.pack) return { ok: false, reasons: v.reasons };
  const pack = v.pack;
  const next = materialize(state, pack);
  const ne = checkNonEscalation(state, next);
  const integrity = integrityIssues(next);
  if (!ne.ok || integrity.length) return { ok: false, reasons: [...ne.reasons, ...integrity] };
  const diff = diffStates(state, next);
  if (diff.empty) return { ok: false, reasons: ["no_change"] };
  if (diff.hash !== confirmation.diffHash) return { ok: false, reasons: ["diff_changed_since_preview"] };

  const sp = "pack_apply";
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const last = db.get(`SELECT COALESCE(MAX(version), 0) AS v FROM pack_history`) as { v: number };
    const version = Number(last.v) + 1;
    const contentHash = packHash(pack);
    db.run(
      `INSERT INTO pack_history (version, content_hash, parent_hash, title, pack_json, state_before, state_after, summary, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [version, contentHash, stateHash(state), pack.title, canonicalJson(pack), stateJson(state), stateJson(next), renderDiff(diff, 50), now],
    );
    saveState(db, next, now);
    opts.beforeCommit?.();
    db.exec(`RELEASE ${sp}`);
    return { ok: true, version, contentHash, diffHash: diff.hash };
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); } finally { db.exec(`RELEASE ${sp}`); }
    return { ok: false, reasons: [`apply_failed_rolled_back:${e instanceof Error ? e.message.slice(0, 80) : "error"}`] };
  }
}

export type RollbackResult =
  | { ok: true; version: number; restoredStateHash: string; drift: boolean }
  | { ok: false; reasons: string[] };

/** One-tap rollback of the most recent applied pack: restores the stored "before" snapshot byte for byte. */
export function rollbackLast(db: DbAdapter, now = Date.now()): RollbackResult {
  const row = db.get(`SELECT version, state_before, state_after FROM pack_history WHERE rolled_back_at IS NULL ORDER BY version DESC LIMIT 1`) as
    | { version: number; state_before: string; state_after: string } | undefined;
  if (!row) return { ok: false, reasons: ["nothing_to_roll_back"] };
  let before: PersonalizationState;
  try { before = JSON.parse(row.state_before) as PersonalizationState; } catch { return { ok: false, reasons: ["snapshot_corrupt"] }; }
  if (!withinEnvelope(before).ok) return { ok: false, reasons: ["snapshot_outside_envelope"] };
  const drift = stateJson(loadState(db)) !== row.state_after;
  const sp = "pack_rollback";
  db.exec(`SAVEPOINT ${sp}`);
  try {
    setAssistantState(db, STATE_KEY, row.state_before, now);
    db.run(`UPDATE pack_history SET rolled_back_at = ? WHERE version = ?`, [now, row.version]);
    db.exec(`RELEASE ${sp}`);
    return { ok: true, version: Number(row.version), restoredStateHash: sha256Hex(row.state_before), drift };
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); } finally { db.exec(`RELEASE ${sp}`); }
    return { ok: false, reasons: [`rollback_failed:${e instanceof Error ? e.message.slice(0, 80) : "error"}`] };
  }
}

/** Read the local ledger into replay rows (on-device only). */
export function loadReplayRows(db: DbAdapter, now: number, months = 6): ReplayRow[] {
  const from = now - months * 31 * 86_400_000;
  const rows = db.all(
    `SELECT t.direction AS direction, t.amount AS amount, t.occurred_at AS at, l.name AS label
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
          ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction IN ('in','out') AND t.occurred_at >= ? AND t.occurred_at <= ?`,
    [from, now],
  ) as Array<{ direction: "in" | "out"; amount: number; at: number; label: string | null }>;
  return rows.map((r) => {
    const d = new Date(Number(r.at) + 3 * 3_600_000);
    return { month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, category: r.label ?? "unlabelled", amountCents: Number(r.amount), direction: r.direction };
  });
}
