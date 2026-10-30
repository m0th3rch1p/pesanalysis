import type { Detector, Finding, LedgerTx } from "./types.js";
import { median } from "./stats.js";

export interface DebtCycleOpts { minLoans?: number; windowDays?: number }

const DAY = 86_400_000;

/**
 * Borrow/repay loops (Fuliza, Okoa, digital lenders, bank loans). For each lender-ish group
 * (counterparty or provider on loan kinds): count draws, repays, estimate the rolling balance
 * (sum of draws - repays over the window), fee load, and the tightness of the loop
 * (median repay lag). Emits findings when the loop repeats >= minLoans times: a "cycle" is the
 * pattern where the user repeatedly borrows small and repays with fees = an expensive habit.
 */
export const detectDebtCycle: Detector<DebtCycleOpts> = (txs, opts = {}) => {
  const { minLoans = 3, windowDays = 90 } = opts;
  const since = Date.now() - windowDays * DAY;
  const out: Finding[] = [];
  const groups = new Map<string, { draws: LedgerTx[]; repays: LedgerTx[] }>();
  for (const t of txs) {
    if (t.occurredAt < since) continue;
    const isLoan = t.kind === "loan_draw" || t.kind === "loan_repay" || t.role === "lender" || (t.kind === "bank_debit" && (t.label ?? "").toLowerCase().includes("loan"));
    if (!isLoan) continue;
    const key = t.counterpartyKey ?? t.provider ?? "loan";
    const g = groups.get(key) ?? { draws: [], repays: [] };
    if (t.kind === "loan_repay") g.repays.push(t); else if (t.kind === "loan_draw") g.draws.push(t);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (g.draws.length < minLoans) continue;
    const draws = g.draws.sort((a, b) => a.occurredAt - b.occurredAt);
    const repays = [...g.repays].sort((a, b) => a.occurredAt - b.occurredAt);
    const borrowed = draws.reduce((a, t) => a + t.amount, 0);
    const repaid = repays.reduce((a, t) => a + t.amount, 0);
    const fees = [...draws, ...repays].reduce((a, t) => a + (t.fee ?? 0), 0);
    // Repay lag: for each draw, the first repayment at or after it. Never negative,
    // and robust to repayments that predate a later draw.
    const lags: number[] = [];
    for (const d of draws) {
      const r = repays.find((x) => x.occurredAt >= d.occurredAt);
      if (r) lags.push(r.occurredAt - d.occurredAt);
    }
    const lagD = lags.length ? median(lags) / DAY : NaN;
    const who = draws[0]?.counterpartyName ?? prettyLender(key);
    out.push({
      detector: "debt_cycle",
      id: `debt_cycle:${key}:${windowDays}`,
      title: `${draws.length} loans from ${who} in ${windowDays} days (borrowed KES ${(borrowed / 100).toFixed(0)}, repaid KES ${(repaid / 100).toFixed(0)}, fees KES ${(fees / 100).toFixed(0)}${isFinite(lagD) ? `, repaid in ~${lagD.toFixed(1)}d` : ""})`,
      n: draws.length + repays.length,
      evidence: { lender: key, draws: draws.length, repays: repays.length, borrowedCents: borrowed, repaidCents: repaid, feesCents: fees, meanRepayLagDays: isFinite(lagD) ? lagD : null, windowDays },
    });
  }
  return out;
};

function prettyLender(key: string): string {
  if (key.startsWith("p:")) return "a phone-number lender";
  if (key.startsWith("t:")) return `till ${key.slice(2)}`;
  return key.replace(/^n:/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
