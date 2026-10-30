import type { DbAdapter } from "../db/migrate.js";
import { matchingTxs, type HabitSelector } from "./selector.js";
import type { HabitRow } from "./categories.js";
import { computeBaseline, type HabitBaseline } from "./baseline.js";

const DAY = 86_400_000;
export interface HabitTarget { period: "week" | "day" | "month"; count?: number; valueCents?: number }
export interface HabitPeriod { start: number; end: number; count: number; valueCents: number; met: boolean | null }
export interface HabitProgress {
  target: HabitTarget | null; baseline: HabitBaseline; periods: HabitPeriod[];
  current: HabitPeriod | null; followThrough: number | null; heldOfLastM: string | null;
}

const targetOf = (h: HabitRow): HabitTarget | null => {
  const t = h.target as Partial<HabitTarget> | null;
  if (!t || !t.period) return null;
  return t as HabitTarget;
};

export function habitProgress(db: DbAdapter, habit: HabitRow, now = Date.now(), weeks = 8): HabitProgress {
  const selector = habit.selector as HabitSelector;
  const target = targetOf(habit);
  const baseline = computeBaseline(db, selector, now, weeks);
  const periods: HabitPeriod[] = [];
  const periodMs = target?.period === "day" ? DAY : target?.period === "month" ? 30 * DAY : 7 * DAY;
  const count = target?.period === "month" ? 4 : 8;
  for (let i = count; i >= 0; i--) {
    const start = now - i * periodMs - (i === 0 ? 0 : 0);
    const from = now - (i + 1) * periodMs, to = now - i * periodMs;
    const txs = matchingTxs(db, selector, from, to);
    const c = txs.length, v = txs.reduce((a, t) => a + t.amountCents, 0);
    let met: boolean | null = null;
    if (target) {
      if (habit.direction === "reduce") met = (target.count == null || c <= target.count) && (target.valueCents == null || v <= target.valueCents);
      else if (habit.direction === "increase") met = (target.count == null || c >= target.count) && (target.valueCents == null || v >= target.valueCents);
      else met = true;
    }
    periods.push({ start: from, end: to, count: c, valueCents: v, met });
    void start; void periodMs;
  }
  const completed = periods.slice(0, -1).filter((p) => p.met != null);
  const followThrough = completed.length ? completed.filter((p) => p.met).length / completed.length : null;
  const last = completed.slice(-8);
  const held = last.filter((p) => p.met).length;
  return {
    target, baseline, periods,
    current: periods[periods.length - 1] ?? null,
    followThrough,
    heldOfLastM: last.length ? `held ${held} of last ${last.length} weeks` : null,
  };
}

/** Suggested target when creating a reduce habit: half the baseline, rounded down but > 0. */
export function suggestedTarget(baseline: HabitBaseline, direction: "reduce" | "increase" | "keep"): HabitTarget {
  if (direction === "increase") return { period: "week", count: Math.max(1, Math.round(baseline.meanCount * 1.5)) };
  return { period: "week", count: Math.max(0, Math.round(baseline.meanCount * 0.5)) };
}
