/**
 * Statistical + effect-size gate (WS5.1, D115). No p-value or "P=" ever reaches user copy.
 * Benjamini–Hochberg runs across every finding in one nightly pass at q <= 0.05.
 */
import type { Finding } from "./types.js";

export type FindingGate = "shown" | "below_effect" | "insufficient_data" | "not_significant";

export interface FindingEffect {
  abs: number; rel: number;
  unit: "cents" | "share" | "count" | "days" | "ratio";
  lo?: number; hi?: number;
  /** Optional monthly impact in cents; when present the KES 1,000/month floor applies. */
  absMonthlyCents?: number;
}

export interface GatedFinding extends Finding {
  qValue?: number;
  effect?: FindingEffect;
  minDataMet?: boolean;
  gate: FindingGate;
}

export interface GateOptions {
  q?: number;
  /** Minimum observations per detector when the detector did not set minDataMet itself. */
  minData?: Record<string, number>;
  /** Named floors, all overridable for tests. */
  floors?: {
    spendRel?: number; spendAbsDailyCents?: number; spendAbsMonthlyCents?: number;
    shareDelta?: number; timeShareDelta?: number;
  };
}

const DEFAULT_MIN_DATA: Record<string, number> = {
  bocpd_regime: 42, // ~21 days each side; detector tightens with actual windows
  time_of_day: 15,
  episodes: 3,
  amount_multiples: 15,
  periodic: 4,
  debt_cycle: 3,
  fee_drag: 5,
  scope_mix: 10,
  tariff_cliff: 6,
  liquidity_ruin: 30,
  mobility_phenotyping: 10,
};

const SPEND_CHANGE = new Set(["bocpd_regime", "debt_cycle", "episodes"]);

function derivedEffect(f: Finding): FindingEffect | undefined {
  const e = f.evidence as Record<string, unknown>;
  if (f.detector === "time_of_day") {
    const share = Number(e.share ?? 0), baseline = Number(e.baseline ?? 0), count = Number(e.count ?? f.n);
    return { abs: count, rel: share - baseline, unit: "count", lo: share, hi: share };
  }
  if (f.detector === "bocpd_regime") {
    const before = Number(e.beforeMeanCents ?? e.beforeMean ?? 0), after = Number(e.afterMeanCents ?? e.afterMean ?? 0);
    const rel = before > 0 ? (after - before) / before : 0;
    const beforeN = Number(e.beforeN ?? 0), afterN = Number(e.afterN ?? 0);
    const monthFactor = Math.max(beforeN, afterN) > 0 ? (30 / Math.max(1, (beforeN + afterN) / 2)) : 1;
    return {
      abs: Math.abs(after - before), rel, unit: "cents",
      absMonthlyCents: Math.abs(after - before) * Math.max(1, (beforeN + afterN) / 2) * monthFactor / 30,
    };
  }
  if (f.detector === "amount_multiples" || f.detector === "scope_mix") {
    const share = Number(e.share ?? 0), baseline = Number(e.baseline ?? 0);
    if (Number.isFinite(share) && Number.isFinite(baseline)) return { abs: share, rel: share - baseline, unit: "share" };
  }
  return undefined;
}

function passesEffect(f: Finding, effect: FindingEffect | undefined, floors: NonNullable<GateOptions["floors"]>): boolean {
  if (!effect) return true; // descriptive findings are still min-data gated
  const spendRel = floors.spendRel ?? 0.15;
  const spendDaily = floors.spendAbsDailyCents ?? 5_000;
  const spendMonthly = floors.spendAbsMonthlyCents ?? 100_000;
  const shareDelta = floors.shareDelta ?? 0.15;
  const timeDelta = floors.timeShareDelta ?? 0.10;
  if (f.detector === "time_of_day") return effect.rel >= timeDelta && f.n >= 15;
  if (SPEND_CHANGE.has(f.detector) && effect.unit === "cents") {
    const monthlyOk = effect.absMonthlyCents != null ? effect.absMonthlyCents >= spendMonthly : effect.abs * 30 >= spendMonthly;
    return Math.abs(effect.rel) >= spendRel && (effect.abs >= spendDaily || monthlyOk);
  }
  if (effect.unit === "share") return effect.rel >= shareDelta;
  return true;
}

export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  if (!m) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m).fill(1);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const idx = order[rank - 1]!.i;
    const value = Math.min(prev, (order[rank - 1]!.p * m) / rank);
    q[idx] = value;
    prev = value;
  }
  return q;
}

/** Applies min-data, effect floors and BH. Input findings are not mutated. */
export function gateFindings(findings: Finding[], opts: GateOptions = {}): GatedFinding[] {
  const qCut = opts.q ?? 0.05;
  const minData = { ...DEFAULT_MIN_DATA, ...(opts.minData ?? {}) };
  const floors = opts.floors ?? {};
  const prepared = findings.map((f) => {
    const effect = (f.effect as FindingEffect | undefined) ?? derivedEffect(f);
    const minDataMet = f.minDataMet ?? f.n >= (minData[f.detector] ?? 0);
    return { f, effect, minDataMet };
  });
  const pIdx = prepared.map((x, i) => ({ x, i })).filter(({ x }) => typeof x.f.pValue === "number" && Number.isFinite(x.f.pValue) && x.minDataMet && passesEffect(x.f, x.effect, floors));
  const qs = benjaminiHochberg(pIdx.map(({ x }) => x.f.pValue!));
  const qByIndex = new Map<number, number>();
  pIdx.forEach(({ i }, k) => qByIndex.set(i, qs[k]!));
  return prepared.map(({ f, effect, minDataMet }, i) => {
    if (!minDataMet) return { ...f, effect, minDataMet, gate: "insufficient_data" as FindingGate };
    if (!passesEffect(f, effect, floors)) return { ...f, effect, minDataMet, gate: "below_effect" as FindingGate };
    const qValue = qByIndex.get(i);
    if (qValue != null && qValue > qCut) return { ...f, effect, minDataMet, qValue, gate: "not_significant" as FindingGate };
    return { ...f, effect, minDataMet, ...(qValue != null ? { qValue } : {}), gate: "shown" as FindingGate };
  });
}

/** Belt-and-braces: user-facing titles must never contain a p-value. */
export function stripPValues(title: string): string {
  return title.replace(/\s*\(?\bP\s*[=<>]\s*[\d.]+\)?/gi, "").replace(/\s{2,}/g, " ").trim();
}
