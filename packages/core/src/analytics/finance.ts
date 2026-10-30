/**
 * Finance: a deterministic, cash-basis management report for a household or small venture.
 *
 * This is NOT an audited statement and NOT GAAP/IFRS reporting. It adapts three
 * established analysis techniques to money seen in the phone:
 *   1. horizontal analysis  — current period vs a like-for-like prior period
 *   2. vertical analysis    — every flow as a share of money in
 *   3. unit economics       — what one payment / one active day actually costs
 *
 * Every number is SQL over tx_events and accounts. There is no model, no estimate,
 * no external benchmark and no currency conversion.
 */
import type { DbAdapter } from "../db/migrate.js";
import { formatKes } from "../sms/money.js";
import type { ExploreFilters, ExplorePeriod } from "./explore.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const EAT = 3 * HOUR;

export type ComparisonBasis = "mtd" | "full" | "ytd" | "none";
export type ComparisonMode = "like_for_like" | "full";

export interface FinanceWindow {
  from: number; to: number; label: string; period: ExplorePeriod;
}

export interface FinanceComparison {
  current: FinanceWindow;
  prior: FinanceWindow | null;
  basis: ComparisonBasis;
  mode: ComparisonMode;
  priorLabel: string | null;
}

function eat(ms: number): Date { return new Date(ms + EAT); }
function midnight(y: number, m: number, d: number): number { return Date.UTC(y, m - 1, d) - EAT; }

/** Same calendar rules as exploreRange, plus a fair prior window. */
export function financeWindows(period: ExplorePeriod, now = Date.now(), mode: ComparisonMode = "like_for_like"): FinanceComparison {
  const p = eat(now);
  const y = p.getUTCFullYear(), m = p.getUTCMonth() + 1;
  if (period === "this_month") {
    const current = { from: midnight(y, m, 1), to: now, label: "this month to date", period };
    const priorStart = midnight(y, m - 1, 1);
    const priorEnd = mode === "full"
      ? midnight(y, m, 1)
      : Math.min(priorStart + (now - current.from), midnight(y, m, 1));
    return {
      current, prior: { from: priorStart, to: priorEnd, label: mode === "full" ? "last month" : "last month, same elapsed days", period },
      basis: mode === "full" ? "full" : "mtd", mode,
      priorLabel: mode === "full" ? "the full previous month" : "last month to the same point",
    };
  }
  if (period === "last_month") {
    const current = { from: midnight(y, m - 1, 1), to: midnight(y, m, 1), label: "last month", period };
    return {
      current, prior: { from: midnight(y, m - 2, 1), to: current.from, label: "the month before", period },
      basis: "full", mode: "full", priorLabel: "the month before",
    };
  }
  if (period === "this_year") {
    const current = { from: midnight(y, 1, 1), to: now, label: `${y} to date`, period };
    const priorStart = midnight(y - 1, 1, 1);
    const priorEnd = mode === "full"
      ? midnight(y, 1, 1)
      : Math.min(priorStart + (now - current.from), midnight(y, 1, 1));
    return {
      current, prior: { from: priorStart, to: priorEnd, label: mode === "full" ? `${y - 1}` : `${y - 1} to the same point`, period },
      basis: mode === "full" ? "full" : "ytd", mode,
      priorLabel: mode === "full" ? `the full ${y - 1} year` : `${y - 1} to the same point`,
    };
  }
  return {
    current: { from: 0, to: now + 1, label: "all time", period },
    prior: null, basis: "none", mode, priorLabel: null,
  };
}

interface Where { sql: string; params: Array<string | number> }

const FROM = `
  FROM tx_events t
  LEFT JOIN counterparties c ON c.id = t.counterparty_id
  LEFT JOIN labels lab ON lab.id = (
    SELECT l2.id FROM tx_labels tl2 JOIN labels l2 ON l2.id = tl2.label_id
     WHERE tl2.tx_id = t.id AND tl2.confirmed_at IS NOT NULL
     ORDER BY tl2.confirmed_at DESC LIMIT 1)
  LEFT JOIN tx_notes n ON n.id = (
    SELECT n2.id FROM tx_notes n2 WHERE n2.tx_id = t.id AND n2.kind = 'note' ORDER BY n2.created_at DESC LIMIT 1)
  LEFT JOIN tx_context ctx ON ctx.tx_id = t.id
  LEFT JOIN tx_bundles b ON b.id = t.bundle_id
`;

/** Filters for the report. Direction is ignored because a report always needs both sides. */
function reportWhere(filters: ExploreFilters, w: FinanceWindow): Where {
  const bits = ["t.occurred_at >= ?", "t.occurred_at < ?"];
  const params: Array<string | number> = [w.from, w.to];
  if (filters.label) { bits.push("lab.name = ?"); params.push(filters.label); }
  if (filters.minCents != null) { bits.push("t.amount >= ?"); params.push(filters.minCents); }
  if (filters.maxCents != null) { bits.push("t.amount <= ?"); params.push(filters.maxCents); }
  const q = filters.search?.trim();
  if (q) {
    const like = `%${q}%`;
    bits.push(`(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') LIKE ? OR COALESCE(lab.name, '') LIKE ? OR COALESCE(n.text, '') LIKE ? OR t.template LIKE ?)`);
    params.push(like, like, like, like);
  }
  return { sql: bits.join(" AND "), params };
}

export interface FlowTotals {
  incomeCents: number; spendCents: number; feeCents: number; hiddenFeeCents: number; netCents: number;
  count: number; inCount: number; outCount: number; activeDays: number;
  avgOutCents: number; medianOutCents: number; avgFeeCents: number;
  /** Fee cents per KES 1,000 moved out. */
  feePer1000Cents: number | null;
  savingsRate: number | null;
}

export function flowTotals(db: DbAdapter, from: number, to: number, filters: ExploreFilters = { period: "all" }): FlowTotals {
  const w: FinanceWindow = { from, to, label: "", period: filters.period };
  const q = reportWhere(filters, w);
  const row = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS spend,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(t.fee, 0) ELSE 0 END), 0) AS fees,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(b.hidden_fee_cents, 0) ELSE 0 END), 0) AS hiddenFees,
       COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN t.direction = 'in' THEN 1 ELSE 0 END), 0) AS inn,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN 1 ELSE 0 END), 0) AS outn,
       COUNT(DISTINCT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+3 hours')) AS days
     ${FROM} WHERE ${q.sql}`,
    q.params,
  ) as Record<string, unknown> | undefined;
  const amounts = db.all(
    `SELECT t.amount
     ${FROM.replace('LEFT JOIN tx_context ctx ON ctx.tx_id = t.id', '')}
     WHERE ${q.sql} AND t.direction = 'out' ORDER BY t.amount`,
    q.params,
  ).map((r: Record<string, unknown>) => Number(r.amount)).filter((n) => Number.isFinite(n));
  const income = Number(row?.income ?? 0), spend = Number(row?.spend ?? 0), fees = Number(row?.fees ?? 0);
  const hiddenFees = Number(row?.hiddenFees ?? 0);
  const outCount = Number(row?.outn ?? 0);
  const median = amounts.length
    ? amounts.length % 2
      ? amounts[(amounts.length - 1) / 2]!
      : (amounts[amounts.length / 2 - 1]! + amounts[amounts.length / 2]!) / 2
    : 0;
  return {
    incomeCents: income, spendCents: spend, feeCents: fees, hiddenFeeCents: hiddenFees, netCents: income - spend - fees,
    count: Number(row?.n ?? 0), inCount: Number(row?.inn ?? 0), outCount,
    activeDays: Number(row?.days ?? 0),
    avgOutCents: outCount ? Math.round(spend / outCount) : 0,
    medianOutCents: Math.round(median),
    avgFeeCents: outCount ? Math.round(fees / outCount) : 0,
    feePer1000Cents: spend > 0 ? Math.round((fees * 100_000) / spend) : null,
    savingsRate: income > 0 ? (income - spend - fees) / income : null,
  };
}

export interface MonthPoint {
  month: string; label: string; incomeCents: number; spendCents: number; feeCents: number; netCents: number;
}

/** Monthly cash-flow series with zero-filled months, in EAT. */
export function monthlyFlow(db: DbAdapter, period: ExplorePeriod, now = Date.now(), months = 6, filters?: ExploreFilters): MonthPoint[] {
  const p = eat(now);
  const y = p.getUTCFullYear(), m = p.getUTCMonth();
  const count = period === "this_year" ? Math.min(12, m + 1) : Math.max(3, Math.min(12, months));
  const startMonth = period === "this_year" ? 0 : m - count + 1;
  const start = Date.UTC(y, startMonth, 1) - EAT;
  const end = now + 1;
  const q = reportWhere(filters ?? { period }, { from: start, to: end, label: "", period });
  const rows = db.all(
    `SELECT strftime('%Y-%m', t.occurred_at / 1000, 'unixepoch', '+3 hours') AS month,
            COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS spend,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(t.fee, 0) ELSE 0 END), 0) AS fees
     ${FROM} WHERE ${q.sql}
      GROUP BY month ORDER BY month`,
    q.params,
  ) as Array<Record<string, unknown>>;
  const by = new Map(rows.map((r) => [String(r.month), r]));
  const out: MonthPoint[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, startMonth + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const r = by.get(key);
    const income = Number(r?.income ?? 0), spend = Number(r?.spend ?? 0), fees = Number(r?.fees ?? 0);
    out.push({
      month: key, label: d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
      incomeCents: income, spendCents: spend, feeCents: fees, netCents: income - spend - fees,
    });
  }
  return out;
}

export interface FinanceCategory {
  name: string; currentCents: number; priorCents: number | null; count: number; share: number;
}

export function categoryComparison(db: DbAdapter, filters: ExploreFilters, current: FinanceWindow, prior: FinanceWindow | null): FinanceCategory[] {
  const rows = (w: FinanceWindow) => {
    const q = reportWhere(filters, w);
    return db.all(
      `SELECT COALESCE(lab.name, 'No label yet') AS name,
              COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n
       ${FROM} WHERE ${q.sql} AND t.direction = 'out'
       GROUP BY COALESCE(lab.name, 'No label yet')`,
      q.params,
    ) as Array<Record<string, unknown>>;
  };
  const cur = rows(current), before = prior ? rows(prior) : [];
  const bmap = new Map(before.map((r) => [String(r.name), Number(r.total)]));
  const total = cur.reduce((s, r) => s + Number(r.total), 0);
  return cur
    .map((r) => ({
      name: String(r.name), currentCents: Number(r.total),
      priorCents: prior ? (bmap.get(String(r.name)) ?? 0) : null,
      count: Number(r.n), share: total > 0 ? Number(r.total) / total : 0,
    }))
    .sort((a, b) => b.currentCents - a.currentCents)
    .slice(0, 8);
}

export interface FinanceMerchant { name: string; currentCents: number; priorCents: number | null; count: number; share: number }

export function merchantComparison(db: DbAdapter, filters: ExploreFilters, current: FinanceWindow, prior: FinanceWindow | null, limit = 6): FinanceMerchant[] {
  const rows = (w: FinanceWindow) => {
    const q = reportWhere(filters, w);
    return db.all(
      `SELECT COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
              COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n
       ${FROM} WHERE ${q.sql} AND t.direction = 'out'
       GROUP BY c.id, name`,
      q.params,
    ) as Array<Record<string, unknown>>;
  };
  const cur = rows(current), before = prior ? rows(prior) : [];
  const bmap = new Map(before.map((r) => [String(r.name), Number(r.total)]));
  const total = cur.reduce((s, r) => s + Number(r.total), 0);
  return cur
    .map((r) => ({
      name: String(r.name), currentCents: Number(r.total),
      priorCents: prior ? (bmap.get(String(r.name)) ?? 0) : null,
      count: Number(r.n), share: total > 0 ? Number(r.total) / total : 0,
    }))
    .sort((a, b) => b.currentCents - a.currentCents)
    .slice(0, limit);
}

export interface ScatterPoint { amountCents: number; feeCents: number; kind: string; name: string | null }
export interface FeeBand { label: string; count: number; spendCents: number; feeCents: number; rate: number | null }

export function feeScatter(db: DbAdapter, filters: ExploreFilters, current: FinanceWindow, limit = 250): { points: ScatterPoint[]; bands: FeeBand[] } {
  const q = reportWhere(filters, current);
  const rows = db.all(
    `SELECT t.amount, COALESCE(t.fee, 0) AS fee, t.kind,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS name
     ${FROM} WHERE ${q.sql} AND t.direction = 'out' AND t.amount > 0
     ORDER BY t.amount LIMIT 5000`,
    q.params,
  ) as Array<Record<string, unknown>>;
  const all = rows.map((r) => ({
    amountCents: Number(r.amount), feeCents: Number(r.fee), kind: String(r.kind),
    name: r.name == null ? null : String(r.name),
  }));
  // Preserve the amount range for the chart instead of taking only the smallest payments.
  const cap = Math.max(1, Math.min(limit, 500));
  const points = all.length <= cap
    ? all
    : Array.from({ length: cap }, (_, i) => all[Math.round((i * (all.length - 1)) / (cap - 1))]!);
  const bands: FeeBand[] = [
    { label: "Under KES 100", count: 0, spendCents: 0, feeCents: 0, rate: null },
    { label: "KES 100–999", count: 0, spendCents: 0, feeCents: 0, rate: null },
    { label: "KES 1,000+", count: 0, spendCents: 0, feeCents: 0, rate: null },
  ];
  for (const p of all) {
    const b = p.amountCents < 10_000 ? bands[0]! : p.amountCents < 100_000 ? bands[1]! : bands[2]!;
    b.count++; b.spendCents += p.amountCents; b.feeCents += p.feeCents;
  }
  for (const b of bands) b.rate = b.spendCents > 0 ? b.feeCents / b.spendCents : null;
  return { points, bands };
}

export interface FinanceKpi {
  id: string; label: string; valueCents: number | null; valuePct: number | null; valueMonths: number | null;
  deltaPct: number | null; deltaPts: number | null; goodWhen: "up" | "down" | "none";
  note: string; formula: string;
}

export interface FinanceDelta {
  id: string; label: string; currentCents: number; priorCents: number | null;
  deltaCents: number | null; pct: number | null; goodWhen: "up" | "down" | "none";
}

export interface VentureRow {
  name: string; kind: string; incomeCents: number; expenseCents: number; feeCents: number;
  netCents: number; count: number; margin: number | null;
}

export interface Liquidity {
  liquidCents: number | null; monthlyBurnCents: number | null; runwayMonths: number | null;
  accountCount: number; method: string;
}

export interface FinanceRisk {
  incomeHhi: number | null; topIncomeShare: number | null; topSpendShare: number | null;
  incomeVolatility: number | null; fulizaDraws: number; fulizaDrawCents: number; fulizaShare: number | null;
  largestExpenseShare: number | null;
}

export interface FinanceReport {
  comparison: FinanceComparison;
  headline: string; subhead: string;
  current: FlowTotals; prior: FlowTotals | null;
  deltas: FinanceDelta[]; kpis: FinanceKpi[];
  monthly: MonthPoint[];
  categories: FinanceCategory[]; merchants: FinanceMerchant[];
  scatter: ScatterPoint[]; feeBands: FeeBand[];
  ventures: VentureRow[]; liquidity: Liquidity; risk: FinanceRisk;
  method: string[];
}

function pct(cur: number, prior: number): number | null {
  // Percent change on a zero or negative base is not meaningful. Do not manufacture one.
  if (prior <= 0) return null;
  return (cur - prior) / prior;
}

function hhi(values: number[]): number | null {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0 || values.length === 0) return null;
  return values.reduce((s, v) => s + (v / total) ** 2, 0);
}

function incomeHhi(db: DbAdapter, filters: ExploreFilters, w: FinanceWindow): { hhi: number | null; topShare: number | null } {
  const q = reportWhere(filters, w);
  const rows = db.all(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     ${FROM} WHERE ${q.sql} AND t.direction = 'in'
     GROUP BY c.id ORDER BY total DESC`,
    q.params,
  ).map((r: Record<string, unknown>) => Number(r.total));
  const total = rows.reduce((s, v) => s + v, 0);
  return { hhi: hhi(rows), topShare: total > 0 ? (rows[0] ?? 0) / total : null };
}

function spendConcentration(db: DbAdapter, filters: ExploreFilters, w: FinanceWindow): { topShare: number | null; largestShare: number | null } {
  const q = reportWhere(filters, w);
  const rows = db.all(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     ${FROM} WHERE ${q.sql} AND t.direction = 'out'
     GROUP BY c.id ORDER BY total DESC`,
    q.params,
  ).map((r: Record<string, unknown>) => Number(r.total));
  const total = rows.reduce((s, v) => s + v, 0);
  const largest = db.get(
    `SELECT COALESCE(MAX(t.amount), 0) AS m ${FROM} WHERE ${q.sql} AND t.direction = 'out'`,
    q.params,
  ) as { m?: number } | undefined;
  return {
    topShare: total > 0 ? rows.slice(0, 5).reduce((s, v) => s + v, 0) / total : null,
    largestShare: total > 0 ? Number(largest?.m ?? 0) / total : null,
  };
}

function liquidity(db: DbAdapter, now: number, current: FinanceWindow): Liquidity {
  const row = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(last_balance_cents), 0) AS total
       FROM accounts
      WHERE visibility = 'full' AND kind IN ('wallet','bank') AND last_balance_cents IS NOT NULL`,
  ) as { n?: number; total?: number } | undefined;
  const n = Number(row?.n ?? 0);
  const liquid = n > 0 ? Number(row?.total ?? 0) : null;
  const burnFrom = Math.max(0, current.to - 90 * DAY);
  const burn = db.get(
    `SELECT COALESCE(SUM(t.amount), 0) AS spend, COUNT(DISTINCT strftime('%Y-%m', t.occurred_at / 1000, 'unixepoch', '+3 hours')) AS months
       FROM tx_events t
      WHERE t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?`,
    [burnFrom, current.to],
  ) as { spend?: number; months?: number } | undefined;
  const months = Math.max(1, Number(burn?.months ?? 0));
  const monthlyBurn = Number(burn?.spend ?? 0) / months;
  return {
    liquidCents: liquid,
    monthlyBurnCents: monthlyBurn > 0 ? Math.round(monthlyBurn) : null,
    runwayMonths: liquid != null && monthlyBurn > 0 ? liquid / monthlyBurn : null,
    accountCount: n,
    method: "Liquid = latest stated balance on full-visibility wallets/banks. Burn = outflows in the trailing 90 days ÷ months with activity.",
  };
}

function ventureRows(db: DbAdapter, w: FinanceWindow): VentureRow[] {
  return db.all(
    `SELECT v.name, v.kind,
            COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS expense,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(t.fee,0) ELSE 0 END), 0) AS fees,
            COUNT(*) AS n
       FROM ventures v
       JOIN tx_tags tt ON tt.tag_id = v.tag_id
       JOIN tx_events t ON t.id = tt.tx_id
      WHERE v.status = 'active' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY v.id, v.name, v.kind
      ORDER BY income DESC, expense DESC`,
    [w.from, w.to],
  ).map((r: Record<string, unknown>) => {
    const income = Number(r.income), expense = Number(r.expense), fees = Number(r.fees);
    return {
      name: String(r.name), kind: String(r.kind), incomeCents: income, expenseCents: expense,
      feeCents: fees, netCents: income - expense - fees, count: Number(r.n),
      margin: income > 0 ? (income - expense - fees) / income : null,
    };
  });
}

function volatility(months: MonthPoint[]): number | null {
  const vals = months.map((m) => m.incomeCents).filter((v) => v > 0);
  if (vals.length < 3) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  if (mean <= 0) return null;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) / mean;
}

function actionHeadline(cur: FlowTotals, prior: FlowTotals | null, comparison: FinanceComparison): { headline: string; subhead: string } {
  const money = (c: number) => `KES ${Math.round(Math.abs(c) / 100).toLocaleString("en-KE")}`;
  const absPct = (p: number) => `${Math.abs(p * 100).toFixed(1)}%`;
  const move = (p: number) => p >= 0 ? "rose" : "fell";
  if (!prior || prior.count === 0) {
    return {
      headline: cur.incomeCents > 0
        ? `You kept ${cur.savingsRate == null ? "—" : `${Math.round(Math.max(0, cur.savingsRate) * 100)}%`} of what came in`
        : "No money in yet; this report is all outflow",
      subhead: `${money(cur.incomeCents)} in, ${money(cur.spendCents + cur.feeCents)} out, ${cur.count} payments.`,
    };
  }
  const income = pct(cur.incomeCents, prior.incomeCents);
  const spend = pct(cur.spendCents, prior.spendCents);
  const fees = pct(cur.feeCents, prior.feeCents);
  if (income != null && spend != null && spend > income && cur.spendCents > 0) {
    return {
      headline: `Spending ${move(spend)} ${absPct(spend)} while income ${move(income)} ${absPct(income)}`,
      subhead: `The gap widened by ${money(cur.spendCents - prior.spendCents - (cur.incomeCents - prior.incomeCents))} versus ${comparison.priorLabel}.`,
    };
  }
  if (fees != null && spend != null && fees > spend && cur.feeCents > 0) {
    return {
      headline: `Fees ${move(fees)} ${absPct(fees)} vs spending ${move(spend)} ${absPct(spend)}`,
      subhead: cur.feePer1000Cents == null ? "No outflows to rate yet." : `${formatKes(cur.feePer1000Cents)} per KES 1,000 moved.`,
    };
  }
  const netPct = pct(cur.netCents, prior.netCents);
  if (netPct != null) {
    return {
      headline: `Free cash flow ${move(netPct)} ${absPct(netPct)} vs ${comparison.priorLabel}`,
      subhead: `${money(cur.incomeCents)} in, ${money(cur.spendCents + cur.feeCents)} out. Savings rate ${cur.savingsRate == null ? "—" : `${Math.round(cur.savingsRate * 100)}%`}.`,
    };
  }
  return {
    headline: cur.netCents >= prior.netCents
      ? `Free cash flow improved by ${money(cur.netCents - prior.netCents)}`
      : `Free cash flow fell by ${money(prior.netCents - cur.netCents)}`,
    subhead: `Prior net was ${prior.netCents < 0 ? "negative" : "positive"}; percentage change is not meaningful on that base.`,
  };
}

export function financeReport(db: DbAdapter, filters: ExploreFilters, now = Date.now(), mode: ComparisonMode = "like_for_like"): FinanceReport {
  const comparison = financeWindows(filters.period, now, mode);
  const current = flowTotals(db, comparison.current.from, comparison.current.to, filters);
  const prior = comparison.prior ? flowTotals(db, comparison.prior.from, comparison.prior.to, filters) : null;
  const priorAvailable = prior && prior.count > 0 ? prior : null;
  const trendNow = filters.period === "last_month" ? comparison.current.to - 1 : now;
  const monthly = monthlyFlow(db, filters.period, trendNow, 6, filters);
  const categories = categoryComparison(db, filters, comparison.current, comparison.prior);
  const merchants = merchantComparison(db, filters, comparison.current, comparison.prior);
  const { points: scatter, bands: feeBands } = feeScatter(db, filters, comparison.current);
  const ventures = ventureRows(db, comparison.current);
  const liquid = liquidity(db, now, comparison.current);
  const income = incomeHhi(db, filters, comparison.current);
  const spend = spendConcentration(db, filters, comparison.current);
  const draws = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions
      WHERE kind = 'loan_draw' AND occurred_at >= ? AND occurred_at < ?`,
    [comparison.current.from, comparison.current.to],
  ) as { n?: number; total?: number } | undefined;
  const fulizaDrawCents = Number(draws?.total ?? 0);
  const { headline, subhead } = actionHeadline(current, priorAvailable, comparison);

  const deltas: FinanceDelta[] = [
    { id: "income", label: "Money in", currentCents: current.incomeCents, priorCents: priorAvailable?.incomeCents ?? null, deltaCents: priorAvailable ? current.incomeCents - priorAvailable.incomeCents : null, pct: priorAvailable ? pct(current.incomeCents, priorAvailable.incomeCents) : null, goodWhen: "up" },
    { id: "spend", label: "Money out", currentCents: current.spendCents, priorCents: priorAvailable?.spendCents ?? null, deltaCents: priorAvailable ? current.spendCents - priorAvailable.spendCents : null, pct: priorAvailable ? pct(current.spendCents, priorAvailable.spendCents) : null, goodWhen: "down" },
    { id: "fees", label: "Fees", currentCents: current.feeCents, priorCents: priorAvailable?.feeCents ?? null, deltaCents: priorAvailable ? current.feeCents - priorAvailable.feeCents : null, pct: priorAvailable ? pct(current.feeCents, priorAvailable.feeCents) : null, goodWhen: "down" },
    { id: "net", label: "Free cash flow", currentCents: current.netCents, priorCents: priorAvailable?.netCents ?? null, deltaCents: priorAvailable ? current.netCents - priorAvailable.netCents : null, pct: priorAvailable ? pct(current.netCents, priorAvailable.netCents) : null, goodWhen: "up" },
  ];

  const kpis: FinanceKpi[] = [
    {
      id: "fcf", label: "Free cash flow", valueCents: current.netCents, valuePct: null, valueMonths: null,
      deltaPct: deltas.find((d) => d.id === "net")?.pct ?? null,
      deltaPts: null,
      goodWhen: "up", note: current.netCents >= 0 ? "Money retained after every outflow and fee" : "More left the phone than arrived",
      formula: "money in − money out − fees",
    },
    {
      id: "savings", label: "Savings rate", valueCents: null,
      valuePct: current.savingsRate, valueMonths: null,
      deltaPct: null,
      deltaPts: priorAvailable && current.savingsRate != null && priorAvailable.savingsRate != null
        ? current.savingsRate - priorAvailable.savingsRate : null,
      goodWhen: "up", note: current.savingsRate == null ? "No inflows in this segment" : "Share of inflows not spent",
      formula: "free cash flow ÷ money in",
    },
    {
      id: "fee", label: "Fee load", valueCents: current.feePer1000Cents, valuePct: null, valueMonths: null,
      deltaPct: priorAvailable && current.feePer1000Cents != null && priorAvailable.feePer1000Cents != null && priorAvailable.feePer1000Cents > 0
        ? (current.feePer1000Cents - priorAvailable.feePer1000Cents) / priorAvailable.feePer1000Cents : null,
      deltaPts: null,
      goodWhen: "down", note: current.feePer1000Cents == null ? "No outflows to rate" : "Cost of moving KES 1,000",
      formula: "fees ÷ outflows × 1,000",
    },
    {
      id: "runway", label: "Cash runway", valueCents: null, valuePct: null,
      valueMonths: liquid.runwayMonths,
      deltaPct: null, deltaPts: null, goodWhen: "up",
      note: liquid.liquidCents == null ? "No stated liquid balance" : liquid.runwayMonths == null ? "Burn not yet measurable" : "Months of outflows covered by stated liquid balances",
      formula: "liquid balances ÷ average monthly outflow",
    },
    {
      id: "ticket", label: "Average payment", valueCents: current.avgOutCents, valuePct: null, valueMonths: null,
      deltaPct: priorAvailable && priorAvailable.avgOutCents > 0 ? pct(current.avgOutCents, priorAvailable.avgOutCents) : null,
      deltaPts: null, goodWhen: "none", note: `${current.outCount} outbound payments; median ${Math.round(current.medianOutCents / 100).toLocaleString("en-KE")} KES`,
      formula: "outflows ÷ outbound payment count",
    },
  ];

  return {
    comparison, headline, subhead, current, prior: priorAvailable, deltas, kpis, monthly, categories, merchants,
    scatter, feeBands, ventures, liquidity: liquid,
    risk: {
      incomeHhi: income.hhi, topIncomeShare: income.topShare, topSpendShare: spend.topShare,
      incomeVolatility: volatility(monthly),
      fulizaDraws: Number(draws?.n ?? 0), fulizaDrawCents,
      fulizaShare: current.incomeCents > 0 ? fulizaDrawCents / current.incomeCents : null,
      largestExpenseShare: spend.largestShare,
    },
    method: [
      "Cash basis: every canonical tx_event; transfers to off-radar destinations stay as outflows, not hidden.",
      "Prior window is like-for-like where the period is incomplete; a zero-transaction prior window is shown as unavailable.",
      "Balances use the latest stated balance per full-visibility wallet/bank; credit lines are excluded from runway.",
      "No external benchmark, no purchasing-power adjustment, no currency conversion, no model-generated numbers.",
      "Management KPIs are adaptations, not GAAP/IFRS measures. Their formula is shown on every card.",
    ],
  };
}
