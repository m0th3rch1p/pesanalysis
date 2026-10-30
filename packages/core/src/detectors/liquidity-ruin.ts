import type { Finding, LedgerTx } from "./types.js";
import { cv, mean, stdev } from "./stats.js";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const HORIZON_DAYS = 7;
const MILLER_I = 0.00035; // daily opportunity cost
const MILLER_B = 3_300;   // KES 33 transaction cost (cents)

export interface LiquidityOpts {
  windowDays?: number;
  horizonDays?: number;
}

/**
 * Liquidity / ruin risk. Uses the latest provider-stated M-Pesa balance (balanceAfterCents), the
 * last 30 days of net daily flows, and recurring commitments due in the next 7 days. The buffer
 * after commitments is treated as the starting point of a drift-diffusion cash process. First
 * passage to zero is inverse-Gaussian for negative drift; for non-negative drift we multiply the
 * IG hitting-time law by the Wiener upper-bound probability exp(-2*mu*x/sigma^2), so volatility
 * still contributes. Miller-Orr supplies the practical float band.
 */
export function detectLiquidityRuin(txs: LedgerTx[], now = Date.now(), opts: LiquidityOpts = {}): Finding[] {
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;

  const latest = [...txs]
    .filter((t) => t.balanceAfterCents != null && isFinite(t.balanceAfterCents))
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .pop();
  const balance = latest?.balanceAfterCents;
  if (balance == null || !isFinite(balance)) return [];

  const start = now - (windowDays - 1) * DAY;
  const daily = new Array<number>(windowDays).fill(0);
  const activeDays = new Set<number>();
  let grossOut = 0;
  for (const t of txs) {
    const d = Math.floor((t.occurredAt - start) / DAY);
    if (d < 0 || d >= windowDays) continue;
    const spend = t.amount + (t.fee ?? 0);
    const net = t.direction === "in" ? t.amount : t.direction === "out" ? -spend : 0;
    daily[d] = daily[d]! + net;
    if (net !== 0) {
      activeDays.add(d);
      if (t.direction === "out") grossOut += spend;
    }
  }
  if (activeDays.size < 14) return [];

  const mu = mean(daily);
  const sigma = stdev(daily);
  const commitments = scheduledCommitments(txs, now, horizonDays);
  const effective = Math.max(0, balance - commitments);
  if (!(effective > 0)) return [];

  // The formal IG tail can underflow to exactly 0 when the barrier is many sigma away.
  // Keep a tiny positive floor so a negative-drift account never reads as "certain no risk".
  const rawP7 = firstPassageCdf(horizonDays, effective, mu, sigma);
  const p7 = mu < 0 ? Math.max(rawP7, 1e-12) : rawP7;
  const medianDays = firstPassageQuantile(0.5, effective, mu, sigma);
  const p90Days = firstPassageQuantile(0.9, effective, mu, sigma);

  const avgBurn = grossOut / windowDays;
  const L = Math.max(1, Math.round(3 * avgBurn));
  let S = 3 * Math.cbrt((3 * MILLER_B * sigma * sigma) / (4 * MILLER_I));
  if (!isFinite(S) || S < 3) S = 3 * MILLER_B;
  const Z = Math.round(L + S / 3);
  const U = Math.round(L + S);

  const pct = Math.round(Math.max(0, Math.min(1, p7)) * 100);
  return [{
    detector: "liquidity_ruin",
    id: `liquidity_ruin:${Math.round(effective)}:${pct}`,
    title: `${horizonDays}-day Fuliza risk ${pct}%: median runway ${Math.round(medianDays)} days; keep KES ${kes0(L)}-${kes0(U)} float`,
    n: daily.length,
    evidence: {
      balance,
      effectiveBalance: effective,
      p7,
      medianDays,
      p90Days,
      L,
      Z,
      U,
      muPerDay: mu,
      sigmaPerDay: isFinite(sigma) ? sigma : 0,
      commitmentsCents: commitments,
      windowDays,
      horizonDays,
      activeDays: activeDays.size,
    },
  }];
}

function scheduledCommitments(txs: LedgerTx[], now: number, horizonDays: number): number {
  const groups = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    if (t.direction !== "out" || !t.counterpartyKey) continue;
    const k = t.counterpartyKey;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  let total = 0;
  const horizon = now + horizonDays * DAY;
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.occurredAt - b.occurredAt);
    if (sorted.length < 4) continue;
    if (!(cv(sorted.map((t) => t.amount)) <= 0.35)) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i]!.occurredAt - sorted[i - 1]!.occurredAt) / DAY);
    const gap = mean(gaps);
    let period: number;
    if (gap >= 5 && gap <= 9) period = 7;
    else if (gap >= 25 && gap <= 35) period = 30;
    else continue;
    let next = sorted[sorted.length - 1]!.occurredAt + period * DAY;
    while (next < now) next += period * DAY;
    if (next <= horizon) total += sorted[sorted.length - 1]!.amount + (sorted[sorted.length - 1]!.fee ?? 0);
  }
  return total;
}

/** P(tau <= days) for a drift-diffusion cash process starting at x with daily drift mu and vol sigma. */
function firstPassageCdf(days: number, x: number, mu: number, sigma: number): number {
  const t = days;
  if (!(x > 0) || !(t > 0)) return 1;
  if (!(sigma > 0)) return mu < 0 && x / -mu <= t ? 1 : 0;
  if (mu < 0) {
    const m = x / -mu;
    const lambda = (x * x) / (sigma * sigma);
    return clamp(igCdf(t, m, lambda));
  }
  if (mu > 0) {
    const hit = Math.exp((-2 * mu * x) / (sigma * sigma));
    const lambda = (x * x) / (sigma * sigma);
    return clamp(hit * igCdf(t, x / mu, lambda));
  }
  // Zero drift: Levy first-passage law, P(min <= 0) = 2*Phi(-x/(sigma*sqrt(t))).
  return clamp(2 * normalCdf(-x / (sigma * Math.sqrt(t))));
}

function igCdf(t: number, m: number, lambda: number): number {
  if (!(t > 0) || !(m > 0) || !(lambda > 0)) return 0;
  const a = Math.sqrt(lambda / t);
  const z1 = a * (t / m - 1);
  const z2 = -a * (t / m + 1);
  return normalCdf(z1) + Math.exp((2 * lambda) / m) * normalCdf(z2);
}

function firstPassageQuantile(q: number, x: number, mu: number, sigma: number): number {
  let lo = 1e-6;
  let hi = 3_650;
  if (firstPassageCdf(hi, x, mu, sigma) < q) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (firstPassageCdf(mid, x, mu, sigma) < q) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function clamp(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function kes0(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}
