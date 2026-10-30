/**
 * Outcome audit: did the outcome metric move after the decision started? Honest by construction:
 * - below `minPerSide` days on either side the result is "insufficient_data" and no effect size is claimed;
 * - above it the effect is reported with a 95% interval; "improved"/"worsened" only if the interval excludes zero;
 * - it is always labelled observational (no control group, days are autocorrelated), so the interval is optimistic.
 */
import { type DayStr, addDays, diffDays } from "../expect/eat.js";
import type { JournalRule, JournalLedgerTx } from "./rules.js";

export interface DailyPoint { day: DayStr; value: number }

export type AuditVerdict = "insufficient_data" | "inconclusive" | "improved" | "worsened";

export interface OutcomeAudit {
  verdict: AuditVerdict;
  betterWhen: "lower" | "higher";
  before: { n: number; mean: number | null };
  after: { n: number; mean: number | null };
  /** after - before; null when insufficient */
  diff: number | null;
  interval: { low: number; high: number } | null;
  minPerSide: number;
  /** true only when sample is sufficient and the interval excludes zero */
  intervalExcludesZero: boolean;
  caveat: string;
  summary: string;
}

export const DEFAULT_MIN_PER_SIDE = 14;

const T95: Array<[number, number]> = [[1, 12.71], [2, 4.30], [3, 3.18], [4, 2.78], [5, 2.57], [6, 2.45], [7, 2.36], [8, 2.31], [9, 2.26], [10, 2.23], [15, 2.13], [20, 2.09], [30, 2.04], [60, 2.0]];
export function tCritical95(df: number): number {
  if (!(df >= 1)) return Infinity;
  for (const [d, t] of T95) if (df <= d) return t;
  return 1.96;
}

function meanVar(xs: number[]): { mean: number; v: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, v };
}

export function auditOutcome(series: DailyPoint[], startOn: DayStr, opts: { betterWhen?: "lower" | "higher"; minPerSide?: number; baselineDays?: number; endOn?: DayStr | null } = {}): OutcomeAudit {
  const betterWhen = opts.betterWhen ?? "lower";
  const minPerSide = opts.minPerSide ?? DEFAULT_MIN_PER_SIDE;
  const baselineDays = opts.baselineDays ?? 56;
  const before = series.filter((p) => p.day < startOn && diffDays(startOn, p.day) <= baselineDays).map((p) => p.value);
  const after = series.filter((p) => p.day >= startOn && (!opts.endOn || p.day <= opts.endOn)).map((p) => p.value);
  const caveat = "Observational: no control group and neighbouring days are not independent, so the interval understates real uncertainty.";
  const b = before.length ? meanVar(before) : null, a = after.length ? meanVar(after) : null;
  const base = { betterWhen, before: { n: before.length, mean: b?.mean ?? null }, after: { n: after.length, mean: a?.mean ?? null }, minPerSide, caveat };
  if (before.length < minPerSide || after.length < minPerSide || !a || !b) {
    return { ...base, verdict: "insufficient_data", diff: null, interval: null, intervalExcludesZero: false,
      summary: `${before.length} days before and ${after.length} days after; at least ${minPerSide} on each side are needed before any comparison is reported.` };
  }
  const diff = a.mean - b.mean;
  const seA = a.v / after.length, seB = b.v / before.length;
  const se = Math.sqrt(seA + seB);
  const df = se === 0 ? Math.min(before.length, after.length) - 1 : (seA + seB) ** 2 / ((seA ** 2) / (after.length - 1) + (seB ** 2) / (before.length - 1));
  const half = tCritical95(df) * se;
  const interval = { low: diff - half, high: diff + half };
  const excludes = interval.low > 0 || interval.high < 0;
  const good = betterWhen === "lower" ? diff < 0 : diff > 0;
  const verdict: AuditVerdict = !excludes ? "inconclusive" : good ? "improved" : "worsened";
  return { ...base, verdict, diff, interval, intervalExcludesZero: excludes,
    summary: `${before.length} days before (mean ${b.mean.toFixed(1)}), ${after.length} days after (mean ${a.mean.toFixed(1)}); difference ${diff.toFixed(1)}, 95% interval ${interval.low.toFixed(1)} to ${interval.high.toFixed(1)}${excludes ? "" : " (includes zero)"}.` };
}

/** Daily outcome metric implied by a rule; always "lower is better" (these are all things the user wants less of). */
export function ruleMetric(rule: JournalRule): { name: string; valueOf(txs: JournalLedgerTx[]): number } {
  switch (rule.kind) {
    case "daily_spend_max": case "weekly_spend_max":
      return { name: "daily spend (cents)", valueOf: (txs) => txs.filter((t) => t.direction === "out" && (t.flowClass === "spend" || t.flowClass === "fee") && (rule.labelId == null || t.labelId === rule.labelId)).reduce((a, t) => a + (t.flowClass === "fee" ? t.amountCents : t.amountCents + (t.feeCents ?? 0)), 0) };
    case "no_fuliza_draw": return { name: "Fuliza draws per day", valueOf: (txs) => txs.filter((t) => t.isFulizaDraw).length };
    case "no_send_over": return { name: "sends over the limit per day", valueOf: (txs) => txs.filter((t) => t.direction === "out" && t.flowClass !== "fee" && t.amountCents > rule.cents).length };
    case "no_txn_after_hour": return { name: "late payments per day", valueOf: (txs) => txs.filter((t) => t.direction === "out" && new Date(t.occurredAt + 3 * 3_600_000).getUTCHours() >= rule.hour && (t.flowClass === "spend" || t.flowClass === "fee" || t.isFulizaDraw)).length };
  }
}

export function buildDailySeries(txs: JournalLedgerTx[], fromDay: DayStr, toDay: DayStr, valueOf: (txs: JournalLedgerTx[]) => number, dayOfMs: (ms: number) => DayStr): DailyPoint[] {
  const by = new Map<DayStr, JournalLedgerTx[]>();
  for (const t of txs) { const d = dayOfMs(t.occurredAt); (by.get(d) ?? by.set(d, []).get(d)!).push(t); }
  const out: DailyPoint[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push({ day: d, value: valueOf(by.get(d) ?? []) });
  return out;
}
