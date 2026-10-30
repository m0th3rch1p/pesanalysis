import type { Cents, ParsedSms } from "../types.js";
import { FULIZA_VERSIONS, TARIFF_VERSIONS } from "./data/index.js";
import type {
  DateInput, TariffBand, FeeQuote, FulizaBand, FulizaClockModel, FulizaVersion, TariffKind, TariffTable, TariffVersion,
} from "./types.js";

const EAT_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** EAT calendar day (YYYY-MM-DD) of an epoch-ms or a date string. */
export function eatDay(d: DateInput): string {
  if (typeof d === "string") return d.slice(0, 10);
  return new Date(d + EAT_MS).toISOString().slice(0, 10);
}
function dayNumber(d: DateInput): number {
  return Math.floor((typeof d === "number" ? d + EAT_MS : Date.parse(`${d.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

/* ------------------------------------------------------------------ versions */

interface Resolved<T> { version: T; extrapolated: boolean }

function resolve<V extends { id: string; effectiveFrom: string; effectiveTo?: string; extrapolateBackward?: boolean }>(
  versions: V[], date: DateInput, has: (v: V) => boolean,
): Resolved<V> | null {
  const day = eatDay(date);
  const cands = versions.filter(has).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)); // newest first
  for (const v of cands) {
    if (v.effectiveFrom <= day && (!v.effectiveTo || day < v.effectiveTo)) return { version: v, extrapolated: false };
  }
  const oldest = cands[cands.length - 1];
  if (oldest && day < oldest.effectiveFrom && oldest.extrapolateBackward) return { version: oldest, extrapolated: true };
  return null;
}

export function tariffVersionFor(kind: TariffKind, date: DateInput): TariffVersion | null {
  return resolve(TARIFF_VERSIONS, date, (v) => v.tables[kind] != null)?.version ?? null;
}

/* --------------------------------------------------------------------- bands */

function bandFor(bands: TariffBand[], amountCents: Cents): TariffBand | null {
  if (!(amountCents > 0)) return null;
  const kes = Math.floor(amountCents / 100);
  return bands.find((b) => kes >= b.minKes && kes <= b.maxKes) ?? null;
}

function tableFee(t: TariffTable | undefined, amountCents: Cents): { cents: Cents; confidence: "verified" | "assumed" } | null {
  if (!t || t.type === "unpublished") return null;
  if (!(amountCents > 0)) return null;
  if (t.type === "flat") return { cents: Math.round(t.feeKes * 100), confidence: t.confidence };
  const b = bandFor(t.bands, amountCents);
  return b ? { cents: Math.round(b.feeKes * 100), confidence: t.confidence } : null;
}

/** Full quote, or null when no verified/assumed table applies (unpublished rail, outside the valid dates, out of band). */
export function quoteFee(kind: TariffKind, amountCents: Cents, date: DateInput): FeeQuote | null {
  const r = resolve(TARIFF_VERSIONS, date, (v) => v.tables[kind] != null);
  if (!r) return null;
  const f = tableFee(r.version.tables[kind], amountCents);
  if (!f) return null;
  return {
    kind, amountCents, feeCents: f.cents, tariffVersion: r.version.id,
    confidence: f.confidence, extrapolated: r.extrapolated, estimated: true,
  };
}

/** Expected customer fee in cents, or null when the tariff is unknown for this rail/amount/date. */
export function expectedFee(kind: TariffKind, amountCents: Cents, date: DateInput): Cents | null {
  return quoteFee(kind, amountCents, date)?.feeCents ?? null;
}

/**
 * Amounts (in cents) at which the fee for `kind` steps UP when the amount crosses the band edge, with the
 * fee on each side. Derived from the table so detectors carry no constants.
 */
export function feeBoundaries(kind: TariffKind, date: DateInput): Array<{ boundaryCents: Cents; feeBelowCents: Cents; feeAboveCents: Cents }> {
  const r = resolve(TARIFF_VERSIONS, date, (v) => v.tables[kind] != null);
  const t = r?.version.tables[kind];
  if (!t || t.type !== "bands") return [];
  const out: Array<{ boundaryCents: Cents; feeBelowCents: Cents; feeAboveCents: Cents }> = [];
  for (let i = 0; i + 1 < t.bands.length; i++) {
    const a = t.bands[i]!, b = t.bands[i + 1]!;
    if (b.feeKes > a.feeKes) {
      out.push({ boundaryCents: a.maxKes * 100, feeBelowCents: Math.round(a.feeKes * 100), feeAboveCents: Math.round(b.feeKes * 100) });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- Fuliza */

function fulizaResolved(date?: DateInput): FulizaVersion | null {
  if (date == null) return FULIZA_VERSIONS.reduce<FulizaVersion | null>((a, v) => (!a || v.effectiveFrom > a.effectiveFrom ? v : a), null);
  return resolve(FULIZA_VERSIONS, date, () => true)?.version ?? null;
}

export function fulizaVersionFor(date?: DateInput): FulizaVersion | null {
  return fulizaResolved(date);
}

function fulizaBand(v: FulizaVersion, outstandingCents: Cents): FulizaBand | null {
  if (!(outstandingCents > 0)) return null;
  for (const b of v.bands) if (outstandingCents <= b.maxKes * 100) return b;
  return v.bands[v.bands.length - 1] ?? null; // above the maximum limit: cap at the top band
}

/** One-off access fee on a draw (1%), rounded to the cent. */
export function fulizaAccessFee(drawCents: Cents, date?: DateInput): Cents | null {
  const v = fulizaResolved(date);
  return v ? Math.round(drawCents * v.accessFeeRate) : null;
}

export interface FulizaFeeOpts { date?: DateInput }

/**
 * Daily maintenance fee (cents, inclusive of 20% excise duty) charged at midnight on the OUTSTANDING amount.
 * `daysSinceDraw` is the 1-based index of the midnight charge on the free-window clock: 1 = the first
 * midnight after the clock started. Bands 101-500 and 501-1,000 are not charged while daysSinceDraw <= 3.
 * Which draw starts the clock is the caller's choice (see FulizaClockModel / simulateFuliza).
 * Returns null when no version applies to `opts.date`.
 */
export function fulizaDailyFee(outstandingCents: Cents, daysSinceDraw: number, opts: FulizaFeeOpts = {}): Cents | null {
  const v = fulizaResolved(opts.date);
  if (!v) return null;
  const b = fulizaBand(v, outstandingCents);
  if (!b) return 0;
  if (daysSinceDraw <= b.freeDays) return 0;
  return Math.round(b.totalFeeKes * 100);
}

/** Daily-fee band edges where the charge steps up, for cliff detection. Derived from the table. */
export function fulizaBoundaries(date?: DateInput): Array<{ boundaryCents: Cents; freeDaysAbove: number }> {
  const v = fulizaResolved(date);
  if (!v) return [];
  const out: Array<{ boundaryCents: Cents; freeDaysAbove: number }> = [];
  for (let i = 0; i + 1 < v.bands.length; i++) {
    out.push({ boundaryCents: v.bands[i]!.maxKes * 100, freeDaysAbove: v.bands[i + 1]!.freeDays });
  }
  return out;
}

export interface FulizaEvent { at: number; kind: "draw" | "repay"; amountCents: Cents }

export interface FulizaCharge { day: string; outstandingCents: Cents; dayIndex: number; feeCents: Cents; free: boolean }

export interface FulizaSimulation {
  clockModel: FulizaClockModel;
  accessFeesCents: Cents;
  dailyFeesCents: Cents;
  totalCents: Cents;
  charges: FulizaCharge[];
  endOutstandingCents: Cents;
  /** Always true: daily fees are never stated in SMS. */
  estimated: true;
  tariffVersion: string | null;
  /** Mirror of the version's `unverified` list so UIs can show the caveats. */
  unverified: string[];
}

export interface FulizaSimOpts {
  /** DEFAULT "per_episode" - UNVERIFIED. See FulizaClockModel. */
  clockModel?: FulizaClockModel;
  /** Whether the 1% access fee is added to the outstanding amount (the SMS "Total outstanding" says yes). Default true. */
  accessFeeInOutstanding?: boolean;
}

export const DEFAULT_FULIZA_CLOCK_MODEL: FulizaClockModel = "per_episode";

/**
 * Replays draws/repayments and estimates access + daily fees up to (and including the midnight
 * charges before) `untilMs`. Midnights are EAT. Repayments clear outstanding in full or in part.
 */
export function simulateFuliza(events: FulizaEvent[], untilMs: number, opts: FulizaSimOpts = {}): FulizaSimulation {
  const clockModel = opts.clockModel ?? DEFAULT_FULIZA_CLOCK_MODEL;
  const feeInOut = opts.accessFeeInOutstanding ?? true;
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const charges: FulizaCharge[] = [];
  let access = 0, daily = 0, outstanding = 0;
  let version: string | null = null;
  const first = sorted[0];
  const unverified = fulizaResolved(first?.at)?.unverified ?? [];
  if (first) {
    let clockStart = -1;
    const lastDay = dayNumber(untilMs);
    let i = 0;
    for (let d = dayNumber(first.at); d <= lastDay; d++) {
      while (i < sorted.length && dayNumber(sorted[i]!.at) === d) {
        const e = sorted[i++]!;
        if (e.kind === "draw") {
          const fee = fulizaAccessFee(e.amountCents, e.at) ?? 0;
          access += fee;
          if (outstanding === 0 || clockModel === "per_draw") clockStart = d;
          outstanding += e.amountCents + (feeInOut ? fee : 0);
        } else {
          outstanding = Math.max(0, outstanding - e.amountCents);
        }
      }
      if (d < lastDay && outstanding > 0) {
        const idx = d + 1 - clockStart; // midnight ending day d is the (d+1-clockStart)th charge
        const midnight = (d + 1) * DAY_MS - EAT_MS;
        const fee = fulizaDailyFee(outstanding, idx, { date: midnight });
        if (fee != null) {
          version = fulizaResolved(midnight)?.id ?? version;
          daily += fee;
          charges.push({ day: new Date((d + 1) * DAY_MS).toISOString().slice(0, 10), outstandingCents: outstanding, dayIndex: idx, feeCents: fee, free: fee === 0 && (fulizaDailyFee(outstanding, Number.MAX_SAFE_INTEGER, { date: midnight }) ?? 0) > 0 });
        }
      }
    }
  }
  return {
    clockModel, accessFeesCents: access, dailyFeesCents: daily, totalCents: access + daily,
    charges, endOutstandingCents: outstanding, estimated: true,
    tariffVersion: version ?? fulizaResolved(first?.at)?.id ?? null, unverified,
  };
}

/* --------------------------------------------------------------- conformance */

/** Map a parsed message to the rail whose tariff governs its `Transaction cost`; null when unmodelled. */
export function tariffKindOf(p: Pick<ParsedSms, "kind" | "template" | "counterpartyName">): TariffKind | null {
  if (p.template.includes("pochi") && p.kind === "send") return "pochi_send";
  switch (p.kind) {
    case "send": return "send";
    case "paybill": return "paybill";
    case "till": return "till";
    case "withdraw": return /^\s*atm\b/i.test(p.counterpartyName ?? "") ? "withdraw_atm" : "withdraw_agent";
    default: return null;
  }
}

export interface ConformanceMismatch {
  ref: string | null; kind: TariffKind; amountCents: Cents; statedFeeCents: Cents; expectedFeeCents: Cents; tariffVersion: string; extrapolated: boolean;
}
export interface ConformanceReport {
  checked: number; matched: number; mismatched: number;
  /** Messages with no stated fee, an unmodelled rail, or no applicable table. Excluded from the rate. */
  skipped: number;
  /** mismatched / checked (0 when checked = 0). */
  mismatchRate: number;
  byKind: Partial<Record<TariffKind, { checked: number; mismatched: number }>>;
  mismatches: ConformanceMismatch[];
}

/**
 * Stated `Transaction cost` is ground truth; recompute with the table and report disagreement.
 * Aggregate-friendly: callers on real data should publish only the counts and rate.
 */
export function checkTariffConformance(parsed: ParsedSms[]): ConformanceReport {
  const rep: ConformanceReport = { checked: 0, matched: 0, mismatched: 0, skipped: 0, mismatchRate: 0, byKind: {}, mismatches: [] };
  for (const p of parsed) {
    const kind = tariffKindOf(p);
    if (!kind || p.fee == null) { rep.skipped++; continue; }
    const q = quoteFee(kind, p.amount, p.occurredAt);
    if (!q) { rep.skipped++; continue; }
    rep.checked++;
    const k = (rep.byKind[kind] ??= { checked: 0, mismatched: 0 });
    k.checked++;
    if (q.feeCents === p.fee) { rep.matched++; continue; }
    rep.mismatched++; k.mismatched++;
    rep.mismatches.push({
      ref: p.ref, kind, amountCents: p.amount, statedFeeCents: p.fee, expectedFeeCents: q.feeCents,
      tariffVersion: q.tariffVersion, extrapolated: q.extrapolated,
    });
  }
  rep.mismatchRate = rep.checked ? rep.mismatched / rep.checked : 0;
  return rep;
}
