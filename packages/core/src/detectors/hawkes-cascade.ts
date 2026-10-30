import type { Detector, Finding, LedgerTx } from "./types.js";
import { mean } from "./stats.js";

const HOUR = 3_600_000;

export interface HawkesOpts {
  minEvents?: number;
  minSpanDays?: number;
  minBranchingRatio?: number;
  followWindowHours?: number;
}

interface HawkesFit {
  mu: number;
  alpha: number;
  beta: number;
  R: number;
  ll: number;
}

/**
 * Univariate marked Hawkes process with an exponential kernel, fitted on outflow times (hours).
 *
 * lambda(t) = mu + alpha * sum_{t_j < t} exp(-beta * (t - t_j))
 *
 * We grid-search beta, the branching ratio R = alpha/beta and mu, using the exact recursive
 * A_i = exp(-beta*dt)*(1 + A_{i-1}) and the compensator
 * mu*T + R*sum_i (1 - exp(-beta*(T-t_i))). A local refinement pass around the best grid point
 * keeps the estimate from being quantised by the grid. R is capped at 0.99 (stationarity).
 */
export const detectHawkesCascade: Detector<HawkesOpts> = (txs, opts = {}) => {
  const {
    minEvents = 20,
    minSpanDays = 3,
    minBranchingRatio = 0.15,
    followWindowHours = 3,
  } = opts;

  const outflows = txs
    .filter((t) => t.direction === "out")
    .sort((a, b) => a.occurredAt - b.occurredAt);
  if (outflows.length < minEvents) return [];

  const t0 = outflows[0]!.occurredAt;
  const times = outflows.map((t) => (t.occurredAt - t0) / HOUR);
  const spanH = times[times.length - 1]! - times[0]!;
  if (!(spanH >= minSpanDays * 24)) return [];

  const fit = fitHawkes(times);
  if (!isFinite(fit.R) || fit.R < minBranchingRatio) return [];

  const gapsMin: number[] = [];
  for (let i = 1; i < times.length; i++) gapsMin.push(Math.max(0, times[i]! - times[i - 1]!) * 60);

  const pairs = crossLabelPairs(outflows, followWindowHours);
  const topPairs = pairs.slice(0, 5).map((p) => {
    const meanFollowCents = Math.round(p.sumCents / p.count);
    return {
      from: p.from,
      to: p.to,
      trigger: p.from,
      follow: p.to,
      count: p.count,
      meanFollowCents,
      meanFollowAmount: meanFollowCents,
    };
  });

  const findings: Finding[] = [{
    detector: "hawkes_cascade",
    id: `hawkes_cascade:${outflows.length}:${Math.round(fit.R * 1000)}`,
    title: `Spending cascades: ${Math.round(fit.R * 100)}% of outflows follow another spend (R=${fit.R.toFixed(2)})`,
    n: outflows.length,
    evidence: {
      R: fit.R,
      mu: fit.mu,
      alpha: fit.alpha,
      beta: fit.beta,
      meanGapMin: gapsMin.length ? mean(gapsMin) : null,
      topPairs,
      spanDays: spanH / 24,
      followWindowHours,
    },
  }];

  const strongest = pairs.find((p) => p.count >= 5);
  if (strongest) {
    findings.push({
      detector: "hawkes_cascade",
      id: `hawkes_cascade_pair:${strongest.from}:${strongest.to}`,
      title: `After ${strongest.from}, you spend again on ${strongest.to} within ${followWindowHours}h (${strongest.count} times, avg KES ${kes(strongest.sumCents / strongest.count)})`,
      n: strongest.count,
      evidence: {
        from: strongest.from,
        to: strongest.to,
        count: strongest.count,
        meanFollowCents: Math.round(strongest.sumCents / strongest.count),
        followWindowHours,
        R: fit.R,
      },
    });
  }

  return findings;
};

function fitHawkes(times: number[]): HawkesFit {
  const n = times.length;
  const T = Math.max(times[n - 1]! - times[0]!, 1e-9);
  const meanRate = n / T;

  const muGrid: number[] = [];
  for (const f of [0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15, 0.22, 0.32, 0.45, 0.6, 0.8, 1.0]) {
    muGrid.push(Math.max(1e-8, meanRate * f));
  }

  const betaGrid: number[] = [];
  for (let i = 0; i < 24; i++) betaGrid.push(0.02 * Math.pow(1.35, i));

  const rGrid: number[] = [];
  for (let r = 0; r <= 0.96 + 1e-12; r += 0.04) rGrid.push(Math.min(0.99, r));

  let best: HawkesFit = { mu: Math.max(1e-8, meanRate), alpha: 0, beta: 1, R: 0, ll: -Infinity };

  for (const beta of betaGrid) {
    const { A, compensator } = kernelTerms(times, beta, T);
    for (const R of rGrid) {
      const alpha = R * beta;
      for (const mu of muGrid) {
        const ll = hawkesLogLik(T, mu, alpha, R, A, compensator);
        if (ll > best.ll) best = { mu, alpha, beta, R, ll };
      }
    }
  }

  // Local refinement around the best grid cell.
  let mu = best.mu, R = best.R, beta = best.beta;
  for (let round = 0; round < 2; round++) {
    let local = best;
    for (const mf of [0.75, 0.87, 1, 1.15, 1.33]) {
      for (const rf of [R - 0.02, R - 0.01, R, R + 0.01, R + 0.02]) {
        const rr = Math.max(0, Math.min(0.99, rf));
        for (const bf of [0.8, 0.9, 1, 1.11, 1.25]) {
          const b = Math.max(1e-6, beta * bf);
          const m = Math.max(1e-8, mu * mf);
          const { A, compensator } = kernelTerms(times, b, T);
          const ll = hawkesLogLik(T, m, rr * b, rr, A, compensator);
          if (ll > local.ll) local = { mu: m, alpha: rr * b, beta: b, R: rr, ll };
        }
      }
    }
    best = local;
    mu = best.mu; R = best.R; beta = best.beta;
  }

  return best;
}

function kernelTerms(times: number[], beta: number, T: number): { A: number[]; compensator: number } {
  const A = new Array<number>(times.length);
  let a = 0;
  let compensator = 0;
  for (let i = 0; i < times.length; i++) {
    if (i > 0) a = Math.exp(-beta * Math.max(0, times[i]! - times[i - 1]!)) * (1 + a);
    A[i] = a;
    compensator += 1 - Math.exp(-beta * Math.max(0, T - times[i]!));
  }
  return { A, compensator };
}

function hawkesLogLik(
  T: number, mu: number, alpha: number, R: number, A: number[], compensator: number,
): number {
  let ll = -mu * T - R * compensator;
  for (let i = 0; i < A.length; i++) {
    const lambda = mu + alpha * A[i]!;
    if (!(lambda > 0) || !isFinite(lambda)) return -Infinity;
    ll += Math.log(lambda);
  }
  return ll;
}

interface PairStat { from: string; to: string; count: number; sumCents: number }

function crossLabelPairs(txs: LedgerTx[], windowHours: number): PairStat[] {
  const windowMs = windowHours * HOUR;
  const map = new Map<string, PairStat>();
  for (let i = 0; i < txs.length; i++) {
    const trigger = txs[i]!;
    const from = displayLabel(trigger);
    for (let j = i + 1; j < txs.length; j++) {
      const follow = txs[j]!;
      const dt = follow.occurredAt - trigger.occurredAt;
      if (dt > windowMs) break;
      if (dt <= 0) continue;
      const to = displayLabel(follow);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const cur = map.get(key) ?? { from, to, count: 0, sumCents: 0 };
      cur.count++;
      cur.sumCents += follow.amount;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.sumCents - a.sumCents);
}

function displayLabel(t: LedgerTx): string {
  const label = (t.label ?? "").trim();
  return label || "Unlabelled";
}

function kes(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}

