/** log-factorial memo. logFact(n) guarantees LF[0..n] are populated. */
const LF: number[] = [0];
function logFact(n: number): number[] {
  for (let i = LF.length; i <= n; i++) LF[i] = LF[i - 1]! + Math.log(i);
  return LF;
}

/** One-sided binomial tail P(X >= k), X ~ Bin(n, p). Exact, log-space. */
export function binomTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lf = logFact(n);
  const lp = Math.log(p), lq = Math.log(1 - p);
  let sum = 0;
  for (let i = k; i <= n; i++) sum += Math.exp(lf[n]! - lf[i]! - lf[n - i]! + i * lp + (n - i) * lq);
  return Math.min(1, sum);
}

/** Two-sided exact binomial test against p (used by the sign test in the evolution gate). */
export function binomTwoSided(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 1;
  if (p <= 0) return k > 0 ? 0 : 1;
  if (p >= 1) return k < n ? 0 : 1;
  const lf = logFact(n);
  const lp = Math.log(p), lq = Math.log(1 - p);
  const pmf = (i: number) => Math.exp(lf[n]! - lf[i]! - lf[n - i]! + i * lp + (n - i) * lq);
  const pk = pmf(k);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= pk * (1 + 1e-9)) sum += pmf(i);
  return Math.min(1, sum);
}

export function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Coefficient of variation of a sample (NaN-safe: returns Infinity for n<2 or mean 0). */
export function cv(xs: number[]): number {
  const m = mean(xs);
  return m > 0 ? stdev(xs) / m : Infinity;
}

/** Wilson score interval (lower bound used as a conservative confidence). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n, z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/** Deterministic mulberry32 (same family as synth/rng) for reproducible permutation tests. */
export function testRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two-sample permutation test on means (one-sided: a > b). Deterministic via seed.
 * Used to compare a detector statistic against its exchangeable null.
 */
export function permTestOneSided(a: number[], b: number[], iters = 2000, seed = 1234): number {
  if (a.length === 0 || b.length === 0) return 1;
  const obs = mean(a) - mean(b);
  const all = [...a, ...b];
  const na = a.length;
  const rnd = testRng(seed);
  let ge = 0;
  for (let it = 0; it < iters; it++) {
    // partial Fisher-Yates
    let sumA = 0;
    for (let i = 0; i < na; i++) {
      const j = i + Math.floor(rnd() * (all.length - i));
      const tmp = all[i]!; all[i] = all[j]!; all[j] = tmp;
      sumA += all[i]!;
    }
    if (sumA / na - (mean(all) * all.length - sumA) / (all.length - na) >= obs) ge++;
  }
  return (ge + 1) / (iters + 1);
}
