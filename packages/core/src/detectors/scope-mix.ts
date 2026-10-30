import type { Detector, Finding, LedgerTx } from "./types.js";

export interface ScopeMixOpts { minN?: number; windowDays?: number }

/**
 * Personal flows through the business wallet and vice versa. Uses counterparty ROLE (user-assigned
 * or inferred) against transaction scope. Only emits when roles exist (user-labelled data), and
 * reports where money crossed purposes: paying family (personal) from a wallet whose flows are
 * mostly business, or paying business suppliers from a personal-context flow.
 * Descriptive; the statistic is the share, n = crossing txs.
 */
export const detectScopeMix: Detector<ScopeMixOpts> = (txs, opts = {}) => {
  const { minN = 3, windowDays = 90 } = opts;
  const since = Date.now() - windowDays * 86_400_000;
  const scoped = txs.filter((t) => t.occurredAt >= since);
  // infer the wallet's dominant purpose from labelled txs
  const counts = { business: 0, personal: 0 };
  for (const t of scoped) { if (t.scope === "business") counts.business++; else if (t.scope === "personal") counts.personal++; }
  const total = counts.business + counts.personal;
  if (total < 10) return [];
  const dominant = counts.business > counts.personal ? "business" : "personal";
  const crossings = scoped.filter((t) => t.scope && t.scope !== "unknown" && t.scope !== dominant && t.role);
  if (crossings.length < minN) return [];
  const sum = crossings.reduce((a, t) => a + t.amount, 0);
  const byRole = new Map<string, number>();
  const byLabel = new Map<string, number>();
  for (const t of crossings) {
    byRole.set(t.role!, (byRole.get(t.role!) ?? 0) + t.amount);
    if (t.label) byLabel.set(t.label, (byLabel.get(t.label) ?? 0) + t.amount);
  }
  const top = [...byRole].sort((a, b) => b[1] - a[1])[0]!;
  return [{
    detector: "scope_mix",
    id: `scope_mix:${dominant}:${windowDays}`,
    title: `${crossings.length} transactions totalling KES ${(sum / 100).toFixed(0)} look ${dominant === "business" ? "personal" : "business"} but run through your mostly-${dominant} wallet (biggest: ${top[0]})`,
    n: crossings.length,
    evidence: { dominant, crossings: crossings.length, sumCents: sum, byRole: Object.fromEntries(byRole), byLabel: Object.fromEntries(byLabel), windowDays },
  }];
};
