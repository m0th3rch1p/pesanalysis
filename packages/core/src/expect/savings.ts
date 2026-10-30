/** Savings goal arithmetic and pot guards (F-SAVINGS). Pure. */
import { type DayStr, addDays, dayOf } from "./eat.js";

export interface GoalLike { targetCents: number; savedCents: number; targetOn?: DayStr | null }

export interface GoalProgress {
  pct: number;
  remainingCents: number;
  achieved: boolean;
  /** EAT date at the observed/declared monthly saving rate; null without a positive rate. */
  projectedCompletionOn: DayStr | null;
  /** monthly saving needed to hit targetOn from now; null without a target date. */
  requiredMonthlyCents: number | null;
  behindPace: boolean | null;
}

/** `monthlyRateCents` = declared auto-rule or observed saving rate. 30-day months. */
export function goalProgress(g: GoalLike, nowMs: number, monthlyRateCents: number | null): GoalProgress {
  const remaining = Math.max(0, g.targetCents - g.savedCents);
  const pct = g.targetCents > 0 ? Math.min(100, Math.floor((g.savedCents * 100) / g.targetCents)) : 100;
  const today = dayOf(nowMs);
  const projected = remaining === 0 ? today
    : monthlyRateCents && monthlyRateCents > 0 ? addDays(today, Math.ceil((remaining / monthlyRateCents) * 30)) : null;
  let required: number | null = null, behind: boolean | null = null;
  if (g.targetOn) {
    const daysLeft = Math.max(1, (Date.parse(`${g.targetOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    required = Math.ceil((remaining / daysLeft) * 30);
    behind = remaining > 0 && (monthlyRateCents == null || monthlyRateCents < required);
  }
  return { pct, remainingCents: remaining, achieved: remaining === 0, projectedCompletionOn: projected, requiredMonthlyCents: required, behindPace: behind };
}

/** A pot is a bookkeeping boundary, not a lock. True when spending `amountCents` would eat into earmarked money. */
export function dipsIntoPots(walletBalanceCents: number, potsCents: number, amountCents: number): boolean {
  return potsCents > 0 && walletBalanceCents - amountCents < potsCents;
}

/** Wallet money not earmarked in a pot. */
export function availableOutsidePots(walletBalanceCents: number, potsCents: number): number {
  return walletBalanceCents - Math.max(0, potsCents);
}
