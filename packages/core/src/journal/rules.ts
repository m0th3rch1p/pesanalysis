/**
 * Decision-journal rules and adherence evaluation (F-JOURNAL). Pure; days are Africa/Nairobi calendar days.
 * A day is `na` when the ledger does not cover it (no data is not the same as "followed").
 */
import { type DayStr, addDays, dayOf, dayStartMs, diffDays } from "../expect/eat.js";

export interface JournalLedgerTx {
  id: number;
  occurredAt: number;
  direction: "in" | "out";
  amountCents: number;
  feeCents?: number;
  flowClass: string | null;
  isFulizaDraw?: boolean;
  labelId?: number | null;
}

export type JournalRule =
  | { kind: "daily_spend_max"; maxCents: number; labelId?: number | null }
  | { kind: "weekly_spend_max"; maxCents: number; labelId?: number | null }
  | { kind: "no_fuliza_draw"; days?: number }
  | { kind: "no_send_over"; cents: number }
  | { kind: "no_txn_after_hour"; hour: number };

export type CheckState = "followed" | "slipped" | "skipped" | "na";
export interface DayCheck { onDate: DayStr; state: CheckState; evidenceTxIds: number[]; detail: string }

export interface LedgerCoverage { fromMs: number; throughMs: number }

export interface EvalWindow {
  startOn: DayStr;
  /** inclusive; null = open-ended */
  endOn: DayStr | null;
  coverage: LedgerCoverage | null;
  nowMs: number;
}

const isSpend = (t: JournalLedgerTx) => t.direction === "out" && (t.flowClass === "spend" || t.flowClass === "fee");
const spendOf = (t: JournalLedgerTx) => (t.flowClass === "fee" ? t.amountCents : t.amountCents + (t.feeCents ?? 0));
const eatHour = (ms: number) => new Date(ms + 3 * 3_600_000).getUTCHours();

function inScope(t: JournalLedgerTx, labelId?: number | null): boolean { return labelId == null || t.labelId === labelId; }

export function validateJournalRule(r: unknown): r is JournalRule {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
  switch (x.kind) {
    case "daily_spend_max": case "weekly_spend_max": return num(x.maxCents);
    case "no_fuliza_draw": return x.days == null || (num(x.days) && (x.days as number) >= 1);
    case "no_send_over": return num(x.cents);
    case "no_txn_after_hour": return num(x.hour) && (x.hour as number) <= 23;
    default: return false;
  }
}

/** The days that can be judged: startOn .. min(endOn, yesterday), minus days outside ledger coverage (those become `na`). */
export function evaluationDays(w: EvalWindow, ruleDays?: number): DayStr[] {
  const yesterday = addDays(dayOf(w.nowMs), -1);
  let end = w.endOn && w.endOn < yesterday ? w.endOn : yesterday;
  if (ruleDays != null) { const t = addDays(w.startOn, ruleDays - 1); if (t < end) end = t; }
  const out: DayStr[] = [];
  for (let d = w.startOn; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function covered(day: DayStr, c: LedgerCoverage | null): boolean {
  if (!c) return false;
  return dayStartMs(day) >= dayStartMs(dayOf(c.fromMs)) && dayStartMs(addDays(day, 1)) <= c.throughMs;
}

export function evaluateJournalRule(rule: JournalRule, txs: JournalLedgerTx[], w: EvalWindow): DayCheck[] {
  const days = evaluationDays(w, rule.kind === "no_fuliza_draw" ? rule.days : undefined);
  const byDay = new Map<DayStr, JournalLedgerTx[]>();
  for (const t of txs) { const d = dayOf(t.occurredAt); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t); }
  const on = (d: DayStr) => byDay.get(d) ?? [];

  return days.map((d): DayCheck => {
    if (!covered(d, w.coverage)) return { onDate: d, state: "na", evidenceTxIds: [], detail: "no ledger coverage for this day" };
    switch (rule.kind) {
      case "daily_spend_max": {
        const rows = on(d).filter((t) => isSpend(t) && inScope(t, rule.labelId));
        const sum = rows.reduce((a, t) => a + spendOf(t), 0);
        return sum <= rule.maxCents
          ? { onDate: d, state: "followed", evidenceTxIds: [], detail: `spent ${sum} of ${rule.maxCents} cents` }
          : { onDate: d, state: "slipped", evidenceTxIds: rows.map((t) => t.id), detail: `spent ${sum} over ${rule.maxCents} cents` };
      }
      case "weekly_spend_max": {
        // rolling 7 days ending on d, clipped to the start of the decision: early days are a lower bound
        const from = addDays(d, -6) < w.startOn ? w.startOn : addDays(d, -6);
        const rows: JournalLedgerTx[] = [];
        for (let x = from; x <= d; x = addDays(x, 1)) rows.push(...on(x).filter((t) => isSpend(t) && inScope(t, rule.labelId)));
        const sum = rows.reduce((a, t) => a + spendOf(t), 0);
        return sum <= rule.maxCents
          ? { onDate: d, state: "followed", evidenceTxIds: [], detail: `${diffDays(d, from) + 1}-day spend ${sum} of ${rule.maxCents} cents` }
          : { onDate: d, state: "slipped", evidenceTxIds: rows.map((t) => t.id), detail: `${diffDays(d, from) + 1}-day spend ${sum} over ${rule.maxCents} cents` };
      }
      case "no_fuliza_draw": {
        const rows = on(d).filter((t) => t.isFulizaDraw);
        return rows.length
          ? { onDate: d, state: "slipped", evidenceTxIds: rows.map((t) => t.id), detail: `${rows.length} Fuliza draw(s)` }
          : { onDate: d, state: "followed", evidenceTxIds: [], detail: "no Fuliza draw" };
      }
      case "no_send_over": {
        const rows = on(d).filter((t) => t.direction === "out" && t.flowClass !== "fee" && t.amountCents > rule.cents);
        return rows.length
          ? { onDate: d, state: "slipped", evidenceTxIds: rows.map((t) => t.id), detail: `${rows.length} send(s) over ${rule.cents} cents` }
          : { onDate: d, state: "followed", evidenceTxIds: [], detail: "no send over the limit" };
      }
      case "no_txn_after_hour": {
        const rows = on(d).filter((t) => t.direction === "out" && eatHour(t.occurredAt) >= rule.hour && (isSpend(t) || t.isFulizaDraw));
        return rows.length
          ? { onDate: d, state: "slipped", evidenceTxIds: rows.map((t) => t.id), detail: `${rows.length} payment(s) at or after ${rule.hour}:00` }
          : { onDate: d, state: "followed", evidenceTxIds: [], detail: `nothing at or after ${rule.hour}:00` };
      }
    }
  });
}

export interface Adherence {
  followed: number;
  slipped: number;
  skipped: number;
  na: number;
  /** followed + slipped: the only days that carry information */
  evaluated: number;
  adherence: number | null;
  /** 95% Wilson interval for the adherence share; null when evaluated = 0 */
  interval: { low: number; high: number } | null;
  minSample: number;
  sampleSufficient: boolean;
  verdict: "insufficient_data" | "mostly_followed" | "mixed" | "mostly_slipped";
  /** counts first, no inflated claims */
  summary: string;
  /** rules with a fixed length: did the whole window pass? null while incomplete or without a target */
  targetMet: boolean | null;
}

export const DEFAULT_MIN_ADHERENCE_DAYS = 7;

export function journalWilson(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Manual check-ins override auto checks for the same day. */
export function mergeChecks(auto: DayCheck[], manual: Array<{ onDate: DayStr; state: CheckState }>): Array<{ onDate: DayStr; state: CheckState; source: "auto" | "manual" }> {
  const m = new Map<DayStr, { onDate: DayStr; state: CheckState; source: "auto" | "manual" }>();
  for (const a of auto) m.set(a.onDate, { onDate: a.onDate, state: a.state, source: "auto" });
  for (const x of manual) m.set(x.onDate, { onDate: x.onDate, state: x.state, source: "manual" });
  return [...m.values()].sort((a, b) => (a.onDate < b.onDate ? -1 : 1));
}

export function summariseAdherence(checks: Array<{ state: CheckState }>, opts: { minSample?: number; targetDays?: number | null } = {}): Adherence {
  const minSample = opts.minSample ?? DEFAULT_MIN_ADHERENCE_DAYS;
  const c = { followed: 0, slipped: 0, skipped: 0, na: 0 };
  for (const k of checks) c[k.state]++;
  const evaluated = c.followed + c.slipped;
  const adherence = evaluated ? c.followed / evaluated : null;
  const sufficient = evaluated >= minSample;
  const verdict: Adherence["verdict"] = !sufficient ? "insufficient_data" : adherence! >= 0.8 ? "mostly_followed" : adherence! >= 0.5 ? "mixed" : "mostly_slipped";
  const td = opts.targetDays ?? null;
  const targetMet = td != null && evaluated >= td ? c.slipped === 0 : null;
  const summary = `${c.followed} followed, ${c.slipped} slipped over ${evaluated} judged day${evaluated === 1 ? "" : "s"}` +
    (c.skipped || c.na ? ` (${c.skipped} skipped, ${c.na} without data)` : "") +
    (sufficient ? "." : `. Fewer than ${minSample} judged days: too early to say how it is going.`);
  return { ...c, evaluated, adherence, interval: journalWilson(c.followed, evaluated), minSample, sampleSufficient: sufficient, verdict, summary, targetMet };
}
