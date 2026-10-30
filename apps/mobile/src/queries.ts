import type { SQLiteDatabase } from "expo-sqlite";
import { displayEat, moneyTotals, type Finding } from "@yako/core";
import { asDbAdapter } from "./db/open";
import { loadStoredFindings } from "./insights";

export interface TxRow {
  id: number;
  occurredAt: number;
  amount: number;
  fee: number | null;
  direction: "in" | "out";
  kind: string;
  label: string | null;
  cpName: string | null;
  status: string;
  scope: string;
}

export interface HomeStats {
  txCount: number;
  pending: number;
  todayIn: number;
  todayOut: number;
  todayFees: number;
  monthIn: number;
  monthOut: number;
  monthFees: number;
  findings: Finding[];
}

function cpName(raw: string | null, display: string | null): string | null {
  if (display) return display;
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    return arr[0] ?? null;
  } catch { return null; }
}

export function recentTx(db: SQLiteDatabase, limit = 120): TxRow[] {
  const rows = db.getAllSync<{
    id: number; occurredAt: number; amount: number; fee: number | null; direction: string;
    kind: string; label: string | null; cpRaw: string | null; cpDisplay: string | null;
    status: string; scope: string;
  }>(
    `SELECT t.id, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind, t.status, t.scope,
            c.raw_names AS cpRaw, c.display_name AS cpDisplay,
            (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
              WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL
              ORDER BY tl.confirmed_at DESC LIMIT 1) AS label
       FROM tx_events t
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      ORDER BY t.occurred_at DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({ ...r, direction: r.direction as "in" | "out", cpName: cpName(r.cpRaw, r.cpDisplay) }));
}

export function homeStats(db: SQLiteDatabase): HomeStats {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1);
  const t0 = startToday.getTime();
  const m0 = startMonth.getTime();

  const T = (since: number) => moneyTotals(asDbAdapter(db), since, Number.MAX_SAFE_INTEGER);
  const today = T(t0), month = T(m0);
  // NET_DEFINITION_V1: debt principal excluded; transfers count; fees separate.
  const inOf = (t: typeof today) => t.income + t.cashIn + t.reversalIn + t.transferIn;
  const outOf = (t: typeof today) => t.spend + t.cashOut + t.reversalOut + t.transferOut;

  const txCount = db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events`)?.n ?? 0;
  const pending = db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events WHERE status = 'pending'`)?.n ?? 0;
  return {
    txCount, pending,
    todayIn: inOf(today), todayOut: outOf(today), todayFees: today.fees,
    monthIn: inOf(month), monthOut: outOf(month), monthFees: month.fees,
    findings: loadStoredFindings(db),
  };
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ms: number): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true });
}

/** Unambiguous date + time for a row: `Thu 29 Oct · 5:37 pm`. */
export function whenLabel(ms: number): string {
  return `${displayEat(ms)} · ${timeLabel(ms)}`;
}
