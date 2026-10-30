import type { Detector } from "./types.js";

export interface FeeDragOpts { days?: number }

const DAY_MS = 86_400_000;

/**
 * Cumulative transaction cost. Purely descriptive (n = count of fee-bearing txs), but it is the
 * single most persuasive number for the "understand your money" story: fees over a window, split
 * by source (send fees, withdrawal fees, loan fees) and as a share of throughput.
 *
 * Only STATED fees are summed. That includes the Fuliza 1% access fee, which the parser puts in `fee`
 * on the loan_draw row when the message states it (`Access Fee charged ...`). Fuliza daily maintenance
 * fees never appear in SMS and are NOT included here: see tariffs/simulateFuliza for the estimate.
 */
export const detectFeeDrag: Detector<FeeDragOpts> = (txs, opts = {}) => {
  const { days = 90 } = opts;
  const since = Date.now() - days * DAY_MS;
  const scoped = txs.filter((t) => (t.fee ?? 0) > 0 && t.occurredAt >= since);
  const total = scoped.reduce((a, t) => a + (t.fee ?? 0), 0);
  if (scoped.length < 5 || total === 0) return [];
  const byKind = new Map<string, number>();
  for (const t of scoped) byKind.set(t.kind ?? "other", (byKind.get(t.kind ?? "other") ?? 0) + (t.fee ?? 0));
  const flow = txs.filter((t) => t.occurredAt >= since).reduce((a, t) => a + Math.abs(t.amount), 0) || 1;
  const top = [...byKind].sort((a, b) => b[1] - a[1])[0]!;
  const fulizaAccess = scoped.filter((t) => t.kind === "loan_draw").reduce((a, t) => a + (t.fee ?? 0), 0);
  const fulizaDrawsNoFee = txs.filter((t) => t.occurredAt >= since && t.kind === "loan_draw" && t.provider === "mpesa" && t.fee == null).length;
  return [{
    detector: "fee_drag",
    id: `fee_drag:${days}`,
    title: `KES ${(total / 100).toFixed(0)} in transaction fees over the last ${days} days (${((100 * total) / flow).toFixed(1)}% of flow; biggest source: ${top[0]})`,
    n: scoped.length,
    evidence: {
      totalFeesCents: total, byKind: Object.fromEntries(byKind), flowCents: flow, windowDays: days,
      fulizaAccessFeesCents: fulizaAccess, fulizaDrawsWithoutStatedFee: fulizaDrawsNoFee,
      includesFulizaDailyFees: false,
    },
  }];
};
