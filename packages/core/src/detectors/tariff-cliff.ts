import type { Detector, Finding, LedgerTx } from "./types.js";

import { expectedFee, feeBoundaries, fulizaBoundaries, fulizaDailyFee, fulizaVersionFor, tariffVersionFor } from "../tariffs/index.js";

const DAY = 86_400_000;

export interface TariffOpts {
  minSplitEvents?: number;
  minSplitAvoidableCents?: number;
  /** How far past a band edge (as a fraction of the edge) still counts as "just above". */
  nearBoundaryPct?: number;
  /** Days of Fuliza fees compared when pricing a band cliff (the free window is 3 days). */
  fulizaCliffDays?: number;
}

/** Rail whose tariff table governs a ledger row's fee. */
function railOf(t: LedgerTx): "send" | "withdraw_agent" | "withdraw_atm" | null {
  if (t.kind === "send") return "send";
  if (t.kind === "withdraw") return /^\s*atm\b/i.test(t.counterpartyName ?? "") ? "withdraw_atm" : "withdraw_agent";
  return null;
}

/** Stated fee when the message had one, else the tariff table's figure (null when the tariff is unknown). */
function feeFor(t: LedgerTx): number | null {
  if (t.fee != null) return t.fee;
  const rail = railOf(t);
  return rail ? expectedFee(rail, t.amount, t.occurredAt) : null;
}

/**
 * Tariff cliffs: (a) Fuliza draws just above a daily-fee band edge (e.g. 1000, where the 3-day grace is lost), (b) sends just
 * above a tier boundary where the fee jumps, (c) repeat sends/withdrawals to one counterparty
 * within 24h where one combined transaction would have been cheaper.
 *
 * The split-fee guard is deliberately positive rather than KES 10: tier granularity means real
 * two-payment savings are often KES 1-6, and suppressing those hides the exact leak. The detector
 * still reports only the single strongest avoidable-fee cluster.
 */
export const detectTariffCliff: Detector<TariffOpts> = (txs, opts = {}) => {
  const { minSplitEvents = 2, minSplitAvoidableCents = 1, nearBoundaryPct = 0.05, fulizaCliffDays = 3 } = opts;
  const out: Finding[] = [];

  // (a) Fuliza band cliffs, priced from the engine over the first `fulizaCliffDays` charge days.
  // Uses the draw amount as the outstanding amount (ignores prior outstanding and the access fee): conservative.
  let bestFuliza: {
    t: LedgerTx; boundaryCents: number; costCents: number; costAtBoundaryCents: number; dailyCents: number; apr: number;
    losesGrace: boolean; version: string | null;
  } | null = null;
  for (const t of txs) {
    if (!isFulizaDraw(t)) continue;
    for (const { boundaryCents } of fulizaBoundaries(t.occurredAt)) {
      if (!(t.amount > boundaryCents && t.amount <= boundaryCents * (1 + nearBoundaryPct))) continue;
      let cost = 0, costAt = 0;
      for (let d = 1; d <= fulizaCliffDays; d++) {
        cost += fulizaDailyFee(t.amount, d, { date: t.occurredAt }) ?? 0;
        costAt += fulizaDailyFee(boundaryCents, d, { date: t.occurredAt }) ?? 0;
      }
      if (cost <= costAt) continue;
      const dailyCents = fulizaDailyFee(t.amount, Number.MAX_SAFE_INTEGER, { date: t.occurredAt }) ?? 0;
      const apr = (dailyCents / t.amount) * 365 * 100;
      if (!bestFuliza || cost - costAt > bestFuliza.costCents - bestFuliza.costAtBoundaryCents) {
        bestFuliza = {
          t, boundaryCents, costCents: cost, costAtBoundaryCents: costAt, dailyCents, apr,
          losesGrace: costAt === 0, version: tariffVersionFuliza(t.occurredAt),
        };
      }
    }
  }
  if (bestFuliza) {
    const { t, boundaryCents, costCents, costAtBoundaryCents, dailyCents, apr, losesGrace, version } = bestFuliza;
    const head = `Fuliza draw of KES ${kes0(t.amount)} just over KES ${kes0(boundaryCents)}`;
    out.push({
      detector: "tariff_cliff",
      id: `tariff_cliff:fuliza:${boundaryCents / 100}`,
      title: losesGrace
        ? `${head} loses the ${fulizaCliffDays}-day grace: ${fulizaCliffDays} days costs KES ${kes2(costCents)} (~${Math.round(apr)}% APR, estimated)`
        : `${head} moves to a dearer daily band: ${fulizaCliffDays} days costs KES ${kes2(costCents)} vs KES ${kes2(costAtBoundaryCents)} at the edge (estimated)`,
      n: 1,
      evidence: {
        type: "fuliza_grace",
        boundaryKes: boundaryCents / 100,
        boundaryCents,
        amountKes: t.amount / 100,
        amountCents: t.amount,
        dailyFeeKes: dailyCents / 100,
        dailyFeeCents: dailyCents,
        threeDayCostKes: costCents / 100,
        threeDayCostCents: costCents,
        costAtBoundaryCents: costAtBoundaryCents,
        losesGrace,
        marginalAprPct: apr,
        graceDays: fulizaCliffDays,
        tariffVersion: version,
        estimated: true,
        txId: t.id,
      },
    });
  }

  // (b) Sending just above a fee boundary (edges and fees come from the tariff table).
  let bestBoundary: {
    t: LedgerTx; boundaryCents: number; overshoot: number; actualFee: number; boundaryFee: number; jump: number; version: string | null;
  } | null = null;
  for (const t of txs) {
    if (t.direction !== "out" || t.kind !== "send") continue;
    const actualFee = feeFor(t);
    if (actualFee == null) continue;
    for (const { boundaryCents, feeBelowCents } of feeBoundaries("send", t.occurredAt)) {
      if (!(t.amount > boundaryCents && t.amount <= boundaryCents * (1 + nearBoundaryPct))) continue;
      const jump = actualFee - feeBelowCents;
      if (jump <= 0) continue;
      const overshoot = t.amount - boundaryCents;
      if (!bestBoundary || jump > bestBoundary.jump ||
        (jump === bestBoundary.jump && overshoot > bestBoundary.overshoot)) {
        bestBoundary = {
          t, boundaryCents, overshoot, actualFee, boundaryFee: feeBelowCents, jump,
          version: tariffVersionFor("send", t.occurredAt)?.id ?? null,
        };
      }
    }
  }
  if (bestBoundary) {
    const { t, boundaryCents, overshoot, actualFee, boundaryFee, jump, version } = bestBoundary;
    out.push({
      detector: "tariff_cliff",
      id: `tariff_cliff:send:${boundaryCents / 100}`,
      title: `Sending KES ${kes0(t.amount)} instead of KES ${kes0(boundaryCents)} costs KES ${kes0(jump)} more in fees (KES ${kes0(boundaryFee)} -> KES ${kes0(actualFee)}) for only KES ${kes0(overshoot)} more sent`,
      n: 1,
      evidence: {
        type: "send_boundary",
        boundaryKes: boundaryCents / 100,
        boundaryCents,
        amountKes: t.amount / 100,
        amountCents: t.amount,
        overshootKes: overshoot / 100,
        overshootCents: overshoot,
        feeAtBoundaryKes: boundaryFee / 100,
        feeAtBoundaryCents: boundaryFee,
        feeAtAmountKes: actualFee / 100,
        feeAtAmountCents: actualFee,
        feeJumpKes: jump / 100,
        feeJumpCents: jump,
        tariffVersion: version,
        txId: t.id,
      },
    });
  }

  // (c) Repeated sends/withdrawals to the same counterparty inside 24h.
  const groups = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    if (t.direction !== "out" || (t.kind !== "send" && t.kind !== "withdraw") || !t.counterpartyKey) continue;
    const key = `${t.kind}:${t.counterpartyKey}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  let bestSplit: {
    kind: "send" | "withdraw"; counterparty: string; events: LedgerTx[]; total: number;
    individual: number; combined: number; avoidable: number;
  } | null = null;

  for (const [key, g] of groups) {
    const sorted = [...g].sort((a, b) => a.occurredAt - b.occurredAt);
    for (let i = 0; i < sorted.length; i++) {
      const cluster: LedgerTx[] = [];
      for (let j = i; j < sorted.length && sorted[j]!.occurredAt - sorted[i]!.occurredAt <= DAY; j++) {
        cluster.push(sorted[j]!);
        if (cluster.length < minSplitEvents) continue;
        const total = cluster.reduce((a, t) => a + t.amount, 0);
        const fees = cluster.map(feeFor);
        const rail = railOf(sorted[i]!);
        const combined = rail ? expectedFee(rail, total, sorted[i]!.occurredAt) : null;
        if (combined == null || fees.some((f) => f == null)) continue; // unknown tariff: say nothing
        const individual = (fees as number[]).reduce((a, f) => a + f, 0);
        const kind = sorted[i]!.kind as "send" | "withdraw";
        const avoidable = individual - combined;
        if (avoidable >= minSplitAvoidableCents &&
          (!bestSplit || avoidable > bestSplit.avoidable)) {
          bestSplit = {
            kind,
            counterparty: key.slice(key.indexOf(":") + 1),
            events: [...cluster],
            total,
            individual,
            combined,
            avoidable,
          };
        }
      }
    }
  }

  if (bestSplit) {
    const who = bestSplit.events.find((t) => (t.counterpartyName ?? "").trim())?.counterpartyName?.trim() ??
      (bestSplit.counterparty.startsWith("p:") ? "the same number" : bestSplit.counterparty.replace(/^[a-z]:/, ""));
    const verb = bestSplit.kind === "send" ? "sends" : "withdrawals";
    out.push({
      detector: "tariff_cliff",
      id: `tariff_cliff:split:${bestSplit.kind}:${bestSplit.counterparty}:${bestSplit.events.length}`,
      title: `${bestSplit.events.length} ${verb} to ${who} within 24h cost KES ${kes0(bestSplit.individual)} in fees vs KES ${kes0(bestSplit.combined)} for one KES ${kes0(bestSplit.total)} transaction; avoidable KES ${kes0(bestSplit.avoidable)}`,
      n: bestSplit.events.length,
      evidence: {
        type: "split_fees",
        kind: bestSplit.kind,
        counterparty: bestSplit.counterparty,
        events: bestSplit.events.length,
        totalCents: bestSplit.total,
        individualFeesCents: bestSplit.individual,
        combinedFeeCents: bestSplit.combined,
        avoidableCents: bestSplit.avoidable,
        windowHours: 24,
      },
    });
  }

  return out;
};

function isFulizaDraw(t: LedgerTx): boolean {
  if (t.kind !== "loan_draw") return false;
  const s = `${t.counterpartyKey ?? ""} ${t.counterpartyName ?? ""} ${t.label ?? ""} ${t.provider ?? ""}`.toLowerCase();
  return s.includes("fuliza") || s.trim().length === 0;
}

function tariffVersionFuliza(at: number): string | null {
  return fulizaVersionFor(at)?.id ?? null;
}

function kes0(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}

function kes2(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
