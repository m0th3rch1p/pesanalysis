/**
 * Explore: one parameterised read model for the Analysis tab.
 * All values are computed from tx_events; no model and no hidden heuristics.
 */
import type { DbAdapter } from "../db/migrate.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const EAT = 3 * HOUR;

export type ExplorePeriod = "this_month" | "last_month" | "this_year" | "all";
export type ExploreDirection = "in" | "out";

export interface ExploreFilters {
  period: ExplorePeriod;
  direction?: ExploreDirection;
  label?: string;
  search?: string;
  minCents?: number;
  maxCents?: number;
}

export interface ExploreRange { from: number; to: number; label: string; period: ExplorePeriod }

function eat(ms: number): Date { return new Date(ms + EAT); }
function midnight(y: number, m: number, d: number): number { return Date.UTC(y, m - 1, d) - EAT; }

export function exploreRange(period: ExplorePeriod, now = Date.now()): ExploreRange {
  const p = eat(now);
  const y = p.getUTCFullYear(), m = p.getUTCMonth() + 1;
  if (period === "this_month") return { from: midnight(y, m, 1), to: now, label: "this month", period };
  if (period === "last_month") return { from: midnight(y, m - 1, 1), to: midnight(y, m, 1), label: "last month", period };
  if (period === "this_year") return { from: midnight(y, 1, 1), to: now, label: `${y} so far`, period };
  return { from: 0, to: now + 1, label: "all time", period };
}

interface Where { sql: string; params: Array<string | number> }

function where(filters: ExploreFilters, now: number): Where {
  const r = exploreRange(filters.period, now);
  const bits = ["t.occurred_at >= ?", "t.occurred_at < ?"];
  const params: Array<string | number> = [r.from, r.to];
  if (filters.direction) { bits.push("t.direction = ?"); params.push(filters.direction); }
  if (filters.label) { bits.push("lab.name = ?"); params.push(filters.label); }
  if (filters.minCents != null) { bits.push("t.amount >= ?"); params.push(filters.minCents); }
  if (filters.maxCents != null) { bits.push("t.amount <= ?"); params.push(filters.maxCents); }
  const q = filters.search?.trim();
  if (q) {
    bits.push(`(COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') LIKE ? OR COALESCE(lab.name, '') LIKE ? OR COALESCE(n.text, '') LIKE ? OR t.template LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  return { sql: bits.join(" AND "), params };
}

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

export interface ExploreSummary {
  range: ExploreRange;
  incomeCents: number; spendCents: number; feeCents: number; hiddenFeeCents: number; netCents: number; count: number;
}

export function exploreSummary(db: DbAdapter, filters: ExploreFilters, now = Date.now()): ExploreSummary {
  const w = where(filters, now);
  const row = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS spend,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(t.fee, 0) ELSE 0 END), 0) AS fees,
       COALESCE(SUM(CASE WHEN t.direction = 'out' THEN COALESCE(b.hidden_fee_cents, 0) ELSE 0 END), 0) AS hiddenFees,
       COUNT(*) AS n
     ${FROM} WHERE ${w.sql}`,
    w.params,
  ) as Record<string, unknown> | undefined;
  const income = Number(row?.income ?? 0), spend = Number(row?.spend ?? 0), fees = Number(row?.fees ?? 0);
  const hiddenFees = Number(row?.hiddenFees ?? 0);
  return { range: exploreRange(filters.period, now), incomeCents: income, spendCents: spend, feeCents: fees, hiddenFeeCents: hiddenFees, netCents: income - spend - fees, count: Number(row?.n ?? 0) };
}

export interface ExploreTx {
  id: number; occurredAt: number; amount: number; fee: number | null; direction: "in" | "out";
  kind: string; status: string; label: string | null; cpName: string | null;
  note: string | null; template: string; lat: number | null; lng: number | null; accuracy: number | null;
  calendarTitle: string | null; batteryPct: number | null;
}

export function exploreTransactions(db: DbAdapter, filters: ExploreFilters, limit = 80, now = Date.now()): ExploreTx[] {
  const w = where(filters, now);
  return db.all(
    `SELECT t.id, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind, t.status,
            lab.name AS label, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName,
            n.text AS note, t.template,
            ctx.lat, ctx.lng, ctx.accuracy_m AS accuracy, ctx.calendar_title AS calendarTitle,
            ctx.battery_pct AS batteryPct
     ${FROM} WHERE ${w.sql}
     ORDER BY t.occurred_at DESC LIMIT ?`,
    [...w.params, Math.max(1, Math.min(limit, 500))],
  ) as ExploreTx[];
}

export interface ExploreBucket { name: string; totalCents: number; count: number; color?: string }

export function exploreCategories(db: DbAdapter, filters: ExploreFilters, limit = 8, now = Date.now()): ExploreBucket[] {
  const w = where({ ...filters, direction: filters.direction ?? "out" }, now);
  return db.all(
    `SELECT COALESCE(lab.name, 'No label yet') AS name,
            COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n
     ${FROM} WHERE ${w.sql}
     GROUP BY COALESCE(lab.name, 'No label yet')
     ORDER BY total DESC LIMIT ?`,
    [...w.params, Math.max(1, Math.min(limit, 30))],
  ).map((r: Record<string, unknown>) => ({ name: String(r.name), totalCents: Number(r.total), count: Number(r.n) }));
}

export function exploreCounterparties(db: DbAdapter, filters: ExploreFilters, limit = 8, now = Date.now()): ExploreBucket[] {
  const w = where({ ...filters, direction: filters.direction ?? "out" }, now);
  return db.all(
    `SELECT COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n
     ${FROM} WHERE ${w.sql}
     GROUP BY c.id, name ORDER BY total DESC LIMIT ?`,
    [...w.params, Math.max(1, Math.min(limit, 30))],
  ).map((r: Record<string, unknown>) => ({ name: String(r.name), totalCents: Number(r.total), count: Number(r.n) }));
}

export interface ExplorePlace {
  key: string; lat: number; lng: number; count: number; spendCents: number; incomeCents: number; accuracy: number | null;
  /** Most common counterparty seen at this spot, if any. Never a guessed place name. */
  label: string | null;
  lastAt: number | null;
}

/** Offline spatial clusters on a ~110m grid; no map provider and no network. */
export function explorePlaces(db: DbAdapter, filters: ExploreFilters, now = Date.now()): ExplorePlace[] {
  const w = where(filters, now);
  const rows = db.all(
    `SELECT ctx.lat, ctx.lng, ctx.accuracy_m AS accuracy, t.amount, t.direction, t.occurred_at, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName
     ${FROM} WHERE ${w.sql} AND ctx.lat IS NOT NULL AND ctx.lng IS NOT NULL`,
    w.params,
  ) as Array<{ lat: number; lng: number; accuracy: number | null; amount: number; direction: string; occurred_at: number; cpName: string | null }>;
  const grid = new Map<string, ExplorePlace & { names: Map<string, number> }>();
  for (const r of rows) {
    const lat = Math.round(Number(r.lat) * 1000) / 1000;
    const lng = Math.round(Number(r.lng) * 1000) / 1000;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const p = grid.get(key) ?? { key, lat, lng, count: 0, spendCents: 0, incomeCents: 0, accuracy: r.accuracy ?? null, label: null, lastAt: null, names: new Map<string, number>() };
    p.count += 1;
    if (r.direction === "out") p.spendCents += Number(r.amount); else p.incomeCents += Number(r.amount);
    p.lastAt = Math.max(p.lastAt ?? 0, Number(r.occurred_at));
    const name = (r.cpName ?? "").trim();
    if (name) p.names.set(name, (p.names.get(name) ?? 0) + 1);
    grid.set(key, p);
  }
  return [...grid.values()]
    .map((p) => ({ ...p, label: [...p.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, names: undefined } as ExplorePlace))
    .sort((a, b) => (b.spendCents + b.incomeCents) - (a.spendCents + a.incomeCents));
}

export type WrappedCadence = "month" | "year";

export interface WrappedAccess {
  cadence: WrappedCadence;
  unlocked: boolean;
  firstAt: number | null;
  unlockAt: number | null;
  progress: number;
  reason: "no_data" | "too_early" | "unlocked";
}

function addCalendarMonths(ms: number, months: number): number {
  const d = new Date(ms + EAT);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return Date.UTC(y, m + months, Math.min(day, last)) - EAT;
}

/**
 * Wrapped is a longitudinal product, not a day-one dashboard. A monthly edition
 * unlocks after one full calendar month of recorded history; the yearly edition
 * unlocks after twelve. The dates use EAT and clamp month-ends (31 Jan -> 28/29 Feb).
 */
export function wrappedAccess(db: DbAdapter, cadence: WrappedCadence = "month", now = Date.now()): WrappedAccess {
  const row = db.get(`SELECT MIN(occurred_at) AS first FROM tx_events`) as { first?: number | null } | undefined;
  const firstAt = row?.first == null ? null : Number(row.first);
  if (firstAt == null || !Number.isFinite(firstAt)) {
    return { cadence, unlocked: false, firstAt: null, unlockAt: null, progress: 0, reason: "no_data" };
  }
  const unlockAt = addCalendarMonths(firstAt, cadence === "month" ? 1 : 12);
  const span = Math.max(1, unlockAt - firstAt);
  const progress = Math.max(0, Math.min(1, (now - firstAt) / span));
  return {
    cadence, unlocked: now >= unlockAt, firstAt, unlockAt, progress,
    reason: now >= unlockAt ? "unlocked" : "too_early",
  };
}

export interface WrappedHighlight { label: string; value: string; detail: string; cents?: number }
export interface WrappedPlaces {
  /** distinct ~110m clusters with at least one located payment */
  count: number;
  locatedTx: number;
  locatedShare: number | null;
  topByCount: ExplorePlace | null;
  topBySpend: ExplorePlace | null;
  top: ExplorePlace[];
}

export interface WrappedResult {
  range: ExploreRange; summary: ExploreSummary;
  access: WrappedAccess;
  highlights: WrappedHighlight[];
  topCategory: ExploreBucket | null; topMerchant: ExploreBucket | null;
  activeDays: number; biggestSpend: ExploreTx | null; biggestIncome: ExploreTx | null;
  fulizaDraws: number; fulizaDrawCents: number; offRadarCents: number;
  busiestDay: { day: string; count: number } | null; biggestDay: { day: string; cents: number } | null;
  places: WrappedPlaces;
}

function dayLabel(ms: number): string {
  return new Date(ms + EAT).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function kes(cents: number): string {
  return `KES ${(cents / 100).toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
}

export function wrapped(db: DbAdapter, filters: ExploreFilters, now = Date.now()): WrappedResult {
  const summary = exploreSummary(db, filters, now);
  const cats = exploreCategories(db, filters, 1, now);
  const mers = exploreCounterparties(db, filters, 1, now);
  const all = exploreTransactions(db, filters, 500, now);
  const out = all.filter((t) => t.direction === "out");
  const income = all.filter((t) => t.direction === "in");
  const biggestSpend = out.slice().sort((a, b) => b.amount - a.amount)[0] ?? null;
  const biggestIncome = income.slice().sort((a, b) => b.amount - a.amount)[0] ?? null;
  const w = where(filters, now);
  const dayRows = db.all(
    `SELECT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+3 hours') AS d, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS spend
     ${FROM} WHERE ${w.sql} GROUP BY d ORDER BY n DESC LIMIT 1`,
    w.params,
  ) as Array<{ d: string; n: number; spend: number }>;
  const spendDays = db.all(
    `SELECT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+3 hours') AS d,
            COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS spend
     ${FROM} WHERE ${w.sql} GROUP BY d ORDER BY spend DESC LIMIT 1`,
    w.params,
  ) as Array<{ d: string; spend: number }>;
  const active = db.get(
    `SELECT COUNT(DISTINCT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+3 hours')) AS n ${FROM} WHERE ${w.sql}`,
    w.params,
  ) as { n?: number } | undefined;
  const fuliza = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE kind = 'loan_draw' AND occurred_at >= ? AND occurred_at < ?`,
    [summary.range.from, summary.range.to],
  ) as { n?: number; total?: number } | undefined;
  const located = db.get(
    `SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql} AND ctx.lat IS NOT NULL AND ctx.lng IS NOT NULL`,
    w.params,
  ) as { n?: number } | undefined;
  const allCount = Number(summary.count);
  const places = explorePlaces(db, filters, now);
  const placeStats: WrappedPlaces = {
    count: places.length,
    locatedTx: Number(located?.n ?? 0),
    locatedShare: allCount > 0 ? Number(located?.n ?? 0) / allCount : null,
    topByCount: places.slice().sort((a, b) => b.count - a.count)[0] ?? null,
    topBySpend: places.slice().sort((a, b) => b.spendCents - a.spendCents)[0] ?? null,
    top: places.slice(0, 3),
  };
  const offRadar = db.get(
    `SELECT COALESCE(SUM(t.amount), 0) AS total ${FROM}
      WHERE ${w.sql} AND lab.name = 'Off-radar transfer'`,
    w.params,
  ) as { total?: number } | undefined;

  const highlights: WrappedHighlight[] = [];
  if (biggestSpend) highlights.push({ label: "Biggest payment", value: kes(biggestSpend.amount), detail: `${biggestSpend.cpName ?? biggestSpend.kind.replace(/_/g, " ")} · ${dayLabel(biggestSpend.occurredAt)}`, cents: biggestSpend.amount });
  if (biggestIncome) highlights.push({ label: "Biggest money in", value: kes(biggestIncome.amount), detail: `${biggestIncome.cpName ?? "Incoming payment"} · ${dayLabel(biggestIncome.occurredAt)}`, cents: biggestIncome.amount });
  if (cats[0]) highlights.push({ label: "Top spending group", value: cats[0].name, detail: `${kes(cats[0].totalCents)} across ${cats[0].count} payments`, cents: cats[0].totalCents });
  if (mers[0]) highlights.push({ label: "Most paid", value: mers[0].name, detail: `${kes(mers[0].totalCents)} across ${mers[0].count} payments`, cents: mers[0].totalCents });
  if (summary.feeCents > 0) highlights.push({ label: "Fees and charges", value: kes(summary.feeCents), detail: "Money kept by providers", cents: summary.feeCents });
  if (summary.netCents >= 0) highlights.push({ label: "You kept", value: kes(summary.netCents), detail: "Money in minus spending and fees", cents: summary.netCents });
  else highlights.push({ label: "You spent more than came in", value: kes(Math.abs(summary.netCents)), detail: "Money in minus spending and fees", cents: Math.abs(summary.netCents) });
  if (Number(fuliza?.n ?? 0) > 0) highlights.push({ label: "Fuliza draws", value: `${fuliza!.n}`, detail: `${kes(Number(fuliza?.total ?? 0))} borrowed; check the limit card`, cents: Number(fuliza?.total ?? 0) });
  if (placeStats.topByCount) {
    const t = placeStats.topByCount;
    highlights.push({
      label: "Most visited place",
      value: `${t.count} payment${t.count === 1 ? "" : "s"}`,
      detail: `${t.label ? `usually ${t.label}` : "One repeated spot"} · ${kes(t.spendCents)} spent there`,
      cents: t.spendCents,
    });
  }
  if (placeStats.topBySpend && placeStats.topBySpend.key !== placeStats.topByCount?.key) {
    const t = placeStats.topBySpend;
    highlights.push({
      label: "Most spent at one place",
      value: kes(t.spendCents),
      detail: `${t.label ? `usually ${t.label}` : "One spot"} · ${t.count} payment${t.count === 1 ? "" : "s"}`,
      cents: t.spendCents,
    });
  }
  if (placeStats.locatedShare != null && placeStats.locatedShare > 0) {
    highlights.push({
      label: "Payments with a place",
      value: `${placeStats.locatedTx} of ${allCount}`,
      detail: `${Math.round(placeStats.locatedShare * 100)}% carried a recent location fix; older messages cannot be placed retroactively.`,
    });
  }

  return {
    range: summary.range, summary, access: wrappedAccess(db, filters.period === "this_year" ? "year" : "month", now), highlights,
    topCategory: cats[0] ?? null, topMerchant: mers[0] ?? null,
    activeDays: Number(active?.n ?? 0), biggestSpend, biggestIncome,
    fulizaDraws: Number(fuliza?.n ?? 0), fulizaDrawCents: Number(fuliza?.total ?? 0),
    offRadarCents: Number(offRadar?.total ?? 0),
    places: placeStats,
    busiestDay: dayRows[0] ? { day: dayRows[0].d!, count: Number(dayRows[0].n) } : null,
    biggestDay: spendDays[0] ? { day: spendDays[0].d!, cents: Number(spendDays[0].spend) } : null,
  };
}
