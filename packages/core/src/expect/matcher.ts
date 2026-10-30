/**
 * Deterministic matcher: assigns ledger transactions to expected occurrences and derives the occurrence state.
 *
 * State machine (per occurrence, recomputed from scratch on every run, so it is idempotent and order-independent):
 *   waived                      sticky, never touched
 *   received >= need            matched   (delay = completing transaction day - due day, signed)
 *   0 < received < need         partial
 *   nothing received            upcoming  while today <= due + grace
 *                               late      while today <= due + missedAfter
 *                               missed    afterwards
 * A receipt that arrives after `missed` re-opens it to matched/partial (late -> matched), if inside the window.
 * `need` = amount_min, else typical, else max. Without any amount, one transaction completes it.
 */
import { type DayStr, addDays, dayOf, diffDays } from "./eat.js";

export type OccState = "upcoming" | "matched" | "late" | "partial" | "missed" | "waived";

export interface MatchFlowSpec {
  direction: "in" | "out";
  hint?: string | null;
  minCents?: number | null;
  typCents?: number | null;
  maxCents?: number | null;
  graceDays: number;
  missedAfterDays: number;
  earlyDays: number;
}

export interface MatchOccurrence {
  id: number;
  dueOn: DayStr;
  waived?: boolean;
  pinned?: number[];
  rejected?: number[];
}

export interface MatchTx {
  id: number;
  direction: "in" | "out";
  amountCents: number;
  occurredAt: number;
  /** counterparty name, account, template: whatever identifies the other side. */
  text: string;
}

export interface MatchOptions {
  /** Relative amount tolerance (default 2%). */
  tolerance?: number;
  /** Transactions already claimed by other flows; they are not offered here. */
  usedTxIds?: ReadonlySet<number>;
  /** Days after the missed deadline during which a late arrival still re-opens an occurrence. Default 14. */
  recoveryDays?: number;
}

export interface OccurrenceResult {
  id: number;
  state: OccState;
  matchedTxIds: number[];
  receivedCents: number;
  expectedCents: number | null;
  /** Signed whole days of the completing (matched) or first (partial) receipt vs due. Null when nothing received. */
  delayDays: number | null;
  /** received - typical (else minimum) amount when known: the income delta. */
  amountDeltaCents: number | null;
  resolvedAt: number | null;
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Every hint token must appear as a substring of the normalised text. */
export function hintMatches(hint: string | null | undefined, text: string): boolean {
  const h = normalizeText(hint ?? "");
  if (!h) return true;
  const t = normalizeText(text);
  return h.split(" ").every((tok) => t.includes(tok));
}

export function needCents(spec: Pick<MatchFlowSpec, "minCents" | "typCents" | "maxCents">): number | null {
  return spec.minCents ?? spec.typCents ?? spec.maxCents ?? null;
}

interface Cand { occIdx: number; tx: MatchTx; score: number; dt: number }

export function matchFlow(
  spec: MatchFlowSpec,
  occurrences: MatchOccurrence[],
  txs: MatchTx[],
  nowMs: number,
  opts: MatchOptions = {},
): OccurrenceResult[] {
  const tol = opts.tolerance ?? 0.02;
  const recovery = opts.recoveryDays ?? 14;
  const used = opts.usedTxIds ?? new Set<number>();
  const hasHint = !!normalizeText(spec.hint ?? "");
  const lo = spec.minCents ?? spec.typCents ?? spec.maxCents ?? null;
  const hi = spec.maxCents ?? spec.typCents ?? spec.minCents ?? null;
  const need = needCents(spec);
  const typ = spec.typCents ?? null;
  const today = dayOf(nowMs);

  const at = (i: number): MatchOccurrence => occurrences[i]!;
  const order = occurrences.map((_, i) => i).sort((a, b) => (at(a).dueOn < at(b).dueOn ? -1 : at(a).dueOn > at(b).dueOn ? 1 : at(a).id - at(b).id));
  // Windows [startDay, endDay], clipped so consecutive occurrences do not share arrivals.
  const win = new Map<number, { start: DayStr; end: DayStr }>();
  order.forEach((idx, k) => {
    const o = at(idx);
    const start = addDays(o.dueOn, -spec.earlyDays);
    let end = addDays(o.dueOn, spec.missedAfterDays + recovery);
    const nextIdx = order[k + 1];
    const next = nextIdx != null ? at(nextIdx) : null;
    if (next) {
      const clip = addDays(next.dueOn, -spec.earlyDays - 1);
      if (clip < end) end = clip;
    }
    if (end < o.dueOn) end = o.dueOn;
    win.set(idx, { start, end });
  });

  const assigned = new Map<number, MatchTx[]>(); // occIdx -> txs
  const taken = new Set<number>();
  const txById = new Map(txs.map((t) => [t.id, t]));

  // 1. pinned (manual "this is it") always win
  occurrences.forEach((o, idx) => {
    if (o.waived) return;
    for (const id of o.pinned ?? []) {
      const t = txById.get(id);
      if (!t || taken.has(id)) continue;
      taken.add(id);
      (assigned.get(idx) ?? assigned.set(idx, []).get(idx)!).push(t);
    }
  });

  const received = (idx: number) => (assigned.get(idx) ?? []).reduce((a, t) => a + t.amountCents, 0);
  const complete = (idx: number) => {
    const a = assigned.get(idx) ?? [];
    if (!a.length) return false;
    return need == null ? true : received(idx) >= need * (1 - tol);
  };

  // 2. candidate pairs
  const cands: Cand[] = [];
  occurrences.forEach((o, idx) => {
    if (o.waived) return;
    const w = win.get(idx)!;
    const span = Math.max(1, diffDays(w.end, w.start));
    const rej = new Set(o.rejected ?? []);
    for (const t of txs) {
      if (t.direction !== spec.direction || t.amountCents <= 0) continue;
      if (taken.has(t.id) || used.has(t.id) || rej.has(t.id)) continue;
      const day = dayOf(t.occurredAt);
      if (day < w.start || day > w.end) continue;
      if (hasHint && !hintMatches(spec.hint, t.text)) continue;
      // amount eligibility
      if (hasHint) {
        if (spec.direction === "out" && hi != null && t.amountCents > hi * (1 + tol)) continue;
      } else {
        if (lo == null || hi == null) continue; // nothing identifies it
        if (t.amountCents < lo * (1 - tol) || t.amountCents > hi * (1 + tol)) continue;
      }
      let amountS = 0.5;
      if (lo != null && hi != null) {
        const ref = Math.max(1, spec.typCents ?? hi);
        const dist = t.amountCents < lo ? lo - t.amountCents : t.amountCents > hi ? t.amountCents - hi : 0;
        amountS = dist === 0 ? 1 : Math.max(0, 1 - dist / ref);
      }
      const dt = Math.abs(diffDays(day, o.dueOn));
      const timeS = 1 - Math.min(1, dt / span);
      const score = 0.4 * (hasHint ? 1 : 0.4) + 0.35 * amountS + 0.25 * timeS;
      cands.push({ occIdx: idx, tx: t, score, dt });
    }
  });
  cands.sort((a, b) => b.score - a.score || a.dt - b.dt || a.tx.id - b.tx.id || at(a.occIdx).id - at(b.occIdx).id);
  for (const c of cands) {
    if (taken.has(c.tx.id) || complete(c.occIdx)) continue;
    taken.add(c.tx.id);
    (assigned.get(c.occIdx) ?? assigned.set(c.occIdx, []).get(c.occIdx)!).push(c.tx);
  }

  // 3. states
  return occurrences.map((o, idx): OccurrenceResult => {
    if (o.waived) {
      return { id: o.id, state: "waived", matchedTxIds: [], receivedCents: 0, expectedCents: need, delayDays: null, amountDeltaCents: null, resolvedAt: null };
    }
    const list = [...(assigned.get(idx) ?? [])].sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);
    const rec = list.reduce((a, t) => a + t.amountCents, 0);
    const base = { id: o.id, matchedTxIds: list.map((t) => t.id), receivedCents: rec, expectedCents: need };
    if (list.length) {
      // completing transaction: first prefix whose running sum reaches need
      let run = 0, done: MatchTx | null = null;
      for (const t of list) { run += t.amountCents; if (need == null || run >= need * (1 - tol)) { done = t; break; } }
      const first = list[0]!;
      const delay = (t: MatchTx) => diffDays(dayOf(t.occurredAt), o.dueOn);
      const ref = typ ?? need;
      const delta = ref != null ? rec - ref : null;
      if (done) return { ...base, state: "matched", delayDays: delay(done), amountDeltaCents: delta, resolvedAt: done.occurredAt };
      return { ...base, state: "partial", delayDays: delay(first), amountDeltaCents: delta, resolvedAt: null };
    }
    const since = diffDays(today, o.dueOn);
    const state: OccState = since <= spec.graceDays ? "upcoming" : since <= spec.missedAfterDays ? "late" : "missed";
    return { ...base, state, delayDays: null, amountDeltaCents: null, resolvedAt: null };
  });
}

// ---------- statistics ----------

export function robustMedian(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation, scaled by 1.4826 to estimate a standard deviation under normality. */
export function madScaled(xs: number[]): number | null {
  const m = robustMedian(xs);
  if (m == null) return null;
  return 1.4826 * (robustMedian(xs.map((x) => Math.abs(x - m))) as number);
}

export interface StatRow { state: OccState; delayDays: number | null; receivedCents: number; expectedCents: number | null }

export interface DelayStats {
  /** occurrences considered (waived excluded, upcoming excluded). */
  decided: number;
  counts: Record<OccState, number>;
  /** Signed delays of matched + partial receipts. */
  medianDelayDays: number | null;
  madDelayDays: number | null;
  /** share of decided occurrences matched with delay <= 0. */
  onTimeRate: number | null;
  /** share of decided occurrences matched with delay <= graceDays. */
  withinGraceRate: number | null;
  /** value-weighted reliability in [0,1]: money received (capped at expected) / money expected, over decided occurrences. Null without amounts. */
  reliability: number | null;
  /** share of decided occurrences that were matched or partial. */
  arrivalRate: number | null;
}

/** `late` counts as decided (it is overdue); `upcoming` and `waived` do not. */
export function delayStats(rows: StatRow[], graceDays = 1): DelayStats {
  const counts: Record<OccState, number> = { upcoming: 0, matched: 0, late: 0, partial: 0, missed: 0, waived: 0 };
  for (const r of rows) counts[r.state]++;
  const decidedRows = rows.filter((r) => r.state !== "upcoming" && r.state !== "waived");
  const decided = decidedRows.length;
  const delays = decidedRows.filter((r) => (r.state === "matched" || r.state === "partial") && r.delayDays != null).map((r) => r.delayDays as number);
  const matched = decidedRows.filter((r) => r.state === "matched");
  const onTime = matched.filter((r) => (r.delayDays ?? 0) <= 0).length;
  const inGrace = matched.filter((r) => (r.delayDays ?? 0) <= graceDays).length;
  const withAmount = decidedRows.filter((r) => r.expectedCents != null && r.expectedCents > 0);
  const exp = withAmount.reduce((a, r) => a + (r.expectedCents as number), 0);
  const got = withAmount.reduce((a, r) => a + Math.min(r.receivedCents, r.expectedCents as number), 0);
  return {
    decided, counts,
    medianDelayDays: robustMedian(delays),
    madDelayDays: madScaled(delays),
    onTimeRate: decided ? onTime / decided : null,
    withinGraceRate: decided ? inGrace / decided : null,
    reliability: exp > 0 ? got / exp : null,
    arrivalRate: decided ? (counts.matched + counts.partial) / decided : null,
  };
}
