/** Cause tools (WS5.6): matched comparisons and conditional rates with intervals. */
import type { DbAdapter } from "../db/migrate.js";
import { wilson } from "../detectors/stats.js";
import { selectorSql, type HabitSelector } from "../habits/selector.js";

export interface Selector { label?: string; item?: string; habitId?: number; selector?: HabitSelector }
export interface CauseEvent { id: number; at: number; amountCents: number }
export interface Factor {
  key: string; label: string; unit: string;
  eventValue: number; comparisonValue: number;
  lo: number; hi: number;
  nEvent: number; nComparison: number;
  /** True when the 95% interval excludes no difference. */
  separates: boolean;
  eventIds: number[]; comparisonIds: number[];
}
export interface AntecedentResult { nEvent: number; nComparison: number; factors: Factor[]; message: string | null }

function median(a: number[]): number { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; }

function medianCI(a: number[], b: number[]): { lo: number; hi: number; diff: number } {
  // Percentile bootstrap of the median difference, deterministic seed.
  let state = 12345;
  const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const diffs: number[] = [];
  for (let it = 0; it < 500; it++) {
    const sa: number[] = [], sb: number[] = [];
    for (let i = 0; i < a.length; i++) sa.push(a[Math.floor(rnd() * a.length)]!);
    for (let i = 0; i < b.length; i++) sb.push(b[Math.floor(rnd() * b.length)]!);
    diffs.push(median(sb) - median(sa));
  }
  diffs.sort((x, y) => x - y);
  const at = (q: number) => diffs[Math.max(0, Math.min(diffs.length - 1, Math.floor(q * (diffs.length - 1))))]!;
  return { lo: at(0.025), hi: at(0.975), diff: median(b) - median(a) };
}

export function selectEvents(db: DbAdapter, from: number, to: number, sel: Selector): CauseEvent[] {
  const where = [`t.role = 'transaction'`, `t.direction = 'out'`, `t.occurred_at >= ?`, `t.occurred_at < ?`];
  const params: unknown[] = [from, to];
  if (sel.label) where.push(`EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.tx_id=t.id AND tl.confirmed_at IS NOT NULL AND l.name=?)`), params.push(sel.label);
  if (sel.item) where.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id=ti.item_id WHERE ti.tx_id=t.id AND i.key=?)`), params.push(sel.item);
  if (sel.habitId != null) where.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id=ti.item_id WHERE ti.tx_id=t.id AND i.habit_id=?)`), params.push(sel.habitId);
  if (sel.selector) { const h = selectorSql(sel.selector); where.push(...h.where); params.push(...h.params); }
  return (db.all(`SELECT t.id, t.occurred_at AS at, t.amount FROM transactions t WHERE ${where.join(" AND ")} ORDER BY t.occurred_at`, params) as Array<Record<string, unknown>>)
    .map((r) => ({ id: Number(r.id), at: Number(r.at), amountCents: Number(r.amount) }));
}

const HOUR = 3_600_000, DAY = 86_400_000;

/** Event set vs the rest of the user's outflows in the same period, with 8-in-each-set guard. */
export function antecedents(db: DbAdapter, from: number, to: number, sel: Selector): AntecedentResult {
  const events = selectEvents(db, from, to, sel);
  const all = selectEvents(db, from, to, {});
  const eventIds = new Set(events.map((e) => e.id));
  const comparison = all.filter((e) => !eventIds.has(e.id));
  if (events.length < 8 || comparison.length < 8) {
    return { nEvent: events.length, nComparison: comparison.length, factors: [], message: `Not enough data yet (${events.length} events; need 8 in each set).` };
  }
  const labels = db.all(`SELECT DISTINCT l.name FROM labels l`) as Array<{ name: string }>;
  const groceries = labels.some((l) => l.name === "Groceries");
  const incomes = (db.all(`SELECT t.amount AS amount, t.occurred_at AS at FROM transactions t WHERE t.role='transaction' AND t.direction='in' ORDER BY t.occurred_at`) as Array<{ amount: number; at: number }>);
  const incomeCut = incomes.length ? [...incomes.map((i) => Number(i.amount))].sort((a, b) => a - b)[Math.floor(0.6 * incomes.length)]! : 0;
  const balances = db.all(`SELECT occurred_at AS at, balance_after AS b FROM transactions WHERE balance_after IS NOT NULL ORDER BY occurred_at`) as Array<{ at: number; b: number }>;
  const loans = db.all(`SELECT kind, amount, occurred_at AS at FROM transactions WHERE kind IN ('loan_draw','loan_repay') ORDER BY occurred_at`) as Array<{ kind: string; amount: number; at: number }>;
  const lastBefore = <T extends { at: number }>(rows: T[], at: number): T | null => {
    let lo = 0, hi = rows.length - 1, best: T | null = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid]!.at <= at) { best = rows[mid]!; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };
  const openFuliza = (at: number) => {
    let out = 0;
    for (const l of loans) { if (l.at > at) break; out += l.kind === "loan_draw" ? Number(l.amount) : -Number(l.amount); }
    return out > 0;
  };
  const groceriesRows = groceries ? (db.all(`SELECT t.occurred_at AS at FROM transactions t WHERE t.role='transaction' AND t.direction='out' AND EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.tx_id=t.id AND tl.confirmed_at IS NOT NULL AND l.name='Groceries') ORDER BY t.occurred_at`) as Array<{ at: number }>) : [];

  const metrics = (set: CauseEvent[]) => {
    const hoursGroceries: number[] = [], daysIncome: number[] = [], balance: number[] = [], fuliza: number[] = [];
    for (const e of set) {
      const g = lastBefore(groceriesRows, e.at);
      if (g) hoursGroceries.push((e.at - g.at) / HOUR);
      const inc = lastBefore(incomes.filter((i) => i.amount >= incomeCut), e.at);
      if (inc) daysIncome.push((e.at - inc.at) / DAY);
      const b = lastBefore(balances, e.at);
      if (b) balance.push(Number(b.b));
      fuliza.push(openFuliza(e.at) ? 1 : 0);
    }
    return { hoursGroceries, daysIncome, balance, fuliza };
  };
  const E = metrics(events), C = metrics(comparison);
  const factors: Factor[] = [];
  const addMedian = (key: string, label: string, unit: string, a: number[], b: number[], ids: number[], cmpIds: number[]) => {
    if (a.length < 8 || b.length < 8) return;
    const ci = medianCI(a, b);
    const separates = ci.lo > 0 || ci.hi < 0;
    if (!separates) return;
    factors.push({ key, label, unit, eventValue: median(a), comparisonValue: median(b), lo: ci.lo, hi: ci.hi, nEvent: a.length, nComparison: b.length, separates, eventIds: ids, comparisonIds: cmpIds });
  };
  addMedian("hours_since_groceries", "Hours since groceries", "hours", E.hoursGroceries, C.hoursGroceries, events.map((e) => e.id), comparison.map((e) => e.id));
  addMedian("days_since_income", "Days since money came in", "days", E.daysIncome, C.daysIncome, events.map((e) => e.id), comparison.map((e) => e.id));
  addMedian("wallet_before", "Wallet balance before", "cents", E.balance, C.balance, events.map((e) => e.id), comparison.map((e) => e.id));
  const rate = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  if (E.fuliza.length >= 8 && C.fuliza.length >= 8) {
    const e = rate(E.fuliza), c = rate(C.fuliza);
    const wiE = wilson(Math.round(e * E.fuliza.length), E.fuliza.length), wiC = wilson(Math.round(c * C.fuliza.length), C.fuliza.length);
    if (wiE.lo > wiC.hi || wiC.lo > wiE.hi) {
      factors.push({ key: "fuliza_open", label: "Fuliza already open", unit: "rate", eventValue: e, comparisonValue: c, lo: wiE.lo - wiC.hi, hi: wiE.hi - wiC.lo, nEvent: E.fuliza.length, nComparison: C.fuliza.length, separates: true, eventIds: events.map((x) => x.id), comparisonIds: comparison.map((x) => x.id) });
    }
  }
  return { nEvent: events.length, nComparison: comparison.length, factors, message: factors.length ? null : "No factor separates these events yet." };
}

export interface ConditionalResult {
  withCondition: { k: number; n: number; rate: number; lo: number; hi: number };
  withoutCondition: { k: number; n: number; rate: number; lo: number; hi: number };
  message: string;
}

/** "When groceries were bought in the previous 24h, late-night food happened …" */
export function conditionalRates(db: DbAdapter, from: number, to: number, outcome: Selector, condition: Selector, withinHours = 24): ConditionalResult {
  const outcomes = selectEvents(db, from, to, outcome);
  const conditions = selectEvents(db, from, to, condition).map((c) => c.at);
  let withK = 0, withN = 0, withoutK = 0, withoutN = 0;
  const start = from;
  const days = Math.max(1, Math.ceil((to - start) / DAY));
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY;
    const dayEnd = dayStart + DAY;
    const cond = conditions.some((c) => c >= dayStart - withinHours * HOUR && c < dayEnd);
    const hit = outcomes.some((o) => o.at >= dayStart && o.at < dayEnd);
    if (cond) { withN++; if (hit) withK++; } else { withoutN++; if (hit) withoutK++; }
  }
  const we = wilson(withK, withN), wo = wilson(withoutK, withoutN);
  return {
    withCondition: { k: withK, n: withN, rate: withN ? withK / withN : 0, lo: we.lo, hi: we.hi },
    withoutCondition: { k: withoutK, n: withoutN, rate: withoutN ? withoutK / withoutN : 0, lo: wo.lo, hi: wo.hi },
    message: `With ${condition.label ?? "the condition"} in the previous ${withinHours}h: ${withK} of ${withN}; otherwise ${withoutK} of ${withoutN}.`,
  };
}
