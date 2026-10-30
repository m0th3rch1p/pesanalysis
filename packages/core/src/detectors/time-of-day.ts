import type { Detector, Finding, LedgerTx } from "./types.js";
import { binomTail } from "./stats.js";
import { toEatParts } from "../sms/time.js";

export interface TimeOfDayOpts {
  minN?: number;      // per group (default 15)
  maxP?: number;      // screening threshold before BH (default 0.05)
  widths?: number[];  // window widths in hours (default 2,3,4,6)
  historyDays?: number; // baseline window (default 90)
}

const WIDTHS = [2, 3, 4, 6];

/** Minute of day in EAT, 0..1439. */
function minuteOfDay(ms: number): number {
  const p = toEatParts(ms);
  return p.hour * 60 + p.minute;
}

function inWindow(minute: number, startHour: number, widthHours: number): boolean {
  const start = startHour * 60;
  const span = widthHours * 60;
  return (minute - start + 1440) % 1440 < span;
}

function labelFor(key: string): string {
  const m = /^(?:label|item|habit):(.+)\|(in|out)$/.exec(key);
  if (m) return `${m[1]!.toLowerCase()} ${m[2] === "in" ? "credits" : "debits"}`;
  const d = /^(?:dir|funding):(in|out|credit|wallet)$/.exec(key);
  if (d) return d[1] === "in" ? "incoming transactions" : d[1] === "credit" ? "credit-funded purchases" : d[1] === "wallet" ? "wallet purchases" : "outgoing payments";
  return "these payments";
}

/**
 * Full-circle hour-of-day detector (WS5.2). Windows wrap midnight, and the null baseline is the
 * user's own activity distribution over the last 90 days, not a uniform 24-hour day. A daytime-only
 * user therefore produces no "you spend in the daytime" finding.
 */
export const detectTimeOfDay: Detector<TimeOfDayOpts> = (txs, opts = {}) => {
  const { minN = 15, maxP = 0.05, widths = WIDTHS, historyDays = 90 } = opts;
  if (!txs.length) return [];
  const latest = Math.max(...txs.map((t) => t.occurredAt));
  const since = latest - historyDays * 86_400_000;
  const recent = txs.filter((t) => t.occurredAt >= since && t.direction !== "neutral");
  if (recent.length < minN) return [];

  // Baseline: every transaction (all groups) contributes to the user's own hourly distribution.
  const byHour = new Array<number>(24).fill(0);
  for (const t of recent) { const h = toEatParts(t.occurredAt).hour; byHour[h] = (byHour[h] ?? 0) + 1; }
  const activeHours = Math.max(1, byHour.filter((n) => n > 0).length);
  const baselineFor = (start: number, width: number): number => {
    let active = 0;
    for (let h = 0; h < width; h++) if ((byHour[(start + h) % 24] ?? 0) > 0) active++;
    // The user's own active hours, not a uniform 24-hour day. A daytime-only user has
    // baseline 0 for a night window, so it cannot be "significant" unless they actually spend then.
    return Math.max(0, active / activeHours);
  };

  const groups = new Map<string, LedgerTx[]>();
  const add = (key: string, t: LedgerTx) => { const a = groups.get(key) ?? []; a.push(t); groups.set(key, a); };
  for (const t of recent) {
    if (t.direction !== "in" && t.direction !== "out") continue;
    add(`dir:${t.direction}`, t);
    if (t.label) add(`label:${t.label}|${t.direction}`, t);
    for (const item of t.items ?? []) add(`item:${item}|${t.direction}`, t);
    for (const habit of t.habits ?? []) add(`habit:${habit}|${t.direction}`, t);
    if (t.funding === "credit" || t.funding === "wallet") add(`funding:${t.funding}|${t.direction}`, t);
  }

  const out: Finding[] = [];
  for (const [key, group] of groups) {
    if (group.length < minN) continue;
    const minutes = group.map((t) => minuteOfDay(t.occurredAt));
    const candidates: Array<{ start: number; width: number; k: number; p: number; share: number; baseline: number }> = [];
    for (const width of widths) {
      for (let start = 0; start < 24; start++) {
        const k = minutes.reduce((n, m) => n + (inWindow(m, start, width) ? 1 : 0), 0);
        const share = k / group.length;
        const baseline = baselineFor(start, width);
        if (share <= baseline) continue;
        const p = baseline <= 0 ? 0 : binomTail(group.length, k, baseline);
        if (p <= maxP) candidates.push({ start, width, k, p, share, baseline });
      }
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => a.p - b.p || b.share - a.share || b.width - a.width);
    // One finding per group: strongest, then non-overlapping windows.
    const chosen: typeof candidates = [];
    for (const c of candidates) {
      const overlaps = chosen.some((x) => {
        for (let m = 0; m < c.width * 60; m += 30) {
          const minute = (c.start * 60 + m) % 1440;
          const xStart = x.start * 60, xEnd = xStart + x.width * 60;
          if ((minute - xStart + 1440) % 1440 < xEnd - xStart) return true;
        }
        return false;
      });
      if (!overlaps) chosen.push(c);
      if (chosen.length >= 2) break;
    }
    for (const c of chosen) {
      const end = (c.start + c.width) % 24;
      const window = [c.start, end] as [number, number];
      out.push({
        detector: "time_of_day",
        id: `time_of_day:${key}:${c.start}-${c.width}`,
        title: `${Math.round(c.share * 100)}% of ${labelFor(key)} fall between ${String(c.start).padStart(2, "0")}:00 and ${String(end).padStart(2, "0")}:00 (usually ${Math.round(c.baseline * 100)}%)`,
        n: group.length, pValue: c.p,
        effect: { abs: c.k, rel: c.share - c.baseline, unit: "share", lo: c.share, hi: c.share },
        evidence: { window, widthHours: c.width, count: c.k, group: key, share: c.share, baseline: c.baseline },
      });
    }
  }
  return out;
};
