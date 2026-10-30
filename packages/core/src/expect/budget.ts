/** Budget periods (Africa/Nairobi boundaries) and pace projection. Pure. */
import { type DayStr, DAY_MS, addDays, clampedDay, dayNumber, dayOf, dayStartMs, dayStrOfNumber, diffDays, parseDay, weekdayOf, ymd } from "./eat.js";

export type BudgetPeriod = "weekly" | "monthly" | "custom";

export interface BudgetRule {
  period: BudgetPeriod;
  /** weekly: weekday 0..6 (default 1 = Monday); monthly: day-of-month 1..31 (default 1, clamped to month length). */
  anchor?: number | null;
  periodDays?: number | null;
  anchorOn?: DayStr | null;
  limitCents: number;
  rollover?: boolean;
}

export interface PeriodBounds {
  startDay: DayStr;
  /** exclusive */
  endDay: DayStr;
  startMs: number;
  endMs: number;
  days: number;
}

function bounds(startDay: DayStr, endDay: DayStr): PeriodBounds {
  return { startDay, endDay, startMs: dayStartMs(startDay), endMs: dayStartMs(endDay), days: diffDays(endDay, startDay) };
}

function monthStart(y: number, m: number, anchor: number): DayStr { return clampedDay(y, m, anchor); }

/** The period containing `ms`. */
export function periodBounds(rule: BudgetRule, ms: number): PeriodBounds {
  const today = dayOf(ms);
  switch (rule.period) {
    case "weekly": {
      const a = rule.anchor ?? 1;
      const start = addDays(today, -((weekdayOf(today) - a + 7) % 7));
      return bounds(start, addDays(start, 7));
    }
    case "monthly": {
      const a = rule.anchor ?? 1;
      const { y, m } = ymd(today);
      let sy = y, sm = m;
      if (today < monthStart(sy, sm, a)) { sm--; if (sm < 1) { sm = 12; sy--; } }
      const start = monthStart(sy, sm, a);
      let ey = sy, em = sm + 1;
      if (em > 12) { em = 1; ey++; }
      return bounds(start, monthStart(ey, em, a));
    }
    case "custom": {
      const n = rule.periodDays ?? 0;
      if (!(n >= 1) || !rule.anchorOn) throw new Error("custom budget needs periodDays>=1 and anchorOn");
      const k = Math.floor(diffDays(today, rule.anchorOn) / n);
      const start = addDays(rule.anchorOn, k * n);
      return bounds(start, addDays(start, n));
    }
  }
}

/** The period immediately before the one containing `ms`. */
export function previousPeriod(rule: BudgetRule, ms: number): PeriodBounds {
  const cur = periodBounds(rule, ms);
  return periodBounds(rule, cur.startMs - 1);
}

export interface SpendEvent { occurredAt: number; amountCents: number }

export function spentIn(spend: SpendEvent[], startMs: number, endMs: number): number {
  let s = 0;
  for (const e of spend) if (e.occurredAt >= startMs && e.occurredAt < endMs) s += e.amountCents;
  return s;
}

/**
 * Unused budget carried into the period containing `ms`. Chains up to `maxPeriods` previous periods:
 * carry_k = max(0, limit + carry_{k-1} - spent_k). Overspend never creates a negative carry.
 */
export function rolloverCarry(rule: BudgetRule, spend: SpendEvent[], ms: number, maxPeriods = 12): number {
  if (!rule.rollover) return 0;
  const starts: PeriodBounds[] = [];
  let p = previousPeriod(rule, ms);
  const earliest = spend.reduce((m, e) => Math.min(m, e.occurredAt), Infinity);
  for (let i = 0; i < maxPeriods; i++) {
    starts.push(p);
    if (p.startMs <= earliest) break;
    p = periodBounds(rule, p.startMs - 1);
  }
  let carry = 0;
  for (const b of starts.reverse()) carry = Math.max(0, rule.limitCents + carry - spentIn(spend, b.startMs, b.endMs));
  return carry;
}

export type PaceStatus = "ok" | "at_risk" | "over";

export interface PaceOptions {
  carryCents?: number;
  /** Relative spend weight per weekday, index 0 = Sunday. Default uniform. */
  weekdayWeights?: number[];
  /** Historical spend per unit weight for this scope (cents), used as a prior early in the period. Default: limit / total weight. */
  priorPerWeightCents?: number;
  /** Elapsed share of the period at which observed pace is fully trusted. Default 0.25. */
  trustShare?: number;
}

export interface PaceResult {
  bounds: PeriodBounds;
  limitCents: number;
  carryCents: number;
  effectiveLimitCents: number;
  spentCents: number;
  remainingCents: number;
  /** share of the period elapsed by weekday-weighted time, 0..1 */
  elapsedShare: number;
  projectedEndCents: number;
  projectedOverspendCents: number;
  /** First EAT day on which projected cumulative spend exceeds the limit, if it does. */
  projectedBreachOn: DayStr | null;
  /** thresholds already crossed by actual spend: subset of [50, 80, 100] */
  thresholdsCrossed: number[];
  status: PaceStatus;
}

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

export function pace(rule: BudgetRule, spend: SpendEvent[], nowMs: number, opts: PaceOptions = {}): PaceResult {
  const b = periodBounds(rule, nowMs);
  const w = opts.weekdayWeights && opts.weekdayWeights.length === 7 && opts.weekdayWeights.every((x) => x >= 0) && opts.weekdayWeights.some((x) => x > 0)
    ? opts.weekdayWeights : [1, 1, 1, 1, 1, 1, 1];
  const carry = Math.max(0, opts.carryCents ?? 0);
  const eff = rule.limitCents + carry;
  const spent = spentIn(spend, b.startMs, Math.min(nowMs + 1, b.endMs));
  const startN = parseDay(b.startDay);
  const todayN = dayNumber(nowMs);
  const dayFrac = Math.min(1, Math.max(0, (nowMs - dayStartMs(todayN)) / DAY_MS));
  let total = 0, elapsed = 0;
  const weights: number[] = [];
  for (let i = 0; i < b.days; i++) {
    const n = startN + i;
    const wt = w[weekdayOf(n)]!;
    weights.push(wt);
    total += wt;
    if (n < todayN) elapsed += wt; else if (n === todayN) elapsed += wt * dayFrac;
  }
  const elapsedShare = total > 0 ? elapsed / total : 1;
  const prior = opts.priorPerWeightCents ?? (total > 0 ? rule.limitCents / total : 0);
  const trust = Math.min(1, elapsedShare / (opts.trustShare ?? 0.25));
  const observed = elapsed > 0 ? spent / elapsed : prior;
  const rate = trust * observed + (1 - trust) * prior;
  const remainingWeight = Math.max(0, total - elapsed);
  const projected = Math.round(spent + rate * remainingWeight);

  // breach day: walk remaining days at the blended rate (today's remainder first)
  let breach: DayStr | null = null;
  if (spent > eff) breach = dayStrOfNumber(Math.min(todayN, parseDay(b.endDay) - 1));
  else if (projected > eff) {
    let cum = spent;
    for (let i = 0; i < b.days; i++) {
      const n = startN + i;
      if (n < todayN) continue;
      const part = n === todayN ? weights[i]! * (1 - dayFrac) : weights[i]!;
      cum += rate * part;
      if (cum > eff) { breach = dayStrOfNumber(n); break; }
    }
  }
  const crossed = BUDGET_THRESHOLDS.filter((t) => eff > 0 && spent * 100 >= eff * t);
  const status: PaceStatus = spent > eff ? "over" : projected > eff ? "at_risk" : "ok";
  return {
    bounds: b, limitCents: rule.limitCents, carryCents: carry, effectiveLimitCents: eff, spentCents: spent,
    remainingCents: Math.max(0, eff - spent), elapsedShare, projectedEndCents: projected,
    projectedOverspendCents: Math.max(0, projected - eff), projectedBreachOn: breach,
    thresholdsCrossed: [...crossed], status,
  };
}

/**
 * Cash to hold back for budgets over the next `horizonDays`: each budget's remaining allowance, prorated by
 * the share of its remaining period that falls in the horizon. Only active budgets should be passed.
 */
export function budgetReserve(paces: PaceResult[], nowMs: number, horizonDays: number): number {
  let r = 0;
  const today = dayOf(nowMs);
  for (const p of paces) {
    const left = Math.max(1, diffDays(p.bounds.endDay, today));
    r += Math.round(p.remainingCents * Math.min(1, horizonDays / left));
  }
  return r;
}
