/** Pure helpers behind the Plan tab: spend quantiles, recurring-pattern suggestions, copy for delay stats, 30-day strip, amount parsing. */
import { type DayStr, addDays, dayNumber, dayOf, diffDays, ymd } from "./eat.js";
import type { DelayStats, OccState } from "./matcher.js";

// ---------- daily spend quantiles (feeds floatSnapshot p50/p90) ----------

export interface SpendPoint { occurredAt: number; amountCents: number }

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * p50 / p90 of daily spend over the last `days` completed EAT days (today excluded, zero-spend days included).
 * `enough` is false when fewer than `minDays` days of history exist, in which case callers should show an estimate.
 */
export function dailySpendQuantiles(events: SpendPoint[], nowMs: number, days = 60, minDays = 14): { p50Cents: number; p90Cents: number; enough: boolean; observedDays: number } {
  const today = dayNumber(nowMs);
  const first = events.reduce((m, e) => Math.min(m, dayNumber(e.occurredAt)), Infinity);
  const span = Number.isFinite(first) ? Math.min(days, today - first) : 0;
  if (span <= 0) return { p50Cents: 0, p90Cents: 0, enough: false, observedDays: 0 };
  const buckets = new Array<number>(span).fill(0);
  for (const e of events) {
    const k = today - 1 - dayNumber(e.occurredAt); // 0 = yesterday
    if (k >= 0 && k < span) buckets[k]! += e.amountCents;
  }
  const sorted = [...buckets].sort((a, b) => a - b);
  return { p50Cents: Math.round(quantile(sorted, 0.5)), p90Cents: Math.round(quantile(sorted, 0.9)), enough: span >= minDays, observedDays: span };
}

// ---------- recurring-pattern suggestions ----------

export interface PatternTx { occurredAt: number; direction: "in" | "out"; amountCents: number; key: string; name: string }
export interface FlowSuggestion {
  key: string; name: string; direction: "in" | "out"; cadence: "monthly" | "weekly";
  dayOfMonth: number | null; weekday: number | null;
  minCents: number; typCents: number; maxCents: number; n: number; lastOn: DayStr;
}

function median(xs: number[]): number { return quantile([...xs].sort((a, b) => a - b), 0.5); }

/**
 * Proposes monthly (gaps 26..35 days) or weekly (gaps 6..8 days) patterns with >= minN occurrences, a tolerant amount spread (max <= 2x min)
 * and a last occurrence within two periods of now. Deliberately conservative; the user confirms or dismisses.
 * `skipKeys` are counterparty keys the user already tracks or dismissed.
 */
export function suggestRecurring(txs: PatternTx[], nowMs: number, skipKeys: ReadonlySet<string> = new Set(), minN = 3): FlowSuggestion[] {
  const groups = new Map<string, PatternTx[]>();
  for (const t of txs) {
    if (!t.key || t.amountCents <= 0) continue;
    const k = `${t.direction}|${t.key}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: FlowSuggestion[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    if (skipKeys.has(first.key) || g.length < minN) continue;
    const s = [...g].sort((a, b) => a.occurredAt - b.occurredAt);
    const days = s.map((t) => dayNumber(t.occurredAt));
    const gaps: number[] = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i]! - days[i - 1]!);
    const med = median(gaps);
    const monthly = med >= 26 && med <= 35, weekly = med >= 6 && med <= 8;
    if (!monthly && !weekly) continue;
    const lo = monthly ? 24 : 5, hi = monthly ? 38 : 9;
    if (gaps.filter((x) => x >= lo && x <= hi).length < gaps.length * 0.8) continue;
    const amts = s.map((t) => t.amountCents);
    const mn = Math.min(...amts), mx = Math.max(...amts);
    if (mx > mn * 2) continue;
    const last = s[s.length - 1]!;
    if (dayNumber(nowMs) - dayNumber(last.occurredAt) > (monthly ? 70 : 16)) continue;
    const doms = s.map((t) => ymd(dayOf(t.occurredAt)).d);
    const wds = s.map((t) => (new Date(t.occurredAt + 3 * 3_600_000).getUTCDay()));
    out.push({
      key: first.key, name: s.find((t) => t.name)?.name || first.key, direction: first.direction,
      cadence: monthly ? "monthly" : "weekly",
      dayOfMonth: monthly ? Math.round(median(doms)) : null, weekday: weekly ? Math.round(median(wds)) : null,
      minCents: mn, typCents: Math.round(median(amts)), maxCents: mx, n: s.length, lastOn: dayOf(last.occurredAt),
    });
  }
  return out.sort((a, b) => b.n - a.n || b.typCents - a.typCents);
}

// ---------- copy ----------

export const OCC_STATE_LABEL: Record<OccState, string> = {
  upcoming: "Upcoming", matched: "Received", late: "Late", partial: "Part paid", missed: "Missed", waived: "Skipped",
};
/** Direction-aware: outgoing money is "Paid", not "Received". */
export function occStateLabel(state: OccState, direction: "in" | "out"): string {
  if (state === "matched") return direction === "in" ? "Received" : "Paid";
  if (state === "partial") return direction === "in" ? "Part received" : "Part paid";
  return OCC_STATE_LABEL[state];
}

/** "Usually arrives 2 days late" / "usually on time" / "usually 1 day early"; null with fewer than 3 decided samples. */
export function delayPhrase(s: DelayStats, direction: "in" | "out" = "in"): string | null {
  if (s.decided < 3 || s.medianDelayDays == null) return null;
  const verb = direction === "in" ? "arrives" : "is paid";
  const d = Math.round(s.medianDelayDays);
  if (d === 0) return `Usually ${verb} on time`;
  const n = Math.abs(d);
  return `Usually ${verb} ${n} day${n === 1 ? "" : "s"} ${d > 0 ? "late" : "early"}`;
}

export function daysPhrase(n: number): string { return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; }

/** "Thu 29 Oct" for an EAT day string. */
export function dayLabel(day: DayStr): string {
  const { y, m, d } = ymd(day);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()]} ${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
}

// ---------- 30-day strip ----------

export interface StripItem { name: string; direction: "in" | "out"; cents: number; state: OccState }
export interface StripDay { day: DayStr; offset: number; inCents: number; outCents: number; items: StripItem[] }

/** One bucket per day for `days` days from `from`. Skipped (waived) and already-settled occurrences are left out. */
export function upcomingStrip(
  occs: Array<{ dueOn: DayStr; state: OccState; expectedCents: number | null; receivedCents: number; name: string; direction: "in" | "out" }>,
  from: DayStr, days = 30,
): StripDay[] {
  const out: StripDay[] = [];
  for (let i = 0; i < days; i++) out.push({ day: addDays(from, i), offset: i, inCents: 0, outCents: 0, items: [] });
  for (const o of occs) {
    if (o.state === "waived" || o.state === "matched" || o.state === "missed") continue;
    // overdue-but-open items sit on today so they are not lost
    const off = Math.max(0, diffDays(o.dueOn, from));
    if (off >= days) continue;
    const cents = Math.max(0, (o.expectedCents ?? 0) - o.receivedCents);
    const b = out[off]!;
    b.items.push({ name: o.name, direction: o.direction, cents, state: o.state });
    if (o.direction === "in") b.inCents += cents; else b.outCents += cents;
  }
  return out;
}

// ---------- amount input ----------

/** "12,500" / "12500.50" / "ksh 1 200" -> integer cents; null for anything else (never NaN). */
export function parseKesToCents(input: string): number | null {
  const t = input.replace(/ksh|kes|,|\s/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const cents = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents back to an editable string without the currency prefix. */
export function centsToInput(c: number | null | undefined): string {
  if (c == null) return "";
  return c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
}
