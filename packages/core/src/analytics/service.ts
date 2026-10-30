/**
 * Hub analyses. Every number and chart point is computed by SQL/JS here, persisted in `analyses`,
 * and rendered dumbly by the UI. No model participates. Each result carries n and evidence.
 */
import type { DbAdapter } from "../db/migrate.js";
import { formatKes } from "../sms/money.js";
import { resolveRange } from "../analyst/plan.js";
import { venturePnlAll } from "../tags/store.js";
import type { AnalysisResult, ChartSeries, ChartSpec } from "./types.js";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COLORS = ["#0A84FF", "#30D158", "#FFD60A", "#FF9F0A", "#BF5AF2", "#64D2FF", "#FF453A"];

const monthExpr = `strftime('%Y-%m', t.occurred_at / 1000, 'unixepoch', '+3 hours')`;
const weekdayExpr = `strftime('%w', t.occurred_at / 1000, 'unixepoch', '+3 hours')`;
const hourExpr = `strftime('%H', t.occurred_at / 1000, 'unixepoch', '+3 hours')`;

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]}${y && y !== new Date().getUTCFullYear() ? ` '${String(y).slice(2)}` : ""}`;
}

function dataVersion(db: DbAdapter): number {
  const r = db.get(`SELECT (SELECT COUNT(*) FROM tx_events) AS n,
                           (SELECT COUNT(*) FROM tx_labels) AS l,
                           (SELECT COUNT(*) FROM tx_tags) AS g,
                           (SELECT COUNT(*) FROM counterparties) AS c`);
  return Number(r?.n ?? 0) + Number(r?.l ?? 0) * 1e3 + Number(r?.g ?? 0) * 1e6 + Number(r?.c ?? 0) * 1e9;
}

function base(id: string, kind: string, title: string, computedAt: number, version: number): AnalysisResult {
  return { id, kind, title, findings: [], computedAt, dataVersion: version };
}

function series(key: string, label: string, points: Array<{ x: string | number; y: number }>, color?: string): ChartSeries {
  return { key, label, points, color };
}

// ---------- analyses ----------

export function monthFlow(db: DbAdapter, now = Date.now(), months = 6): AnalysisResult {
  const range = resolveRange({ kind: "relative", unit: "month", n: months }, now);
  const rows = db.all(
    `SELECT ${monthExpr} AS m,
            SUM(CASE WHEN direction = 'in' AND COALESCE(t.flow_class,'') <> 'debt_draw' THEN t.amount ELSE 0 END) AS income,
            SUM(CASE WHEN direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' THEN t.amount ELSE 0 END) AS spend,
            SUM(CASE WHEN direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' THEN COALESCE(t.fee, 0) ELSE 0 END) AS fees
       FROM tx_events t WHERE t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY m ORDER BY m`,
    [range.from, range.to],
  );
  const pts = (key: "income" | "spend" | "fees") => rows.map((r: any) => ({ x: monthLabel(r.m), y: Number(r[key] ?? 0) }));
  const chart: ChartSpec = {
    kind: "line", title: "Money in and out", unit: "KES",
    series: [
      series("income", "In", pts("income"), COLORS[1]),
      series("spend", "Out", pts("spend"), COLORS[0]),
      series("fees", "Fees", pts("fees"), COLORS[2]),
    ],
  };
  const cur = resolveRange({ kind: "named", name: "this_month" }, now);
  const prev = resolveRange({ kind: "named", name: "last_month" }, now);
  const sum = (from: number, to: number, dir: "in" | "out" | "fees") => Number(db.get(
    dir === "fees"
      ? `SELECT COALESCE(SUM(fee),0) AS v FROM tx_events WHERE occurred_at >= ? AND occurred_at < ?`
      : `SELECT COALESCE(SUM(amount),0) AS v FROM tx_events WHERE direction = ? AND occurred_at >= ? AND occurred_at < ?`,
    dir === "fees" ? [from, to] : [dir, from, to],
  )?.v ?? 0);
  const outNow = sum(cur.from, cur.to, "out");
  const outPrev = sum(prev.from, prev.to, "out");
  const res = base("month_flow", "month_flow", "Money in and out", now, dataVersion(db));
  res.chart = chart;
  const delta = outPrev ? ((outNow - outPrev) / outPrev) * 100 : 0;
  res.findings = [{
    text: outPrev ? `Spending this month is ${Math.abs(delta).toFixed(0)}% ${delta >= 0 ? "higher" : "lower"} than last month (${formatKes(outNow)} vs ${formatKes(outPrev)}).` : `Spending this month is ${formatKes(outNow)}.`,
    n: rows.length, evidence: { outNow, outPrev, months: rows.map((r: any) => r.m) },
  }];
  return res;
}

export function categoryTrend(db: DbAdapter, now = Date.now()): AnalysisResult {
  const range = resolveRange({ kind: "relative", unit: "month", n: 6 }, now);
  const top = db.all(
    `SELECT COALESCE(l.name, 'Unlabelled') AS name, SUM(t.amount) AS total
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id AND x.confirmed_at IS NOT NULL ORDER BY x.confirmed_at DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY l.id ORDER BY total DESC LIMIT 5`,
    [range.from, range.to],
  );
  const names: string[] = top.map((r: any) => r.name);
  const rows = db.all(
    `SELECT ${monthExpr} AS m,
            COALESCE(l.name, 'Unlabelled') AS name,
            SUM(t.amount) AS total
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id AND x.confirmed_at IS NOT NULL ORDER BY x.confirmed_at DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY m, l.id ORDER BY m`,
    [range.from, range.to],
  );
  const months = [...new Set(rows.map((r: any) => String(r.m)))].sort();
  const byName = (name: string) => months.map((m) => ({ x: monthLabel(m), y: Number(rows.find((r: any) => String(r.m) === m && r.name === name)?.total ?? 0) }));
  const chart: ChartSpec = {
    kind: "stacked_bar", title: "Where spending goes", unit: "KES",
    series: names.map((n, i) => series(n, n, byName(n), COLORS[i % COLORS.length])),
  };
  const res = base("category_trend", "category_trend", "Where spending goes", now, dataVersion(db));
  res.chart = chart;
  res.findings = names.slice(0, 3).map((n) => ({
    text: `${n}: ${formatKes(Number(top.find((r: any) => r.name === n)?.total ?? 0))} over the last 6 months.`,
    n: rows.filter((r: any) => r.name === n).length, evidence: { label: n, months },
  }));
  return res;
}

export function topCounterparties(db: DbAdapter, now = Date.now(), limit = 6): AnalysisResult {
  const range = resolveRange({ kind: "named", name: "this_month" }, now);
  const rows = db.all(
    `SELECT COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            SUM(t.amount) AS total, COUNT(*) AS n
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY c.id ORDER BY total DESC LIMIT ?`,
    [range.from, range.to, limit],
  );
  const chart: ChartSpec = {
    kind: "bar", title: "Who you paid this month", unit: "KES",
    series: [series("out", "Spent", rows.map((r: any) => ({ x: r.name, y: Number(r.total) })), COLORS[0])],
  };
  const res = base("top_counterparties", "top_counterparties", "Who you paid this month", now, dataVersion(db));
  res.chart = chart;
  res.findings = rows.slice(0, 3).map((r: any) => ({
    text: `${r.name}: ${formatKes(Number(r.total))} across ${r.n} payment${Number(r.n) === 1 ? "" : "s"} this month.`,
    n: Number(r.n), evidence: { name: r.name, total: r.total },
  }));
  return res;
}

export function feesDrag(db: DbAdapter, now = Date.now()): AnalysisResult {
  const range = resolveRange({ kind: "relative", unit: "month", n: 6 }, now);
  const rows = db.all(
    `SELECT ${monthExpr} AS m,
            SUM(COALESCE(t.fee, 0)) AS fees,
            SUM(CASE WHEN direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' THEN t.amount ELSE 0 END) AS spend
       FROM tx_events t WHERE t.occurred_at >= ? AND t.occurred_at < ? GROUP BY m ORDER BY m`,
    [range.from, range.to],
  );
  const totalFees = rows.reduce((s: number, r: any) => s + Number(r.fees), 0);
  const totalSpend = rows.reduce((s: number, r: any) => s + Number(r.spend), 0);
  const chart: ChartSpec = {
    kind: "bar", title: "Fees by month", unit: "KES",
    series: [series("fees", "Fees", rows.map((r: any) => ({ x: monthLabel(r.m), y: Number(r.fees) })), COLORS[2])],
  };
  const res = base("fees", "fees", "Fees by month", now, dataVersion(db));
  res.chart = chart;
  const share = totalSpend ? (totalFees / totalSpend) * 100 : 0;
  res.findings = [{
    text: totalFees ? `You paid ${formatKes(totalFees)} in fees over the last 6 months — ${share.toFixed(2)}% of what you spent.` : "No fees recorded in the last 6 months.",
    n: rows.length, evidence: { totalFees, totalSpend, share },
  }];
  return res;
}

export function recurring(db: DbAdapter, now = Date.now()): AnalysisResult {
  const since = now - 180 * DAY;
  const rows = db.all(
    `SELECT c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            COUNT(*) AS n, AVG(t.amount) AS avg
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = 'out' AND t.occurred_at >= ?
      GROUP BY c.id HAVING n >= 3 ORDER BY n DESC LIMIT 20`,
    [since],
  );
  // Median gap, not mean: two purchases in one week must not hide a monthly commitment.
  const found = rows.map((r: any) => {
    const times = db.all(
      `SELECT occurred_at AS at FROM tx_events WHERE direction = 'out' AND counterparty_id = ? AND occurred_at >= ? ORDER BY occurred_at`,
      [r.cpId, since],
    ).map((x: { at: number }) => Number(x.at));
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / DAY).filter((g) => g > 0);
    gaps.sort((a, b) => a - b);
    const gapDays = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
    const cadence = gapDays >= 5 && gapDays <= 9 ? "weekly" : gapDays >= 24 && gapDays <= 36 ? "monthly" : gapDays >= 12 && gapDays <= 17 ? "fortnightly" : null;
    return { ...r, gapDays, cadence };
  }).filter((r: any) => r.cadence);
  const chart: ChartSpec | undefined = found.length ? {
    kind: "bar", title: "Recurring payments (avg)", unit: "KES",
    series: [series("avg", "Average", found.slice(0, 6).map((r: any) => ({ x: r.name, y: Math.round(Number(r.avg)) })), COLORS[4])],
  } : undefined;
  const res = base("recurring", "recurring", "Recurring payments", now, dataVersion(db));
  res.chart = chart;
  res.findings = found.slice(0, 5).map((r: any) => ({
    text: `${r.name}: ${r.n} payments, roughly ${r.cadence}, about ${formatKes(Math.round(Number(r.avg)))} each.`,
    n: Number(r.n), evidence: { counterparty: r.name, gapDays: r.gapDays, cadence: r.cadence },
  }));
  return res;
}

export function anomalies(db: DbAdapter, now = Date.now()): AnalysisResult {
  const since = now - 90 * DAY;
  const rows = db.all(
    `SELECT t.id, t.occurred_at AS at, t.amount, COALESCE(l.name, 'Unlabelled') AS label,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name
       FROM tx_events t
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id AND x.confirmed_at IS NOT NULL ORDER BY x.confirmed_at DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction = 'out' AND t.occurred_at >= ?`,
    [since],
  );
  const groups = new Map<string, Array<{ id: number; at: number; amount: number; label: string; name: string }>>();
  for (const r of rows) groups.set(r.label, [...(groups.get(r.label) ?? []), { ...r, amount: Number(r.amount), at: Number(r.at) }]);
  const out: Array<{ id: number; at: number; amount: number; label: string; name: string; z: number }> = [];
  for (const [label, items] of groups) {
    if (items.length < 5) continue;
    const mean = items.reduce((s, x) => s + x.amount, 0) / items.length;
    const sd = Math.sqrt(items.reduce((s, x) => s + (x.amount - mean) ** 2, 0) / items.length);
    if (sd === 0) continue;
    for (const x of items) {
      const z = (x.amount - mean) / sd;
      if (z >= 2.5 && x.amount >= 50_000) out.push({ ...x, z });
    }
  }
  out.sort((a, b) => b.z - a.z);
  const res = base("anomalies", "anomalies", "Unusually large payments", now, dataVersion(db));
  res.findings = out.slice(0, 5).map((x) => ({
    text: `${x.name}: ${formatKes(x.amount)} on ${new Date(x.at + 3 * 3_600_000).toISOString().slice(0, 10)} is well above your usual ${x.label} payments.`,
    n: groups.get(x.label)?.length ?? 0, evidence: { txId: x.id, z: Number(x.z.toFixed(2)), label: x.label },
  }));
  return res;
}

export function spendHeatmap(db: DbAdapter, now = Date.now()): AnalysisResult {
  const since = now - 90 * DAY;
  const rows = db.all(
    `SELECT ${weekdayExpr} AS wd, ${hourExpr} AS hr, SUM(t.amount) AS total, COUNT(*) AS n
       FROM tx_events t WHERE t.direction = 'out' AND t.occurred_at >= ? GROUP BY wd, hr`,
    [since],
  );
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const chart: ChartSpec = {
    kind: "heatmap", title: "When you spend", unit: "KES", series: [],
    cells: rows.map((r: any) => ({ x: names[Number(r.wd)] ?? "?", y: Number(r.hr), v: Number(r.total) })),
  };
  const res = base("heatmap", "heatmap", "When you spend", now, dataVersion(db));
  res.chart = chart;
  const peak = rows.slice().sort((a: any, b: any) => Number(b.total) - Number(a.total))[0];
  if (peak) res.findings = [{ text: `Your heaviest spending window in the last 90 days is ${names[Number(peak.wd)]} around ${String(peak.hr).padStart(2, "0")}:00.`, n: Number(peak.n), evidence: { weekday: names[Number(peak.wd)], hour: Number(peak.hr) } }];
  return res;
}

export function incomeMix(db: DbAdapter, now = Date.now()): AnalysisResult {
  const range = resolveRange({ kind: "named", name: "this_month" }, now);
  const rows = db.all(
    `SELECT COALESCE(l.name, 'Unlabelled') AS name, SUM(t.amount) AS total
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id AND x.confirmed_at IS NOT NULL ORDER BY x.confirmed_at DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction = 'in' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY l.id ORDER BY total DESC`,
    [range.from, range.to],
  );
  const total = rows.reduce((s: number, r: any) => s + Number(r.total), 0);
  const chart: ChartSpec | undefined = rows.length ? {
    kind: "donut", title: "Where income came from", unit: "KES",
    series: [series("income", "Income", rows.map((r: any) => ({ x: r.name, y: Number(r.total) })), COLORS[1])],
  } : undefined;
  const res = base("income_mix", "income_mix", "Where income came from", now, dataVersion(db));
  res.chart = chart;
  res.findings = rows.slice(0, 3).map((r: any) => ({
    text: `${r.name}: ${formatKes(Number(r.total))}${total ? ` (${Math.round((Number(r.total) / total) * 100)}% of income)` : ""}.`,
    n: 1, evidence: { label: r.name, total: r.total },
  }));
  return res;
}

export function balanceTrend(db: DbAdapter, now = Date.now()): AnalysisResult {
  const since = now - 60 * DAY;
  const rows = db.all(
    `SELECT ${monthExpr} AS m, ${weekdayExpr} AS wd, t.occurred_at AS at, t.balance_after AS bal, t.chain_status AS chain
       FROM tx_events t WHERE t.balance_after IS NOT NULL AND t.occurred_at >= ? ORDER BY t.occurred_at`,
    [since],
  );
  const lastPerDay = new Map<string, { at: number; bal: number }>();
  for (const r of rows) {
    const key = new Date(Number(r.at) + 3 * 3_600_000).toISOString().slice(0, 10);
    lastPerDay.set(key, { at: Number(r.at), bal: Number(r.bal) });
  }
  const chart: ChartSpec = {
    kind: "line", title: "Stated wallet balance", unit: "KES",
    series: [series("balance", "Balance", [...lastPerDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ x: k.slice(5), y: v.bal })), COLORS[5])],
  };
  const res = base("balance", "balance", "Stated wallet balance", now, dataVersion(db));
  res.chart = chart;
  const breaks = rows.filter((r: any) => r.chain === "break").length;
  res.findings = [{ text: breaks ? `${breaks} balance-chain break${breaks === 1 ? "" : "s"} in the last 60 days — a message may be missing or a transfer was reversed.` : "The stated balances reconcile across the last 60 days.", n: rows.length, evidence: { breaks, points: rows.length } }];
  return res;
}

export function venturesAnalysis(db: DbAdapter, now = Date.now()): AnalysisResult {
  const pnl = venturePnlAll(db, 0, now);
  const chart: ChartSpec | undefined = pnl.length ? {
    kind: "bar", title: "Venture profit", unit: "KES",
    series: [series("net", "Net", pnl.map((p) => ({ x: p.name, y: p.netCents })), COLORS[3])],
  } : undefined;
  const res = base("ventures", "ventures", "Ventures", now, dataVersion(db));
  res.chart = chart;
  res.findings = pnl.slice(0, 5).map((p) => ({
    text: `${p.name}: in ${formatKes(p.incomeCents)}, out ${formatKes(p.expenseCents + p.feeCents)}, net ${formatKes(p.netCents)} across ${p.txCount} payments.`,
    n: p.txCount, evidence: { tagId: p.tagId, net: p.netCents },
  }));
  return res;
}

export function dailySpend(db: DbAdapter, now = Date.now(), days = 14): AnalysisResult {
  const range = resolveRange({ kind: "relative", unit: "day", n: days }, now);
  const rows = db.all(
    `SELECT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+3 hours') AS d,
            SUM(t.amount) AS total
       FROM tx_events t WHERE t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY d ORDER BY d`,
    [range.from, range.to],
  );
  const chart: ChartSpec = {
    kind: "bar", title: `Daily spending (${days} days)`, unit: "KES",
    series: [series("daily", "Spent", rows.map((r: any) => ({ x: String(r.d).slice(5), y: Number(r.total) })), COLORS[0])],
  };
  const res = base("daily_spend", "daily_spend", "Daily spending", now, dataVersion(db));
  res.chart = chart;
  res.findings = [];
  return res;
}

export const ANALYSES = {
  month_flow: monthFlow,
  category_trend: categoryTrend,
  top_counterparties: topCounterparties,
  fees: feesDrag,
  recurring,
  anomalies,
  heatmap: spendHeatmap,
  income_mix: incomeMix,
  balance: balanceTrend,
  ventures: venturesAnalysis,
  daily_spend: dailySpend,
} as const;

export type AnalysisKind = keyof typeof ANALYSES;

export function runAnalysis(db: DbAdapter, kind: AnalysisKind, now = Date.now()): AnalysisResult {
  return ANALYSES[kind](db, now);
}

/** Run the Hub set and persist each result. UI reads these rows; it never recomputes. */
export function runAllAnalyses(db: DbAdapter, now = Date.now()): AnalysisResult[] {
  const kinds: AnalysisKind[] = ["month_flow", "top_counterparties", "category_trend", "fees", "income_mix", "heatmap", "recurring", "anomalies", "balance", "ventures", "daily_spend"];
  const out = kinds.map((k) => ANALYSES[k](db, now));
  for (const r of out) {
    db.run(
      `INSERT INTO analyses (id, kind, title, payload, computed_at, data_version) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, payload = excluded.payload,
         computed_at = excluded.computed_at, data_version = excluded.data_version`,
      [r.id, r.kind, r.title, JSON.stringify(r), r.computedAt, r.dataVersion],
    );
  }
  return out;
}

export function loadAnalyses(db: DbAdapter): AnalysisResult[] {
  return db.all(`SELECT payload FROM analyses ORDER BY computed_at DESC`).flatMap((r: { payload: string }) => {
    try { return [JSON.parse(r.payload) as AnalysisResult]; } catch { return []; }
  });
}
