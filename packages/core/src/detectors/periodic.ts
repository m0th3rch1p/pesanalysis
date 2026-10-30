import type { Detector, Finding, LedgerTx } from "./types.js";
import { cv, mean, testRng } from "./stats.js";

export interface PeriodicOpts {
  minN?: number;        // min txs for a counterparty group (default 4)
  maxCv?: number;       // inter-arrival regularity (default 0.25)
  maxAmountCv?: number; // amount consistency (default 0.35)
  periods?: number[];   // candidate periods in hours to bootstrap meaning (default none)
  iters?: number;
}

/**
 * Recurring payments. For each counterparty+direction group with >= minN txs:
 * - inter-arrival intervals must be regular (cv <= maxCv)
 * - amounts must be consistent (cv <= maxAmountCv) when n >= 3
 * Null: interval lengths ~ exponential(rate = observed mean) => cv ~ 1.
 * p-value = fraction of simulated exponential-interval samples with cv <= observed cv
 * (deterministic via seed). This is deliberately conservative: occasional irregularity is normal life.
 */
export const detectPeriodic: Detector<PeriodicOpts> = (txs, opts = {}) => {
  const { minN = 4, maxCv = 0.25, maxAmountCv = 0.35, iters = 2000 } = opts;
  const out: Finding[] = [];
  const groups = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    if (t.direction === "neutral" || !t.counterpartyKey) continue;
    const key = `${t.direction}:${t.counterpartyKey}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  for (const [key, g] of groups) {
    const sorted = [...g].sort((a, b) => a.occurredAt - b.occurredAt);
    if (sorted.length < minN) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]!.occurredAt - sorted[i - 1]!.occurredAt);
    if (gaps.length < minN - 1) continue;
    const c = cv(gaps);
    if (!isFinite(c) || c > maxCv) continue;
    const amounts = sorted.map((t) => t.amount);
    const aCv = amounts.length >= 3 ? cv(amounts) : 0;
    if (aCv > maxAmountCv) continue;
    const mu = mean(gaps);
    // null: exponential intervals with the same mean; simulate their CV distribution
    const rnd = testRng(hash(key) ^ Math.round(mu));
    let le = 0;
    const nGaps = gaps.length;
    for (let it = 0; it < iters; it++) {
      let s = 0, s2 = 0;
      for (let i = 0; i < nGaps; i++) { const x = -Math.log(1 - rnd()) * mu; s += x; s2 += x * x; }
      const m = s / nGaps, v = Math.max(0, s2 / nGaps - m * m);
      const simCv = Math.sqrt(v) / m; // CV of this simulated exponential-interval sample
      if (simCv <= c) le++;
    }
    const p = le / iters;
    if (p > 0.01) continue;
    const periodH = mu / 3_600_000;
    const label = periodH >= 24 * 27 && periodH <= 24 * 32 ? "monthly" : periodH >= 24 * 6 && periodH <= 24 * 8 ? "weekly" : periodH >= 20 ? "daily" : `every ${periodH.toFixed(1)}h`;
    const dir = key.slice(0, key.indexOf(":"));
    const cp = key.slice(key.indexOf(":") + 1);
    const display = sorted.find((t) => t.counterpartyName)?.counterpartyName ?? cp.replace(/^[a-z]:/, "").replace(/_/g, " ");
    out.push({
      detector: "periodic",
      id: `periodic:${key}:${Math.round(periodH)}`,
      title: `${dir === "in" ? "Incoming payments from" : "Outgoing payments to"} ${display} recur ${label} (${sorted.length} txs, mean KES ${(mean(amounts) / 100).toFixed(0)}, interval CV ${c.toFixed(2)})`,
      n: sorted.length, pValue: p,
      evidence: { counterparty: cp, direction: dir, meanGapMs: mu, gapCv: c, amountCv: aCv, lastAt: sorted[sorted.length - 1]!.occurredAt },
    });
  }
  return out;
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
