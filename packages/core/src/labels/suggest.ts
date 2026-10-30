import type { ParsedSms } from "../types.js";
import { SEED_RULES, kindDefaultLabel, type RuleCtx } from "./rules.js";
import { knnLabel, type KnnItem } from "./knn.js";
import { kindClass, labelAllowedForKind } from "./taxonomy.js";
import { wilson } from "../detectors/stats.js";

export type { KnnItem };
export type SuggestionSource = "rule" | "knn" | "kind_default" | "counterparty";

export interface Suggestion {
  label: string;
  /** calibrated 0..1 confidence; null when abstaining */
  confidence: number;
  source: SuggestionSource;
  /** top-3 alternates for the one-tap UI (label + confidence) */
  alternates: Array<{ label: string; confidence: number; source: SuggestionSource }>;
}

export interface SuggestOpts {
  /** confirmed history for kNN (user's own corrections are the training data) */
  history?: KnnItem[];
  /** above this, the notification says "auto-filed" instead of asking (DECISIONS: D8) */
  autoFileThreshold?: number;
  /** below this the suggestion is offered without confidence language */
  minConfidence?: number;
  /** Sticky category from this exact counterparty's confirmed history. */
  counterpartyDefault?: { label: string; confidence: number } | null;
}

const AUTO = 0.85, MIN = 0.4;

/** Neighbours below this cosine similarity never vote (tuned on gold, WS0.3). */
export const KNN_MIN_SIM = 0.35;
/** Little confirmed history means low confidence, however clean the neighbours look. */
const KNN_FULL_HISTORY = 20;

/**
 * Label suggestion: rules first (high precision), kNN second (learns from the user's own
 * confirmations), kind-defaults last. "We don't know" is a valid output (confidence null).
 * Confidence calibration: rule conf is a prior; kNN confidence = Wilson lower bound of the
 * neighbour agreement weighted by margin — conservative by construction.
 */
export function suggestLabel(parsed: ParsedSms, opts: SuggestOpts = {}): Suggestion | null {
  const hay = [parsed.counterpartyName, parsed.account, parsed.template, parsed.counterpartyId]
    .filter(Boolean).join(" ").toLowerCase();

  const candidates: Suggestion[] = [];
  if (opts.counterpartyDefault) {
    candidates.push({
      label: opts.counterpartyDefault.label,
      confidence: opts.counterpartyDefault.confidence,
      source: "counterparty", alternates: [],
    });
  }
  for (const r of SEED_RULES) if (r.test({ parsed, hay })) candidates.push({ label: r.label, confidence: r.conf, source: "rule", alternates: [] });

  if (opts.history?.length) {
    // Kind compatibility: a neighbour may vote only when it comes from the same class,
    // or when its label is explicitly allowed for the query's class. This stops an
    // "Airtime & data" confirmation at a telco leaking onto banks, people or shops.
    const qClass = kindClass(parsed.kind);
    const history = opts.history.filter((h) => {
      if (!h.kind) return true; // legacy rows without kind: keep learning, guarded by label set
      if (kindClass(h.kind) === qClass) return true;
      return labelAllowedForKind(parsed.kind, h.label);
    });
    const knn = history.length ? knnLabel(hay, history, 5, KNN_MIN_SIM) : null;
    if (knn) {
      const agreeing = knn.top.filter((h) => h.label === knn.label);
      const k = knn.top.length;
      // Two independent, similar, agreeing confirmations are the minimum evidence.
      if (agreeing.length >= 2 && labelAllowedForKind(parsed.kind, knn.label)) {
        const w = wilson(agreeing.length, k);
        let conf = Math.min(w.lo + 0.1, 0.9);
        if (opts.history.length < KNN_FULL_HISTORY) conf = Math.min(conf, 0.6);
        candidates.push({ label: knn.label, confidence: conf, source: "knn", alternates: [] });
      }
    }
  }

  const kd = kindDefaultLabel(parsed.kind);
  if (kd) {
    // A kind default is a guess, never stronger than what this counterparty has taught us.
    const conf = opts.counterpartyDefault ? Math.min(0.55, opts.counterpartyDefault.confidence) : 0.55;
    candidates.push({ label: kd, confidence: conf, source: "kind_default", alternates: [] });
  }

  // Direction guard: never suggest an income label for an outflow or an expense label for an inflow.
  const INCOME = new Set(["Sales (business)", "Salary", "Transfer in", "Other income"]);
  const compatible = candidates.filter((c) =>
    parsed.direction === "in" ? INCOME.has(c.label)
      : parsed.direction === "out" ? !INCOME.has(c.label)
      : true,
  );
  if (!compatible.length) return null;
  candidates.splice(0, candidates.length, ...compatible);

  if (!candidates.length) return null;

  // dedupe by label keeping the max-confidence source, then rank
  const byLabel = new Map<string, Suggestion>();
  for (const c of candidates) {
    const prev = byLabel.get(c.label);
    if (!prev || c.confidence > prev.confidence) byLabel.set(c.label, c);
  }
  const ranked = [...byLabel.values()].sort((a, b) => b.confidence - a.confidence);
  const top = ranked[0]!;
  return {
    label: top.label,
    confidence: top.confidence,
    source: top.source,
    alternates: ranked.slice(1, 3).map((c) => ({ label: c.label, confidence: c.confidence, source: c.source })),
  };
}

/**
 * Notification decision (DECISIONS D8): every captured money movement gets a
 * notification. No suggestion still means ASK ("what was this for?"), not silence;
 * only standalone fee lines are silent (they belong to the loan/withdrawal they
 * accompany and would be noise on their own).
 */
export function notificationKind(s: Suggestion | null, kind?: string): "ask" | "auto" | "silent" {
  if (!s) return kind === "fee" ? "silent" : "ask";
  return s.confidence >= AUTO ? "auto" : "ask";
}
