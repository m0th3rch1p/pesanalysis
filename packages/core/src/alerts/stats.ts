/** Counter-metrics: per-rule usefulness (acted / dismissed / ignored). Pure. */
import { DAY_MS } from "../expect/eat.js";

export interface AlertOutcomeRow {
  ruleId: string;
  deliveredAt: number;
  openedAt?: number | null;
  actedAt?: number | null;
  dismissedAt?: number | null;
  useful?: number | null; // 1 | 0 | null
}

export type AlertOutcome = "acted" | "dismissed" | "opened" | "ignored" | "pending";

export interface RuleStats {
  ruleId: string;
  delivered: number;
  acted: number;
  dismissed: number;
  opened: number;
  ignored: number;
  pending: number;
  usefulYes: number;
  usefulNo: number;
  /** delivered minus pending; the denominator of every rate */
  resolved: number;
  actedRate: number | null;
  dismissedRate: number | null;
  ignoredRate: number | null;
  demoted: boolean;
}

export interface DemotionPolicy {
  ignoreAfterMs: number;
  minResolved: number;
  maxActedRate: number;
  minNoiseRate: number;
}
export const DEFAULT_DEMOTION: DemotionPolicy = { ignoreAfterMs: 2 * DAY_MS, minResolved: 10, maxActedRate: 0.1, minNoiseRate: 0.7 };

export function classifyOutcome(r: AlertOutcomeRow, nowMs: number, ignoreAfterMs = DEFAULT_DEMOTION.ignoreAfterMs): AlertOutcome {
  if (r.actedAt != null) return "acted";
  if (r.dismissedAt != null) return "dismissed";
  if (r.openedAt != null) return "opened";
  return nowMs - r.deliveredAt >= ignoreAfterMs ? "ignored" : "pending";
}

/** Safety rules are never demoted (callers pass their ids in `neverDemote`). */
export function computeRuleStats(rows: AlertOutcomeRow[], nowMs: number, policy: DemotionPolicy = DEFAULT_DEMOTION, neverDemote: ReadonlySet<string> = new Set()): Map<string, RuleStats> {
  const m = new Map<string, RuleStats>();
  for (const r of rows) {
    let s = m.get(r.ruleId);
    if (!s) {
      s = { ruleId: r.ruleId, delivered: 0, acted: 0, dismissed: 0, opened: 0, ignored: 0, pending: 0, usefulYes: 0, usefulNo: 0, resolved: 0, actedRate: null, dismissedRate: null, ignoredRate: null, demoted: false };
      m.set(r.ruleId, s);
    }
    s.delivered++;
    s[classifyOutcome(r, nowMs, policy.ignoreAfterMs)]++;
    if (r.useful === 1) s.usefulYes++;
    if (r.useful === 0) s.usefulNo++;
  }
  for (const s of m.values()) {
    s.resolved = s.delivered - s.pending;
    if (s.resolved > 0) {
      s.actedRate = s.acted / s.resolved;
      s.dismissedRate = s.dismissed / s.resolved;
      s.ignoredRate = s.ignored / s.resolved;
    }
    s.demoted = !neverDemote.has(s.ruleId) && isNoisy(s, policy);
  }
  return m;
}

/** Noisy = enough evidence, almost never acted on, and mostly dismissed or ignored. Reversible: recomputed from history. */
export function isNoisy(s: RuleStats, policy: DemotionPolicy = DEFAULT_DEMOTION): boolean {
  if (s.resolved < policy.minResolved || s.actedRate == null) return false;
  const noise = (s.dismissed + s.ignored) / s.resolved;
  return s.actedRate <= policy.maxActedRate && noise >= policy.minNoiseRate;
}
