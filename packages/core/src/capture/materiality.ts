/** Materiality: should we interrupt the user about this transaction now? Pure. */
import { HOUR_MS, MIN_MS, atMinuteOfDay, inQuietHours, nextQuietEnd, DEFAULT_QUIET, type QuietHours } from "../alerts/quiet.js";
import { DAY_MS } from "../expect/eat.js";
import { detailCompleteness, type DetailFlags } from "./completeness.js";

export type CaptureTier = "full" | "single" | "batch" | "none";

export interface CaptureTx {
  id: number;
  amountCents: number;
  feeCents: number;
  direction: "in" | "out";
  occurredAt: number;
  counterpartyKey: string | null;
  /** how many earlier transactions share this counterparty */
  counterpartyPriorCount: number;
  labelId: number | null;
  /** 0..1 confidence of an auto label; user-set labels should pass 1 */
  labelConfidence: number;
  labelSource: "user" | "auto" | "none";
  /** probability this is business-scope */
  businessProb: number;
  /** fee the tariff table predicts for this movement; null when unknown */
  expectedFeeCents: number | null;
  details: Partial<DetailFlags>;
}

export interface MaterialityPrefs {
  /** history needed before percentiles are trusted */
  minHistory: number;
  fullPercentile: number;
  batchMaxPercentile: number;
  /** used when history is short: amounts at/above this are material; below `smallCents` can batch */
  fallbackFullCents: number;
  smallCents: number;
  businessThreshold: number;
  autoFileConfidence: number;
  recurringMinCount: number;
  feeAnomalyRatio: number;
  feeAnomalyMinExtraCents: number;
}
export const DEFAULT_MATERIALITY: MaterialityPrefs = {
  minHistory: 20, fullPercentile: 0.8, batchMaxPercentile: 0.5, fallbackFullCents: 100_000, smallCents: 10_000,
  businessThreshold: 0.5, autoFileConfidence: 0.8, recurringMinCount: 3, feeAnomalyRatio: 1.5, feeAnomalyMinExtraCents: 500,
};

export type MaterialityReason =
  | "large_for_you" | "novel_counterparty" | "unlabelled_recurring" | "business_likely" | "fee_anomaly"
  | "low_confidence_label" | "small_auto_filed" | "already_complete" | "unlabelled";

export interface Materiality {
  tier: CaptureTier;
  /** 0..1, for ordering the Needs-you queue */
  score: number;
  percentile: number | null;
  reasons: MaterialityReason[];
}

/** Share of history <= amount (mid-rank for ties). null when there is too little history. */
export function amountPercentile(amount: number, history: number[], minHistory = DEFAULT_MATERIALITY.minHistory): number | null {
  if (history.length < minHistory) return null;
  let below = 0, equal = 0;
  for (const h of history) { if (h < amount) below++; else if (h === amount) equal++; }
  return (below + equal / 2) / history.length;
}

export function feeIsAnomalous(feeCents: number, expectedFeeCents: number | null, p: MaterialityPrefs = DEFAULT_MATERIALITY): boolean {
  if (expectedFeeCents == null) return false;
  if (feeCents <= expectedFeeCents) return false;
  return feeCents - expectedFeeCents >= p.feeAnomalyMinExtraCents && feeCents >= expectedFeeCents * p.feeAnomalyRatio;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function assessMateriality(tx: CaptureTx, spendHistoryCents: number[], prefs: Partial<MaterialityPrefs> = {}): Materiality {
  const p = { ...DEFAULT_MATERIALITY, ...prefs };
  const reasons: MaterialityReason[] = [];
  if (detailCompleteness(tx.details).submitted) return { tier: "none", score: 0, percentile: null, reasons: ["already_complete"] };

  const pct = amountPercentile(tx.amountCents, spendHistoryCents, p.minHistory);
  const large = pct != null ? pct >= p.fullPercentile : tx.amountCents >= p.fallbackFullCents;
  const mid = pct != null ? pct >= p.batchMaxPercentile : tx.amountCents >= p.smallCents;
  const amountScore = pct ?? clamp01(tx.amountCents / (p.fallbackFullCents * 2));
  const novel = tx.counterpartyKey != null && tx.counterpartyPriorCount === 0;
  const labelled = tx.labelId != null;
  const unlabRecurring = !labelled && tx.counterpartyKey != null && tx.counterpartyPriorCount >= p.recurringMinCount;
  const biz = tx.businessProb >= p.businessThreshold;
  const feeAnom = feeIsAnomalous(tx.feeCents, tx.expectedFeeCents, p);
  const lowConf = labelled && tx.labelSource === "auto" && tx.labelConfidence < p.autoFileConfidence;

  if (large) reasons.push("large_for_you");
  if (novel) reasons.push("novel_counterparty");
  if (unlabRecurring) reasons.push("unlabelled_recurring");
  if (biz) reasons.push("business_likely");
  if (feeAnom) reasons.push("fee_anomaly");
  if (lowConf) reasons.push("low_confidence_label");
  if (!labelled) reasons.push("unlabelled");

  const score = clamp01(0.4 * amountScore + 0.2 * +novel + 0.15 * +unlabRecurring + 0.15 * clamp01(tx.businessProb) + 0.1 * +feeAnom + 0.1 * +lowConf);

  const autoFiled = labelled && tx.labelSource === "auto" && tx.labelConfidence >= p.autoFileConfidence;
  const hard = large || (novel && mid) || unlabRecurring || biz || feeAnom || lowConf;
  if (!hard && autoFiled && !novel) {
    return { tier: "batch", score, percentile: pct, reasons: [...reasons, "small_auto_filed"] };
  }
  return { tier: hard ? "full" : "single", score, percentile: pct, reasons, };
}

export interface PromptDecision extends Materiality {
  action: "prompt_now" | "defer" | "batch" | "none";
  /** when to show it: now, quiet-hours end, or the next batch digest */
  promptAtMs: number | null;
}

export const DEFAULT_DIGEST_MINUTE = 19 * 60;
export const NEXT_MORNING_MINUTE = 8 * 60;

export function nextDigestAt(nowMs: number, digestMinute = DEFAULT_DIGEST_MINUTE): number {
  const today = atMinuteOfDay(nowMs, digestMinute);
  return today > nowMs ? today : today + DAY_MS;
}

/** The "prompt now?" decision for one transaction. */
export function decidePrompt(tx: CaptureTx, spendHistoryCents: number[], nowMs: number, opts: { prefs?: Partial<MaterialityPrefs>; quiet?: QuietHours; digestMinute?: number; quietPolicy?: "ask_anyway" | "hold" } = {}): PromptDecision {
  const m = assessMateriality(tx, spendHistoryCents, opts.prefs);
  const quiet = opts.quiet ?? DEFAULT_QUIET;
  if (m.tier === "none") return { ...m, action: "none", promptAtMs: null };
  if (m.tier === "batch") return { ...m, action: "batch", promptAtMs: nextDigestAt(nowMs, opts.digestMinute) };
  // D109: during quiet hours a payment means the user is awake and transacting; ask now unless
  // they explicitly chose to hold questions until morning.
  if (inQuietHours(nowMs, quiet) && (opts.quietPolicy ?? "ask_anyway") === "hold") {
    return { ...m, action: "defer", promptAtMs: nextQuietEnd(nowMs, quiet) };
  }
  return { ...m, action: "prompt_now", promptAtMs: nowMs };
}

export { HOUR_MS, MIN_MS };
