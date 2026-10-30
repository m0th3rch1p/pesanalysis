import type { Detector, Finding, LedgerTx } from "./types.js";
import { cv, mean, median, permTestOneSided, stdev, testRng } from "./stats.js";
import { toEatParts } from "../sms/time.js";

const DAY = 86_400_000;
const HAZARD = 1 / 250;

export interface BocpdOpts {
  minLabelEvents?: number;
  minCounterpartyEvents?: number;
  minFixedPriceEvents?: number;
  minProbability?: number;
  minShift?: number;
}

interface Series {
  key: string;
  kind: "amount" | "interval";
  label: string | null;
  counterparty: string | null;
  display: string;
  values: number[];
  at: number[];
}

interface Candidate {
  key: string;
  kind: "amount" | "interval";
  label: string | null;
  counterparty: string | null;
  display: string;
  index: number;
  probability: number;
  shift: number;
  beforeMean: number;
  afterMean: number;
  changeAt: number;
  beforeN: number;
  afterN: number;
  before: number[];
  after: number[];
  spanDays: number;
}

/**
 * Adams-MacKay Bayesian online changepoint detection with a Normal-Inverse-Gamma prior and
 * Student-t predictive, constant hazard 1/250, all messages in log space.
 *
 * Each series is standardised by its median and MAD before inference, so the weakly informative
 * NIG prior is scale-free and the reported means stay in the original units (cents or days).
 * We run it on (a) outflow amounts by label, (b) amounts by counterparty, and (c) inter-arrival
 * intervals for fixed-price groups (amount CV <= 0.1), which is the shrinkflation signal.
 */
export const detectBocpdRegime: Detector<BocpdOpts> = (txs, opts = {}) => {
  const {
    minLabelEvents = 12,
    minCounterpartyEvents = 10,
    minFixedPriceEvents = 8,
    minProbability = 0.9,
    minShift = 0.15,
  } = opts;

  const outflows = txs
    .filter((t) => t.direction === "out")
    .sort((a, b) => a.occurredAt - b.occurredAt);

  const series: Series[] = [];
  const byLabel = new Map<string, LedgerTx[]>();
  const byCounterparty = new Map<string, LedgerTx[]>();
  for (const t of outflows) {
    if (t.label) {
      const k = t.label.trim();
      if (k) (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(t);
    }
  }
  for (const t of txs) {
    if (t.direction === "neutral" || !t.counterpartyKey) continue;
    const k = t.counterpartyKey;
    (byCounterparty.get(k) ?? byCounterparty.set(k, []).get(k)!).push(t);
  }

  for (const [label, g] of byLabel) {
    if (g.length >= minLabelEvents) series.push(amountSeries(`label:${label}`, label, null, label, g));
    addIntervalSeries(series, `label:${label}`, label, null, label, g, minFixedPriceEvents);
  }
  for (const [cp, g] of byCounterparty) {
    if (g.length >= minCounterpartyEvents) series.push(amountSeries(`cp:${cp}`, null, cp, prettyCounterparty(g), g));
    addIntervalSeries(series, `cp:${cp}`, null, cp, prettyCounterparty(g), g, minFixedPriceEvents);
  }
  // A whole-wallet series catches regimes when labels/counterparty keys are sparse.
  if (outflows.length >= 20) series.push(amountSeries("all:amount", null, null, "All spending", outflows));
  addIntervalSeries(series, "all", null, null, "All spending", outflows, minFixedPriceEvents);

  const candidates: Candidate[] = [];
  for (const s of series) {
    if (s.values.length < 6) continue;
    if (!(stdev(s.values) > 1e-9)) continue;
    const p = bocpdProbabilities(s.values);
    let best: Candidate | null = null;
    for (let i = 3; i <= s.values.length - 3; i++) {
      const prob = p[i] ?? 0;
      if (prob < minProbability) continue;
      const beforeMean = mean(s.values.slice(0, i));
      const afterMean = mean(s.values.slice(i));
      if (!isFinite(beforeMean) || !isFinite(afterMean)) continue;
      const shift = Math.abs(afterMean - beforeMean) / Math.max(Math.abs(beforeMean), 1e-9);
      if (shift < minShift) continue;
      const beforeDays = ((s.at[i - 1] ?? s.at[0] ?? 0) - (s.at[0] ?? 0)) / DAY;
      const afterDays = ((s.at[s.at.length - 1] ?? 0) - (s.at[i] ?? 0)) / DAY;
      if (beforeDays < 21 || afterDays < 21) continue; // D115: 21 days each side
      const candidate: Candidate = {
        key: s.key,
        kind: s.kind,
        label: s.label,
        counterparty: s.counterparty,
        display: s.display,
        index: i,
        probability: prob,
        shift,
        beforeMean,
        afterMean,
        changeAt: s.at[i] ?? s.at[s.at.length - 1] ?? 0,
        beforeN: i,
        afterN: s.values.length - i,
        before: s.values.slice(0, i),
        after: s.values.slice(i),
        spanDays: Math.max(1, ((s.at[s.at.length - 1] ?? 0) - (s.at[0] ?? 0)) / DAY),
      };
      if (!best || candidate.probability > best.probability ||
        (candidate.probability === best.probability && candidate.shift > best.shift)) best = candidate;
    }
    if (best) candidates.push(best);
  }

  candidates.sort((a, b) => b.probability - a.probability || b.shift - a.shift);

  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (chosen.length >= 2) break;
    const duplicate = chosen.some((x) =>
      x.kind === c.kind &&
      Math.abs(x.changeAt - c.changeAt) < 2 * DAY &&
      Math.abs(x.beforeMean - c.beforeMean) <= Math.max(0.1 * Math.abs(x.beforeMean), 1) &&
      Math.abs(x.afterMean - c.afterMean) <= Math.max(0.1 * Math.abs(x.afterMean), 1),
    );
    if (!duplicate) chosen.push(c);
  }

  return chosen.map((c) => toFinding(c));
};

function amountSeries(
  key: string, label: string | null, counterparty: string | null, display: string, txs: LedgerTx[],
): Series {
  const sorted = [...txs].sort((a, b) => a.occurredAt - b.occurredAt);
  return {
    key,
    kind: "amount",
    label,
    counterparty,
    display,
    values: sorted.map((t) => t.amount),
    at: sorted.map((t) => t.occurredAt),
  };
}

function addIntervalSeries(
  into: Series[], key: string, label: string | null, counterparty: string | null,
  display: string, txs: LedgerTx[], minEvents: number,
): void {
  const sorted = [...txs].sort((a, b) => a.occurredAt - b.occurredAt);
  if (sorted.length < minEvents) return;
  const amounts = sorted.map((t) => t.amount);
  if (!(cv(amounts) <= 0.1)) return;
  const values: number[] = [];
  const at: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i]!.occurredAt - sorted[i - 1]!.occurredAt) / DAY;
    if (gap > 0) {
      values.push(gap);
      at.push(sorted[i]!.occurredAt);
    }
  }
  if (values.length >= minEvents - 1) {
    into.push({ key: `${key}:interval`, kind: "interval", label, counterparty, display, values, at });
  }
}

/**
 * Exact Adams-MacKay forward messages. Returns P(run length <= shortRunWindow | y_1..y_t)
 * at each t (default 0, i.e. the exact changepoint probability). The detector uses the default
 * so changeAt points at the first post-change observation.
 * NIG prior: mu0=0, kappa0=0.1, alpha0=0.5, beta0=0.05 (on standardised values). A tighter
 * prior lets a short fixed-price interval series (8+8 points) speak before the prior dominates.
 */
export function bocpdProbabilities(values: number[], shortRunWindow = 0): number[] {
  const center = median(values);
  const mad = median(values.map((x) => Math.abs(x - center)));
  let scale = 1.4826 * mad;
  if (!(scale > 1e-9)) scale = stdev(values);
  if (!(scale > 1e-9)) scale = Math.max(1e-9, Math.abs(center) * 0.01);
  const z = values.map((x) => (x - center) / scale);

  const mu0 = 0, kappa0 = 0.1, alpha0 = 0.5, beta0 = 0.05;
  const logH = Math.log(HAZARD);
  const log1mH = Math.log(1 - HAZARD);

  let logRun = [Math.log(1)]; // run length 0 at t=0
  let params = [{ mu: mu0, kappa: kappa0, alpha: alpha0, beta: beta0 }];
  const pChange: number[] = [];

  for (let t = 0; t < z.length; t++) {
    const x = z[t]!;
    const pred: number[] = new Array(logRun.length);
    for (let r = 0; r < logRun.length; r++) {
      const pp = params[r]!;
      pred[r] = studentTLogPdf(x, pp.mu, pp.kappa, pp.alpha, pp.beta);
    }
    const priorPred = studentTLogPdf(x, mu0, kappa0, alpha0, beta0);

    const nextLog: number[] = new Array(logRun.length + 1);
    nextLog[0] = logH + priorPred;
    for (let r = 0; r < logRun.length; r++) nextLog[r + 1] = logRun[r]! + pred[r]! + log1mH;

    const norm = logSumExp(nextLog);
    for (let i = 0; i < nextLog.length; i++) nextLog[i] = nextLog[i]! - norm;
    const upto = Math.max(0, Math.min(shortRunWindow, nextLog.length - 1));
    let mass = 0;
    for (let r = 0; r <= upto; r++) mass += Math.exp(nextLog[r]!);
    pChange.push(Math.max(0, Math.min(1, mass)));

    const nextParams = new Array(params.length + 1);
    nextParams[0] = { mu: mu0, kappa: kappa0, alpha: alpha0, beta: beta0 };
    for (let r = 0; r < params.length; r++) {
      const pp = params[r]!;
      const kappa = pp.kappa + 1;
      const mu = (pp.kappa * pp.mu + x) / kappa;
      const alpha = pp.alpha + 0.5;
      const beta = pp.beta + 0.5 * (pp.kappa / kappa) * (x - pp.mu) ** 2;
      nextParams[r + 1] = { mu, kappa, alpha, beta };
    }
    logRun = nextLog;
    params = nextParams;
  }

  return pChange;
}

function studentTLogPdf(x: number, mu: number, kappa: number, alpha: number, beta: number): number {
  const df = 2 * alpha;
  const scaleSq = (beta * (kappa + 1)) / (alpha * kappa);
  if (!(scaleSq > 0) || !isFinite(scaleSq)) return -Infinity;
  const scale = Math.sqrt(scaleSq);
  const y = (x - mu) / scale;
  return logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI) -
    Math.log(scale) - ((df + 1) / 2) * Math.log1p((y * y) / df);
}

function logSumExp(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < cof.length; j++) {
    y += 1;
    ser += cof[j]! / y;
  }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function bootstrapDiff(a: number[], b: number[], iters = 400, seed = 4242): { lo: number; hi: number } {
  const rng = testRng(seed);
  const diffs: number[] = [];
  for (let it = 0; it < iters; it++) {
    const sa: number[] = [], sb: number[] = [];
    for (let i = 0; i < a.length; i++) sa.push(a[Math.floor(rng() * a.length)]!);
    for (let i = 0; i < b.length; i++) sb.push(b[Math.floor(rng() * b.length)]!);
    diffs.push(mean(sb) - mean(sa));
  }
  diffs.sort((x, y) => x - y);
  const at = (q: number) => diffs[Math.max(0, Math.min(diffs.length - 1, Math.floor(q * (diffs.length - 1))))]!;
  return { lo: at(0.025), hi: at(0.975) };
}

function toFinding(c: Candidate): Finding {
  const p = c.probability;
  const diff = c.afterMean - c.beforeMean;
  const rel = diff / Math.max(Math.abs(c.beforeMean), 1e-9);
  const ci = bootstrapDiff(c.before, c.after);
  const relLo = ci.lo / Math.max(Math.abs(c.beforeMean), 1e-9);
  const relHi = ci.hi / Math.max(Math.abs(c.beforeMean), 1e-9);
  const permP = diff >= 0 ? permTestOneSided(c.after, c.before) : permTestOneSided(c.before, c.after);
  const absMonthly = Math.abs(diff) * ((c.beforeN + c.afterN) / c.spanDays) * 30;
  if (c.kind === "interval") {
    const more = c.afterMean < c.beforeMean;
    return {
      detector: "bocpd_regime",
      id: `bocpd_regime:interval:${c.key}:${c.index}`,
      title: `${c.display} buys likely got ${more ? "more frequent" : "less frequent"} from about ${shortDate(c.changeAt)} (${c.beforeMean.toFixed(1)}d → ${c.afterMean.toFixed(1)}d)`,
      n: c.beforeN + c.afterN,
      pValue: permP,
      effect: { abs: Math.abs(diff), rel: Math.abs(rel), unit: "days", lo: Math.abs(relLo), hi: Math.abs(relHi) },
      evidence: {
        label: c.label, counterparty: c.counterparty, changeAt: c.changeAt,
        beforeMean: c.beforeMean, afterMean: c.afterMean, probability: p, kind: "interval", unit: "days",
        group: c.key, beforeN: c.beforeN, afterN: c.afterN, lo: ci.lo, hi: ci.hi,
      },
    };
  }
  const rose = diff >= 0;
  const pctLo = Math.max(1, Math.round(Math.abs(relLo) * 100));
  const pctHi = Math.max(pctLo, Math.round(Math.abs(relHi) * 100));
  return {
    detector: "bocpd_regime",
    id: `bocpd_regime:amount:${c.key}:${c.index}`,
    title: `Spending on ${c.display} likely ${rose ? "rose" : "fell"} ${pctLo}–${pctHi}% from about ${shortDate(c.changeAt)}`,
    n: c.beforeN + c.afterN,
    pValue: permP,
    effect: { abs: Math.abs(diff), rel: Math.abs(rel), unit: "cents", lo: Math.abs(relLo), hi: Math.abs(relHi), absMonthlyCents: absMonthly },
    evidence: {
      label: c.label, counterparty: c.counterparty, changeAt: c.changeAt,
      beforeMean: c.beforeMean, afterMean: c.afterMean, beforeMeanCents: c.beforeMean, afterMeanCents: c.afterMean,
      probability: p, kind: "amount", unit: "cents", group: c.key, beforeN: c.beforeN, afterN: c.afterN,
      lo: ci.lo, hi: ci.hi, absMonthlyCents: absMonthly,
    },
  };
}

function prettyCounterparty(txs: LedgerTx[]): string {
  const named = txs.find((t) => (t.counterpartyName ?? "").trim().length > 0)?.counterpartyName?.trim();
  if (named) return named;
  const key = txs[0]?.counterpartyKey ?? "";
  if (key.startsWith("p:")) return "a phone contact";
  if (key.startsWith("t:")) return "a till";
  return key.replace(/^[a-z]:/, "").replace(/[_-]+/g, " ") || "this counterparty";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(ms: number): string {
  const p = toEatParts(ms);
  return `${p.day} ${MONTHS[p.month - 1] ?? ""}`;
}

function kes(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}
