export interface CausalImpactOpts {
  seasonLength?: number;
  controls?: number[][];
}

export interface CausalImpactResult {
  cumulativeEffect: number;
  lo95: number;
  hi95: number;
  pNegative: number;
  preMean: number;
  postMean: number;
  counterfactualMean: number;
  n: number;
}

/**
 * Deterministic local-linear-trend + seasonal regression counterfactual.
 *
 * Model: y_t = b0 + b1*(t - centre) + seasonal dummies (t mod seasonLength) + control coefficients.
 * Fitted by OLS with ridge 1e-6 on the pre-intervention window only, then projected over the post
 * window using observed controls. Uncertainty uses the pre-period residual variance, scaled by
 * the number of post points (sqrt(sum of residual variance)).
 */
export function causalImpact(
  series: number[],
  interventionIndex: number,
  opts: CausalImpactOpts = {},
): CausalImpactResult {
  const preN = Math.floor(interventionIndex);
  const postN = series.length - preN;
  if (!Array.isArray(series) || preN < 14 || postN < 5) {
    throw new Error(
      `causalImpact needs at least 14 pre-intervention and 5 post-intervention points ` +
      `(got ${Math.max(0, preN)} pre and ${Math.max(0, postN)} post)`,
    );
  }
  if (!series.every((x) => typeof x === "number" && isFinite(x))) {
    throw new Error("causalImpact series must contain only finite numbers");
  }

  const season = validSeason(opts.seasonLength) ?? 7;
  const controls = opts.controls ?? [];
  for (const c of controls) {
    if (!Array.isArray(c) || c.length !== series.length || !c.every((x) => isFinite(x))) {
      throw new Error("causalImpact controls must be finite series aligned to the outcome series");
    }
  }

  const centre = (preN - 1) / 2;
  const rows: number[][] = [];
  for (let t = 0; t < series.length; t++) {
    const row: number[] = [1, t - centre];
    const phase = t % season;
    for (let s = 1; s < season; s++) row.push(phase === s ? 1 : 0);
    for (const c of controls) row.push(c[t]!);
    rows.push(row);
  }

  const p = rows[0]!.length;
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty: number[] = new Array<number>(p).fill(0);
  for (let t = 0; t < preN; t++) {
    const row = rows[t]!;
    const y = series[t]!;
    for (let j = 0; j < p; j++) {
      xty[j] = xty[j]! + row[j]! * y;
      for (let k = 0; k < p; k++) xtx[j]![k] = xtx[j]![k]! + row[j]! * row[k]!;
    }
  }
  for (let j = 0; j < p; j++) xtx[j]![j] = xtx[j]![j]! + 1e-6;

  const solved = solve(xtx, xty);
  const beta = solved ?? fallbackBeta(series.slice(0, preN), p);

  let sse = 0;
  for (let t = 0; t < preN; t++) {
    const r = series[t]! - dot(rows[t]!, beta);
    sse += r * r;
  }
  const residVar = sse / Math.max(1, preN - p);

  let effect = 0;
  let cfSum = 0;
  let postSum = 0;
  for (let t = preN; t < series.length; t++) {
    const cf = dot(rows[t]!, beta);
    cfSum += cf;
    postSum += series[t]!;
    effect += series[t]! - cf;
  }

  const se = Math.sqrt(Math.max(0, postN * residVar));
  const preMean = mean(series.slice(0, preN));
  const postMean = postSum / postN;
  return {
    cumulativeEffect: effect,
    lo95: effect - 1.96 * se,
    hi95: effect + 1.96 * se,
    pNegative: se > 0 ? normalCdf(-effect / se) : effect < 0 ? 1 : effect > 0 ? 0 : 0.5,
    preMean,
    postMean,
    counterfactualMean: cfSum / postN,
    n: series.length,
  };
}

function validSeason(value: number | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 2) return null;
  return value;
}

function solve(a: number[][], b: number[]): number[] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (!(Math.abs(m[pivot]![col]!) > 1e-12)) return null;
    if (pivot !== col) {
      const tmp = m[pivot]!;
      m[pivot] = m[col]!;
      m[col] = tmp;
    }
    const diag = m[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! / diag;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - factor * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r]![n]!;
    for (let c = r + 1; c < n; c++) sum -= m[r]![c]! * x[c]!;
    x[r] = sum / m[r]![r]!;
    if (!isFinite(x[r]!)) return null;
  }
  return x;
}

function fallbackBeta(pre: number[], p: number): number[] {
  const beta = new Array<number>(p).fill(0);
  beta[0] = mean(pre);
  return beta;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
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
