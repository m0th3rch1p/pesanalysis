/**
 * Float engine (F-FLOAT). Pure and deterministic: every output carries its inputs and a quality flag.
 *
 * free float      = wallet balance - virtual pots - obligations due within the horizon (overdue included) - budget reserve
 * safe to spend   = a range, never one number:
 *                     low  = free - p90 daily spend                        (no expected income counted)
 *                     mid  = free + reliability-weighted income due today (after any Fuliza sweep) - p90
 *                     high = free + full typical income due today (after sweep) - p50
 * days to zero    = day-by-day projection; "expected" uses median burn + weighted income, "pessimistic" uses p90 burn and no income.
 * sweep warning   = when Fuliza is outstanding, the next inflow repays it first; expected income loses that much.
 */
import { type DayStr, addDays, dayOf, diffDays } from "./eat.js";

export interface DueItem {
  name?: string;
  dueOn: DayStr;
  /** remaining cents to pay (obligation) or typical cents expected (income) */
  cents: number;
  /** income only: probability in [0,1] that it arrives (see delayStats.reliability). Default 1. */
  reliability?: number;
}

export interface FloatInput {
  nowMs: number;
  balanceCents: number | null;
  balanceAsOf: number | null;
  /** sum of balances of virtual (in-wallet) pots; they are earmarked, not free */
  potsCents?: number;
  obligations: DueItem[];
  expectedIncome: DueItem[];
  budgetReserveCents?: number;
  horizonDays?: number;
  dailySpendP50Cents?: number;
  dailySpendP90Cents?: number;
  fulizaOutstandingCents?: number;
  staleAfterHours?: number;
  projectionDays?: number;
}

export type FloatQuality = "ok" | "estimate" | "unknown";

export interface SweepWarning {
  outstandingCents: number;
  /** how much of the expected inflow within the horizon the sweep would absorb */
  expectedInflowAbsorbedCents: number;
  severity: "info" | "warn";
  message: string;
}

export interface FloatResult {
  quality: FloatQuality;
  balanceCents: number | null;
  balanceAsOf: number | null;
  balanceAgeHours: number | null;
  potsCents: number;
  obligationsDueCents: number;
  overdueCents: number;
  budgetReserveCents: number;
  freeFloatCents: number | null;
  safeToSpend: { lowCents: number; midCents: number; highCents: number; confidence: "high" | "medium" | "low" } | null;
  daysToZero: { expected: number | null; pessimistic: number | null };
  sweep: SweepWarning | null;
  horizonDays: number;
  inputs: { obligations: number; expectedIncome: number };
}

const clamp0 = (n: number) => Math.max(0, n);

export function computeFloat(i: FloatInput): FloatResult {
  const horizon = i.horizonDays ?? 7;
  const today = dayOf(i.nowMs);
  const horizonEnd = addDays(today, horizon);
  const pots = clamp0(i.potsCents ?? 0);
  const reserve = clamp0(i.budgetReserveCents ?? 0);
  const staleH = i.staleAfterHours ?? 36;
  const p50 = clamp0(i.dailySpendP50Cents ?? 0);
  const p90 = Math.max(p50, clamp0(i.dailySpendP90Cents ?? 0));
  const fuliza = clamp0(i.fulizaOutstandingCents ?? 0);

  const due = i.obligations.filter((o) => o.cents > 0 && o.dueOn <= horizonEnd);
  const obligationsDue = due.reduce((a, o) => a + o.cents, 0);
  const overdue = due.filter((o) => o.dueOn < today).reduce((a, o) => a + o.cents, 0);

  const age = i.balanceAsOf == null ? null : (i.nowMs - i.balanceAsOf) / 3_600_000;
  const quality: FloatQuality = i.balanceCents == null ? "unknown" : age != null && age > staleH ? "estimate" : "ok";

  // Fuliza sweep
  const inflowHorizon = i.expectedIncome.filter((x) => x.dueOn <= horizonEnd).reduce((a, x) => a + x.cents, 0);
  const sweep: SweepWarning | null = fuliza > 0
    ? {
        outstandingCents: fuliza,
        expectedInflowAbsorbedCents: Math.min(fuliza, inflowHorizon),
        severity: inflowHorizon > 0 ? "warn" : "info",
        message: "Fuliza is outstanding: the next money received repays it first, so earmarked or expected money will not stay in the wallet.",
      }
    : null;

  const base = {
    quality, balanceCents: i.balanceCents, balanceAsOf: i.balanceAsOf, balanceAgeHours: age,
    potsCents: pots, obligationsDueCents: obligationsDue, overdueCents: overdue, budgetReserveCents: reserve,
    sweep, horizonDays: horizon,
    inputs: { obligations: i.obligations.length, expectedIncome: i.expectedIncome.length },
  };
  if (i.balanceCents == null) {
    return { ...base, freeFloatCents: null, safeToSpend: null, daysToZero: { expected: null, pessimistic: null } };
  }

  const free = i.balanceCents - pots - obligationsDue - reserve;

  // income due today or overdue-but-expected, after the Fuliza sweep absorbs the first inflow
  const todayItems = i.expectedIncome.filter((x) => x.dueOn <= today && x.cents > 0);
  const weightedToday = todayItems.reduce((a, x) => a + x.cents * Math.min(1, clamp0(x.reliability ?? 1)), 0);
  const fullToday = todayItems.reduce((a, x) => a + x.cents, 0);
  const afterSweep = (x: number) => clamp0(x - fuliza);
  const low = clamp0(free - p90);
  const mid = Math.max(low, clamp0(free + afterSweep(weightedToday) - p90));
  const high = Math.max(mid, clamp0(free + afterSweep(fullToday) - p50));
  const confidence = quality !== "ok" ? "low" : mid === low ? "high" : "medium";

  return {
    ...base,
    freeFloatCents: free,
    safeToSpend: { lowCents: Math.round(low), midCents: Math.round(mid), highCents: Math.round(high), confidence },
    daysToZero: {
      expected: projectDaysToZero(i.balanceCents, today, i.obligations, i.expectedIncome, p50, fuliza, i.projectionDays ?? 60, true),
      pessimistic: projectDaysToZero(i.balanceCents, today, i.obligations, [], p90, fuliza, i.projectionDays ?? 60, false),
    },
  };
}

/**
 * Day index (0 = today) of the first day the projected balance is <= 0, or null within `days`.
 * Overdue items land on day 0. The first inflow is reduced by any Fuliza outstanding.
 */
export function projectDaysToZero(
  balance: number, today: DayStr, obligations: DueItem[], income: DueItem[],
  burnPerDay: number, fulizaOutstanding: number, days: number, weighted: boolean,
): number | null {
  if (balance <= 0) return 0;
  const idx = (d: DayStr) => Math.max(0, diffDays(d, today));
  const out = new Map<number, number>();
  const inc = new Map<number, number>();
  for (const o of obligations) if (o.cents > 0) out.set(idx(o.dueOn), (out.get(idx(o.dueOn)) ?? 0) + o.cents);
  for (const x of income) {
    const v = x.cents * (weighted ? Math.min(1, clamp0(x.reliability ?? 1)) : 1);
    if (v > 0) inc.set(idx(x.dueOn), (inc.get(idx(x.dueOn)) ?? 0) + v);
  }
  let bal = balance, fz = fulizaOutstanding;
  for (let k = 0; k <= days; k++) {
    if (k > 0) bal -= burnPerDay;
    let gain = inc.get(k) ?? 0;
    if (gain > 0 && fz > 0) { const s = Math.min(fz, gain); gain -= s; fz -= s; }
    bal += gain - (out.get(k) ?? 0);
    if (bal <= 0) return k;
  }
  return null;
}
