/**
 * Plan adherence: what was planned versus what actually happened.
 *
 * The plan is the set of expected flows and their occurrences. Every decided occurrence (matched,
 * partial, late or missed) is evidence of follow-through; upcoming and waived ones are excluded.
 * There is no single "score" that hides the trade-offs, so the summary exposes:
 *   - arrivalRate   share of decided occurrences that arrived at all (matched or partial)
 *   - onTimeRate    share of all decided occurrences matched within the flow's grace days
 *   - valueRatio    money received (capped at expected) / money expected, over decided occurrences
 *   - weightedRate  (onTime + 0.5*partial) / decided, the headline percentage with half credit for a
 *                   partial payment. Documented, deterministic and shown with its inputs.
 */
import type { DbAdapter } from "../db/migrate.js";
import type { DayStr } from "./eat.js";
import { type DelayStats, type OccState, delayStats } from "./matcher.js";
import { type FlowRow, budgetPace, listBudgets, listFlows, listOccurrences } from "./store.js";

export interface FlowAdherence {
  flowId: number;
  name: string;
  direction: "in" | "out";
  planned: number;
  matched: number;
  partial: number;
  late: number;
  missed: number;
  waived: number;
  /** matched with delay <= 0 (exactly on time) */
  onTime: number;
  /** matched with delay <= the flow's grace days */
  withinGrace: number;
  expectedCents: number;
  receivedCents: number;
  medianDelayDays: number | null;
  arrivalRate: number | null;
  onTimeRate: number | null;
  valueRatio: number | null;
  /** (onTime + 0.5*partial) / planned; null when nothing was decided */
  adherence: number | null;
}

export interface BudgetAdherence {
  budgetId: number;
  name: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  status: "on_track" | "near" | "over";
  projectedOverspendCents: number;
}

export interface AdherenceSummary {
  fromDay: DayStr;
  toDay: DayStr;
  planned: number;
  arrived: number;
  onTime: number;
  withinGrace: number;
  partial: number;
  late: number;
  missed: number;
  waived: number;
  onTimeRate: number | null;
  arrivalRate: number | null;
  valueRatio: number | null;
  /** Headline: within-grace arrival counts fully, partial half. Null when nothing was decided. */
  weightedRate: number | null;
  expectedCents: number;
  receivedCents: number;
  flows: FlowAdherence[];
  budgets: BudgetAdherence[];
}

/** An outcome has happened: matched, partially paid, or missed. `late` is still open and is shown separately. */
const decidedStates: OccState[] = ["matched", "partial", "missed"];

/** Per-flow adherence over a closed window of due dates. */
export function planAdherence(
  db: DbAdapter,
  opts: { fromDay: DayStr; toDay: DayStr; budgets?: boolean; now?: number },
): AdherenceSummary {
  const flows = new Map<number, FlowRow>(listFlows(db).map((f) => [f.id, f]));
  const allRows = listOccurrences(db, { fromDay: opts.fromDay, toDay: opts.toDay })
    .filter((o) => o.state !== "upcoming");
  const rows = allRows.filter((o) => decidedStates.includes(o.state) || o.state === "waived");

  const byFlow = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byFlow.get(r.flowId);
    if (list) list.push(r); else byFlow.set(r.flowId, [r]);
  }

  const out: FlowAdherence[] = [];
  let expectedCents = 0, receivedCents = 0;
  for (const [flowId, list] of byFlow) {
    const f = flows.get(flowId);
    if (!f) continue;
    const stats: DelayStats = delayStats(
      list.filter((o) => decidedStates.includes(o.state))
        .map((o) => ({ state: o.state, delayDays: o.delayDays, receivedCents: o.receivedCents, expectedCents: o.expectedCents })),
      f.graceDays ?? 1,
    );
    const planned = stats.decided;
    const openLate = list.filter((o) => o.state === "late").length;
    const onTime = list.filter((o) => o.state === "matched" && (o.delayDays ?? 0) <= 0).length;
    const withinGrace = list.filter((o) => o.state === "matched" && (o.delayDays ?? 0) <= (f.graceDays ?? 1)).length;
    const exp = list.filter((o) => decidedStates.includes(o.state)).reduce((a, o) => a + (o.expectedCents ?? 0), 0);
    const got = list.filter((o) => decidedStates.includes(o.state)).reduce((a, o) => a + Math.min(o.receivedCents, o.expectedCents ?? o.receivedCents), 0);
    expectedCents += exp; receivedCents += got;
    out.push({
      flowId, name: f.name, direction: f.direction,
      planned, matched: stats.counts.matched, partial: stats.counts.partial,
      late: openLate, missed: stats.counts.missed, waived: list.filter((o) => o.state === "waived").length, onTime, withinGrace,
      expectedCents: exp, receivedCents: got,
      medianDelayDays: stats.medianDelayDays,
      arrivalRate: stats.arrivalRate, onTimeRate: stats.onTimeRate,
      valueRatio: exp > 0 ? got / exp : null,
      adherence: planned > 0 ? (withinGrace + 0.5 * stats.counts.partial) / planned : null,
    });
  }
  out.sort((a, b) => b.planned - a.planned || a.name.localeCompare(b.name));

  const planned = out.reduce((a, r) => a + r.planned, 0);
  const arrived = out.reduce((a, r) => a + r.matched + r.partial, 0);
  const onTime = out.reduce((a, r) => a + r.onTime, 0);
  const withinGrace = out.reduce((a, r) => a + r.withinGrace, 0);
  const partial = out.reduce((a, r) => a + r.partial, 0);
  const late = out.reduce((a, r) => a + r.late, 0);
  const missed = out.reduce((a, r) => a + r.missed, 0);
  const waived = out.reduce((a, r) => a + r.waived, 0);
  const budgets: BudgetAdherence[] = opts.budgets === false ? [] : listBudgets(db).map((b) => {
    const p = budgetPace(db, b.id, opts.now ?? Date.now());
    const status = p.status === "over" ? "over" : p.status === "at_risk" ? "near" : "on_track";
    return {
      budgetId: b.id, name: b.name, limitCents: p.effectiveLimitCents, spentCents: p.spentCents,
      remainingCents: p.remainingCents, status, projectedOverspendCents: p.projectedOverspendCents,
    };
  });

  return {
    fromDay: opts.fromDay, toDay: opts.toDay,
    planned, arrived, onTime, withinGrace, partial, late, missed, waived,
    onTimeRate: planned ? onTime / planned : null,
    arrivalRate: planned ? arrived / planned : null,
    valueRatio: expectedCents > 0 ? receivedCents / expectedCents : null,
    weightedRate: planned ? (withinGrace + 0.5 * partial) / planned : null,
    expectedCents, receivedCents,
    flows: out,
    budgets,
  };
}

/** Plain verdict for the UI; deliberately qualitative, with the numbers shown next to it. */
export function adherenceVerdict(rate: number | null): "no_plan" | "faithful" | "mixed" | "drifted" {
  if (rate == null) return "no_plan";
  if (rate >= 0.8) return "faithful";
  if (rate >= 0.5) return "mixed";
  return "drifted";
}
