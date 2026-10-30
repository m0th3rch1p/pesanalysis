/**
 * Aggregate-only tools for the on-device agent (DECISIONS D7). The agent NEVER sees raw message
 * bodies through these, and can NEVER move money. Sums/breakdowns only, computed in pure code.
 */
import type { LedgerTx } from "../detectors/types.js";
import type { Finding } from "../detectors/types.js";

export interface Tool {
  name: string;
  description: string;
  /** JSON schema for the arguments (used as the constrained-grammar target) */
  params: Record<string, string>;
  run(args: Record<string, unknown>): unknown;
}

export function buildTools(txs: LedgerTx[], findings: Finding[]): Tool[] {
  const sumBy = (pick: (t: LedgerTx) => string | null | undefined) => {
    const m = new Map<string, number>();
    for (const t of txs) { const k = pick(t); if (!k) continue; m.set(k, (m.get(k) ?? 0) + t.amount); }
    return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 12));
  };
  return [
    {
      name: "sum_by_label",
      description: "Total spent/earned grouped by category label (KES cents), last N days.",
      params: { days: "number" },
      run: (a) => {
        const since = Date.now() - Number(a.days ?? 30) * 86_400_000;
        return sumBy((t) => (t.occurredAt >= since ? t.label : null));
      },
    },
    {
      name: "sum_by_kind",
      description: "Totals grouped by transaction kind (send/till/paybill/...), last N days.",
      params: { days: "number" },
      run: (a) => {
        const since = Date.now() - Number(a.days ?? 30) * 86_400_000;
        return sumBy((t) => (t.occurredAt >= since ? t.kind : null));
      },
    },
    {
      name: "top_counterparties",
      description: "Top counterparties by absolute flow, last N days.",
      params: { days: "number" },
      run: (a) => {
        const since = Date.now() - Number(a.days ?? 30) * 86_400_000;
        return sumBy((t) => (t.occurredAt >= since ? t.counterpartyKey : null));
      },
    },
    {
      name: "balance_trend",
      description: "End-of-day balance series (stated balances), last N days.",
      params: { days: "number" },
      run: (a) => {
        const since = Date.now() - Number(a.days ?? 30) * 86_400_000;
        const m = new Map<number, number>();
        for (const t of txs) if (t.occurredAt >= since) m.set(dayFloor(t.occurredAt), t.amount);
        return Object.fromEntries([...m].sort((x, y) => x[0] - y[0]));
      },
    },
    {
      name: "list_findings",
      description: "All detector findings (patterns the code found). The agent may narrate but never invent these.",
      params: {},
      run: () => findings.map((f) => ({ id: f.id, detector: f.detector, title: f.title, n: f.n })),
    },
  ];
}

function dayFloor(ms: number): number { return Math.floor(ms / 86_400_000) * 86_400_000; }
