import type { DbAdapter } from "../db/migrate.js";
import { matchingTxs, type HabitSelector } from "./selector.js";

export interface HabitBaseline {
  weeks: number;
  counts: number[];
  values: number[];
  meanCount: number;
  medianCount: number;
  meanValueCents: number;
  medianValueCents: number;
  countLo: number; countHi: number;
  valueLoCents: number; valueHiCents: number;
}

const DAY = 86_400_000;
const median = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0;

/** Last 8 complete 7-day buckets ending now, with an empirical 10–90% interval. */
export function computeBaseline(db: DbAdapter, selector: HabitSelector, now = Date.now(), weeks = 8): HabitBaseline {
  const counts: number[] = [], values: number[] = [];
  for (let w = weeks; w >= 1; w--) {
    const from = now - w * 7 * DAY, to = from + 7 * DAY;
    const txs = matchingTxs(db, selector, from, to);
    counts.push(txs.length);
    values.push(txs.reduce((a, t) => a + t.amountCents, 0));
  }
  const sortedC = [...counts].sort((a, b) => a - b), sortedV = [...values].sort((a, b) => a - b);
  const pick = (a: number[], q: number) => a[Math.max(0, Math.min(a.length - 1, Math.floor(q * a.length)))] ?? 0;
  return {
    weeks, counts, values,
    meanCount: counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length),
    medianCount: median(counts),
    meanValueCents: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    medianValueCents: median(values),
    countLo: pick(sortedC, 0.1), countHi: pick(sortedC, 0.9),
    valueLoCents: pick(sortedV, 0.1), valueHiCents: pick(sortedV, 0.9),
  };
}
