/** Goal mode measures (WS6.1). All numbers are computed locally; no judgement words. */
import type { DbAdapter } from "../db/migrate.js";
import { creditShare, fulizaCost } from "../insight/credit.js";
import { floatSnapshot, listSavingsGoals, virtualPotsTotal } from "../expect/store.js";
import { goalProgress } from "../expect/savings.js";
import type { GoalMode } from "./modes.js";
import { formatKes } from "../sms/money.js";

const DAY = 86_400_000;
const monthAgo = (now: number) => now - 30 * DAY;

function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; }

export interface ModeMeasure { key: string; label: string; value: number; unit: "cents" | "days" | "share" | "ratio" | "count"; sentence: string; trend?: "up" | "down" | "flat" }

export function bufferDays(db: DbAdapter, now = Date.now()): number | null {
  const f = floatSnapshot(db, now);
  if (f.balanceCents == null) return null;
  const rows = db.all(
    `SELECT CAST((t.occurred_at + 10800000) / 86400000 AS INTEGER) AS d, SUM(t.amount + COALESCE(t.fee,0)) AS s
       FROM tx_events t WHERE t.direction='out' AND COALESCE(t.flow_class,'') <> 'debt_repay' AND t.occurred_at >= ?
      GROUP BY d`, [monthAgo(now)],
  ) as Array<{ s: number }>;
  const daily = median(rows.map((r) => Number(r.s)));
  if (daily <= 0) return null;
  return Math.max(0, f.freeFloatCents != null ? f.freeFloatCents / daily : f.balanceCents / daily);
}

export function daysOnFuliza(db: DbAdapter, now = Date.now()): number {
  const rows = db.all(
    `SELECT kind, amount, occurred_at AS at FROM transactions
      WHERE kind IN ('loan_draw','loan_repay') AND template LIKE 'mpesa.fuliza%' AND occurred_at >= ? ORDER BY occurred_at`,
    [monthAgo(now)],
  ) as Array<{ kind: string; amount: number; at: number }>;
  let outstanding = 0;
  const days = new Set<number>();
  for (const r of rows) {
    outstanding += r.kind === "loan_draw" ? Number(r.amount) : -Number(r.amount);
    if (outstanding > 0) days.add(Math.floor((r.at + 3 * 3_600_000) / DAY));
  }
  return days.size;
}

export function feeLoad(db: DbAdapter, now = Date.now()): number {
  const r = db.get(
    `SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(fee),0) AS f FROM tx_events
      WHERE direction='out' AND occurred_at >= ?`, [monthAgo(now)],
  ) as { a?: number; f?: number } | undefined;
  const amount = Number(r?.a ?? 0), fees = Number(r?.f ?? 0);
  return amount > 0 ? fees / amount : 0;
}

export function savingsRate(db: DbAdapter, now = Date.now()): number | null {
  const r = db.get(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN direction='out' THEN amount + COALESCE(fee,0) ELSE 0 END),0) AS spend
       FROM tx_events WHERE occurred_at >= ?`, [monthAgo(now)],
  ) as { income?: number; spend?: number } | undefined;
  const income = Number(r?.income ?? 0), spend = Number(r?.spend ?? 0);
  if (income <= 0) return null;
  return (income - spend) / income;
}

export function monthTotals(db: DbAdapter, now = Date.now()): { inCents: number; outCents: number; netCents: number } {
  const r = db.get(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS i,
            COALESCE(SUM(CASE WHEN direction='out' THEN amount + COALESCE(fee,0) ELSE 0 END),0) AS o
       FROM tx_events WHERE occurred_at >= ?`, [monthAgo(now)],
  ) as { i?: number; o?: number } | undefined;
  const inCents = Number(r?.i ?? 0), outCents = Number(r?.o ?? 0);
  return { inCents, outCents, netCents: inCents - outCents };
}

function venturePnl(db: DbAdapter, now = Date.now()): { name: string; netCents: number } | null {
  const row = db.get(
    `SELECT v.name AS name,
            COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE 0 END),0) -
            COALESCE(SUM(CASE WHEN t.direction='out' THEN t.amount + COALESCE(t.fee,0) ELSE 0 END),0) AS net
       FROM ventures v
       JOIN tx_tags tt ON tt.tag_id = v.tag_id JOIN transactions t ON t.id = tt.tx_id
      WHERE v.status = 'active' AND t.occurred_at >= ? GROUP BY v.id ORDER BY net DESC LIMIT 1`, [monthAgo(now)],
  ) as { name?: string; net?: number } | undefined;
  return row?.name ? { name: String(row.name), netCents: Number(row.net ?? 0) } : null;
}

export function modeMeasures(db: DbAdapter, mode: GoalMode, now = Date.now()): ModeMeasure[] {
  if (mode === "steady") {
    const b = bufferDays(db, now);
    const cs = creditShare(db, monthAgo(now), now);
    const fc = fulizaCost(db, monthAgo(now), now);
    return [
      { key: "buffer", label: "Buffer", value: b == null ? 0 : Math.round(b * 10) / 10, unit: "days", sentence: b == null ? "Add a balance message to see your runway." : `Your balance covers about ${Math.round(b)} days of usual spending.` },
      { key: "credit_share", label: "Credit-funded", value: cs.shareValue, unit: "share", sentence: `${Math.round(cs.shareValue * 100)}% of spending this month was paid with credit.` },
      { key: "fuliza_cost", label: "Fuliza cost", value: fc.totalFeesCents, unit: "cents", sentence: `Fuliza fees this month are about ${formatKes(fc.totalFeesCents)}.` },
    ];
  }
  if (mode === "grow") {
    const sr = savingsRate(db, now);
    const goals = listSavingsGoals(db).filter((g) => g.status === "active");
    const g = goals[0];
    const pace = g ? goalProgress({ targetCents: g.targetCents, savedCents: g.savedCents, targetOn: g.targetOn }, now, null) : null;
    return [
      { key: "savings_rate", label: "Savings rate", value: sr == null ? 0 : sr, unit: "share", sentence: sr == null ? "Not enough income history yet." : `You kept ${Math.round(sr * 100)}% of the money that came in this month.` },
      { key: "goal_pace", label: "Goal pace", value: pace?.pct ?? 0, unit: "ratio", sentence: g ? `${g.name}: ${Math.round((pace?.pct ?? 0) * 100)}% funded${pace?.behindPace ? ", behind the date you set" : pace ? ", on pace" : ""}.` : "No savings goal yet." },
    ];
  }
  if (mode === "business") {
    const v = venturePnl(db, now);
    return [
      { key: "venture_pnl", label: "Venture margin", value: v?.netCents ?? 0, unit: "cents", sentence: v ? `${v.name} kept ${formatKes(v.netCents)} in the last 30 days.` : "Tag a venture to see its margin." },
    ];
  }
  const t = monthTotals(db, now);
  return [
    { key: "month_in", label: "In", value: t.inCents, unit: "cents", sentence: `${formatKes(t.inCents)} came in this month.` },
    { key: "month_out", label: "Out", value: t.outCents, unit: "cents", sentence: `${formatKes(t.outCents)} went out this month.` },
    { key: "month_net", label: "Net", value: t.netCents, unit: "cents", sentence: `Net ${formatKes(t.netCents)} this month.` },
  ];
}

export function potsTotal(db: DbAdapter): number { return virtualPotsTotal(db); }
