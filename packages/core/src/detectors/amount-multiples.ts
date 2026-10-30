import type { Detector, Finding, LedgerTx } from "./types.js";
import { binomTail } from "./stats.js";

export interface AmountMultiplesOpts {
  minN?: number;        // min transactions in a group (default 15)
  maxP?: number;        // significance threshold (default 1e-4)
  minShare?: number;    // share of amounts that must be multiples (default 0.9)
  bases?: number[];     // candidate bases in whole KES, largest-first
}

/**
 * "Price point" structure: a counterparty (or a whole direction) whose amounts are consistently
 * multiples of a base (50/100/150 => base 50). Null = a random amount is a multiple of b with
 * probability max(1/b, rate observed in OTHER-direction baseline) because humans over-use round
 * numbers; ignoring that would flag everyone. Needs >=2 distinct amounts (else it's a fixed price,
 * a different pattern).
 */
export const detectAmountMultiples: Detector<AmountMultiplesOpts> = (txs, opts = {}) => {
  const { minN = 15, maxP = 1e-4, minShare = 0.9, bases = [500, 250, 100, 50, 25] } = opts;
  const out: Finding[] = [];
  const groups = new Map<string, LedgerTx[]>();
  for (const t of txs) {
    if (t.direction === "neutral") continue;
    const dirKey = `dir:${t.direction}`;
    (groups.get(dirKey) ?? groups.set(dirKey, []).get(dirKey)!).push(t);
    if (t.counterpartyKey) {
      const ck = `cp:${t.direction}:${t.counterpartyKey}`;
      (groups.get(ck) ?? groups.set(ck, []).get(ck)!).push(t);
    }
  }
  const baselineShare = (b: number, dir: string) => {
    const other = txs.filter((t) => t.direction !== dir && t.direction !== "neutral" && t.amount % 100 === 0);
    if (other.length < 30) return 0;
    return other.filter((t) => (t.amount / 100) % b === 0).length / other.length;
  };
  for (const [key, g] of groups) {
    const whole = g.filter((t) => t.amount % 100 === 0);
    if (whole.length < minN) continue;
    if (new Set(whole.map((t) => t.amount)).size < 2) continue;
    const dir = key.includes(":in") ? "in" : "out";
    for (const b of bases) {
      const k = whole.filter((t) => (t.amount / 100) % b === 0).length;
      if (k / whole.length < minShare) continue;
      const p0 = Math.max(1 / b, baselineShare(b, dir));
      const p = binomTail(whole.length, k, p0);
      if (p < maxP) {
        out.push({
          detector: "amount_multiples", id: `amount_multiples:${key}:${b}`,
          title: `${Math.round((100 * k) / whole.length)}% of ${key.startsWith("dir") ? `all ${dir}going` : "this counterparty's"} amounts are multiples of KES ${b}`,
          n: whole.length, pValue: p,
          evidence: { base: b, multiples: k, nullRate: p0, scope: key, distinctAmounts: new Set(whole.map((t) => t.amount / 100)).size },
        });
        break; // report only the largest significant base per group
      }
    }
  }
  return out;
};
