import type { SQLiteDatabase } from "expo-sqlite";
import {
  gateFindings, loadPersistedFindings, persistFindings, runAllDetectors, stripPValues, toLedgerTxs, type Finding, type LedgerTx,
} from "@yako/core";
import { asDbAdapter } from "./db/open";

/**
 * Ledger rows -> pure detectors -> durable findings (G2). No LLM, no network.
 * Dismissals survive because state lives in the findings table, not in React state.
 */
/** Fast path: findings already persisted by the nightly pass. No detector re-run. */
export function loadStoredFindings(db: SQLiteDatabase): Finding[] {
  try { return loadPersistedFindings(asDbAdapter(db)); } catch { return []; }
}

export function loadFindings(db: SQLiteDatabase): { txCount: number; findings: Finding[] } {
  const rows = db.getAllSync<{
    id: number; occurredAt: number; direction: string; amount: number; kind: string;
    fee: number | null; scope: string; cpKey: string | null; cpName: string | null;
    cpRaw: string | null; label: string | null; provider: string; balanceAfterCents: number | null;
    lat: number | null; lng: number | null; batteryPct: number | null; isCharging: number | null;
    stepDelta: number | null; circadianPhase: string | null;
  }>(`SELECT t.id, t.occurred_at AS occurredAt, t.direction, t.amount, t.kind, t.fee, t.scope,
             t.balance_after AS balanceAfterCents,
             ctx.lat AS lat, ctx.lng AS lng, ctx.battery_pct AS batteryPct,
             ctx.is_charging AS isCharging, ctx.step_delta AS stepDelta, ctx.circadian_phase AS circadianPhase,
             c.key AS cpKey, c.display_name AS cpName, c.raw_names AS cpRaw, l.name AS label, t.provider
        FROM tx_events t
        LEFT JOIN tx_context ctx ON ctx.tx_id = t.id
        LEFT JOIN counterparties c ON c.id = t.counterparty_id
        LEFT JOIN tx_labels tl ON tl.rowid = (
          SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
           ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
        LEFT JOIN labels l ON l.id = tl.label_id`);
  const txs: LedgerTx[] = toLedgerTxs(rows.map((r) => {
    let raw: string | null = null;
    try { raw = r.cpRaw ? (JSON.parse(r.cpRaw)[0] ?? null) : null; } catch { raw = null; }
    return { ...r, cpName: r.cpName ?? raw };
  }));
  const findings = gateFindings(runAllDetectors(txs)).map((f) => ({ ...f, title: stripPValues(f.title) }));
  const adapter = asDbAdapter(db);
  try { persistFindings(adapter, findings); } catch { /* read path must never fail on a write */ }
  const stored = loadPersistedFindings(adapter);
  return { txCount: txs.length, findings: stored.length ? stored : findings };
}
