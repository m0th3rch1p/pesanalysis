/** Alert engine types (F-ALERTS). Money = integer cents; times = epoch ms, calendar days are EAT. */
export type AlertSeverity = "low" | "normal" | "high" | "safety";
export const SEVERITY_RANK: Record<AlertSeverity, number> = { low: 1, normal: 2, high: 3, safety: 4 };
export const SEVERITIES: AlertSeverity[] = ["low", "normal", "high", "safety"];

export interface AlertCandidate {
  ruleId: string;
  /** stable identity of the subject (e.g. "obl:12"); the same thing keeps the same id across runs */
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** lock-screen text: never contains amounts, names or counterparties */
  redactedBody: string;
  action: { kind: "deeplink"; url: string };
  /** identity of one "occurrence" (id + period/level); cooldown and once-per-period work on this */
  dedupeKey: string;
  cooldownMs: number;
  expiresAt: number;
  subjectRef?: string;
  /** Every money alert must say what happened, when it matters, and what is at stake. */
  what?: string; when?: string; stake?: string;
  /** Optional extra actions in addition to action (the evidence link). */
  actions?: Array<{ kind: "open" | "snooze" | "dismiss"; label: string; url?: string }>;
  evidenceUrl?: string;
}

export interface FloatFacts {
  balanceCents: number | null;
  freeFloatCents: number | null;
  daysToZeroExpected: number | null;
  daysToZeroPessimistic: number | null;
  quality: "ok" | "estimate" | "unknown";
}
export interface ObligationFact { id: number | string; name: string; dueOn: string; remainingCents: number }
export interface IncomeFact { id: number | string; name: string; dueOn: string; expectedCents: number; state: "upcoming" | "matched" | "late" | "partial" | "missed" | "waived" }
export interface BudgetFact {
  id: number | string; name: string; limitCents: number; spentCents: number;
  /** projected end-of-period spend, null when not computable */
  projectedCents: number | null;
  periodStartDay: string; periodEndDay: string;
  elapsedFraction: number;
}
export interface FulizaFact { outstandingCents: number; oldestDrawAt: number | null; sweepAbsorbedCents: number; nextInflowDueOn: string | null }
export interface PendingSendFact { amountCents: number; feeCents: number; cheaperAmountCents: number | null; cheaperFeeCents: number | null; counterpartyKey?: string }
export interface FailedAttemptFact { kind: string; counterpartyKey?: string; atMs: number[] }
export interface BundleFact { id: number | string; kind: string; label: string; remaining: number; initial: number; expiresAt: number | null }
export interface SpendFacts {
  recent: Array<{ txId: number; amountCents: number; at: number }>;
  todayCents: number;
  txP95Cents: number | null;
  dailyP90Cents: number | null;
  sampleN: number;
}
export interface FeeFacts { feeCents30d: number; spendCents30d: number; priorFeeCents30d?: number }

export interface AlertConfig {
  lowFloatCents: number;
  dueSoonDays: number;
  daysToZeroWithin: number;
  budgetLevels: number[];
  fulizaAgeDays: { low: number; normal: number; high: number };
  tariffMinSavingCents: number;
  tariffMaxAmountGiveUpFraction: number;
  failedWindowMs: number;
  failedMinCount: number;
  bundleLowFraction: number;
  bundleVeryLowFraction: number;
  unusualTxMultiple: number;
  unusualDayMultiple: number;
  unusualMinSample: number;
  unusualMinCents: number;
  feeDragShare: number;
  feeDragMinCents: number;
}

export interface AlertSnapshot {
  nowMs: number;
  float?: FloatFacts;
  obligations?: ObligationFact[];
  income?: IncomeFact[];
  budgets?: BudgetFact[];
  fuliza?: FulizaFact;
  pendingSend?: PendingSendFact;
  failedAttempts?: FailedAttemptFact[];
  bundles?: BundleFact[];
  spend?: SpendFacts;
  fees?: FeeFacts;
  config?: Partial<AlertConfig>;
}

export interface AlertRule {
  id: string;
  description: string;
  defaultSeverity: AlertSeverity;
  evaluate(s: AlertSnapshot, cfg: AlertConfig): AlertCandidate[];
}
