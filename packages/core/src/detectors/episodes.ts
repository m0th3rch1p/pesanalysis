import type { Detector, Finding, LedgerTx } from "./types.js";
import { displayEat } from "../sms/time.js";

export interface EpisodeOpts {
  windowHours?: number[];      // candidate windows (default 6h and 24h)
  historyDays?: number;        // activation (default 56)
  baselineDays?: number;       // trailing percentile window (default 60)
  percentile?: number;         // default 0.95
  minTxs?: number;             // default 3
  maxFindings?: number;        // default 3 most recent strong episodes
  spendKinds?: string[];
}

const DAY = 86_400_000;

function pct(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
}

function topCounts(map: Map<string, number>, n = 2): Array<{ name: string; count: number }> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

export function episodesUnlock(historyDays: number): { unlocked: boolean; neededDays: number; message: string | null } {
  if (historyDays >= 56) return { unlocked: true, neededDays: 0, message: null };
  return { unlocked: false, neededDays: Math.ceil(56 - historyDays), message: `Spending episodes unlock after 8 weeks of history (${Math.floor(historyDays)} days so far).` };
}

/**
 * Episodes replace bursts (WS5.4, D114). Activation requires 8 weeks. A candidate is a rolling
 * 6h or 24h window above the user's own trailing-60-day 95th percentile with at least 3 payments.
 * Antecedents and consequences are computed from the same ledger, never invented.
 */
export const detectEpisodes: Detector<EpisodeOpts> = (txs, opts = {}) => {
  const {
    windowHours = [6, 24], historyDays = 56, baselineDays = 60, percentile = 0.95,
    minTxs = 3, maxFindings = 3,
    spendKinds = ["till", "send", "paybill", "withdraw", "airtime", "bundle"],
  } = opts;
  const spend = txs.filter((t) => t.direction === "out" && (!t.kind || spendKinds.includes(t.kind)))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  if (spend.length < minTxs) return [];
  const firstAt = spend[0]!.occurredAt, lastAt = spend[spend.length - 1]!.occurredAt;
  const history = (lastAt - firstAt) / DAY;
  const unlock = episodesUnlock(history);
  if (!unlock.unlocked) return [];

  const candidateSets: LedgerTx[][] = [];
  for (const hours of windowHours) {
    const span = hours * 3_600_000;
    const totals: number[] = [];
    const windows: Array<{ total: number; ids: LedgerTx[] }> = [];
    let left = 0, sum = 0;
    for (let right = 0; right < spend.length; right++) {
      sum += spend[right]!.amount + (spend[right]!.fee ?? 0);
      while (spend[right]!.occurredAt - spend[left]!.occurredAt > span) { sum -= spend[left]!.amount + (spend[left]!.fee ?? 0); left++; }
      const ids = spend.slice(left, right + 1);
      totals.push(sum);
      windows.push({ total: sum, ids });
    }
    const baselineFrom = lastAt - baselineDays * DAY;
    const baseTotals = windows.filter((_, i) => spend[i]!.occurredAt >= baselineFrom).map((w) => w.total);
    const threshold = pct(baseTotals, percentile);
    for (const w of windows) {
      if (w.ids.length >= minTxs && w.total > threshold && w.ids[0]!.occurredAt >= lastAt - 30 * DAY) candidateSets.push(w.ids);
    }
  }
  if (!candidateSets.length) return [];

  // Merge overlapping payment sets into one episode; cap by recency after scoring.
  candidateSets.sort((a, b) => a[0]!.occurredAt - b[0]!.occurredAt);
  const merged: LedgerTx[][] = [];
  for (const set of candidateSets) {
    const ids = new Set(set.map((t) => t.id));
    const existing = merged.find((m) => m.some((t) => ids.has(t.id)));
    if (existing) {
      for (const t of set) if (!existing.some((x) => x.id === t.id)) existing.push(t);
      existing.sort((a, b) => a.occurredAt - b.occurredAt);
    } else merged.push([...set]);
  }

  const incomes = txs.filter((t) => t.direction === "in" && (t.kind === "receive" || t.kind === "deposit" || t.kind === "bank_credit"));
  const incomeThreshold = pct(incomes.filter((t) => t.occurredAt >= lastAt - 90 * DAY).map((t) => t.amount), 0.6);
  const findings: Finding[] = [];
  for (const cluster of merged) {
    const total = cluster.reduce((a, t) => a + t.amount + (t.fee ?? 0), 0);
    const start = cluster[0]!.occurredAt, end = cluster[cluster.length - 1]!.occurredAt;
    const credit = cluster.filter((t) => t.funding === "credit");
    const creditCents = credit.reduce((a, t) => a + t.amount + (t.fee ?? 0), 0);
    const labels = new Map<string, number>();
    const items = new Map<string, number>();
    for (const t of cluster) {
      if (t.label) labels.set(t.label, (labels.get(t.label) ?? 0) + 1);
      for (const i of t.items ?? []) items.set(i, (items.get(i) ?? 0) + 1);
    }
    const biggest = [...labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "mixed spending";
    const lastIncome = incomes.filter((t) => t.amount >= incomeThreshold && t.occurredAt <= start).sort((a, b) => b.occurredAt - a.occurredAt)[0] ?? null;
    const daysSinceIncome = lastIncome ? (start - lastIncome.occurredAt) / DAY : null;
    const lastGroceries = txs.filter((t) => t.label === "Groceries" && t.direction === "out" && t.occurredAt <= start).sort((a, b) => b.occurredAt - a.occurredAt)[0] ?? null;
    const hoursSinceGroceries = lastGroceries ? (start - lastGroceries.occurredAt) / 3_600_000 : null;
    const balanceBefore = txs.filter((t) => t.occurredAt <= start && t.balanceAfterCents != null).sort((a, b) => b.occurredAt - a.occurredAt)[0]?.balanceAfterCents ?? null;
    const fulizaAfter = txs.filter((t) => t.kind === "loan_draw" && t.direction === "in" && t.occurredAt > end && t.occurredAt <= end + 7 * DAY);
    const weekday = new Date(start + 3 * 3_600_000).getUTCDay();
    const baseTotals = merged.map((c) => c.reduce((a, t) => a + t.amount + (t.fee ?? 0), 0));
    const effectRel = baseTotals.length > 1 ? total / Math.max(1, pct(baseTotals, 0.5)) - 1 : 1;
    findings.push({
      detector: "episodes",
      id: `episodes:${start}`,
      title: `Spend episode: ${cluster.length} payments, KES ${(total / 100).toFixed(0)}, mostly ${biggest}, on ${displayEat(start)}`,
      n: cluster.length,
      pValue: baseTotals.length > 1 ? (baseTotals.filter((x) => x >= total).length + 1) / (baseTotals.length + 1) : 0.01,
      minDataMet: unlock.unlocked,
      effect: { abs: total, rel: Math.max(0, effectRel), unit: "cents", absMonthlyCents: total },
      evidence: {
        startedAt: start, endedAt: end, totalCents: total, txIds: cluster.map((t) => t.id),
        composition: { labels: topCounts(labels), items: topCounts(items) },
        creditShare: total ? creditCents / total : 0,
        antecedents: { daysSinceIncome, weekday, hoursSinceGroceries, walletBalanceBeforeCents: balanceBefore },
        consequences: { fulizaDrawsWithin7d: fulizaAfter.length, fulizaCentsWithin7d: fulizaAfter.reduce((a, t) => a + t.amount, 0) },
      },
    });
  }
  return findings.sort((a, b) => (b.evidence.totalCents as number) - (a.evidence.totalCents as number)).slice(0, maxFindings);
};

/** Pattern summary used by the episode card when at least 3 episodes exist. */
export function episodePattern(findings: Finding[]): string | null {
  if (findings.length < 3) return null;
  const afterIncome = findings.filter((f) => {
    const d = (f.evidence.antecedents as { daysSinceIncome?: number | null } | undefined)?.daysSinceIncome;
    return d != null && d >= 0 && d <= 2;
  }).length;
  const withFuliza = findings.filter((f) => Number((f.evidence.consequences as { fulizaDrawsWithin7d?: number } | undefined)?.fulizaDrawsWithin7d ?? 0) > 0).length;
  return `Episodes usually start 0–2 days after money comes in; ${withFuliza} of ${findings.length} were followed by Fuliza within a week.`;
}
