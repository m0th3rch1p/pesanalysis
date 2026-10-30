import type { Cents, ParsedSms } from "../types.js";
import { counterpartyKey } from "../entities/normalize.js";

/**
 * Consolidation rollups (schema `sessions`): daily/weekly/monthly/yearly buckets with sums,
 * fees, loan movement, and soft-merge candidates for counterparties (same human, several raw
 * spellings/numbers -> propose a merge in the session; applied as merged_into, never deleted).
 */

export type Cadence = "daily" | "weekly" | "monthly" | "yearly";

export interface Bucket {
  periodStart: number;
  periodEnd: number;
  label: string;                 // "week of 20 Oct 2026" / "October 2026"
  inCents: number;
  outCents: number;
  feesCents: number;
  loanDrawCents: number;
  loanRepayCents: number;
  byLabel: Array<{ label: string; cents: number }>;
  topCounterparties: Array<{ key: string; cents: number; count: number }>;
  chainBreaks: number;
}

export interface RollupResult {
  buckets: Bucket[];
  mergeCandidates: Array<{ a: string; b: string; reason: string }>;
}

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

function bucketStart(ms: number, cadence: Cadence): number {
  const eat = ms + 3 * 3_600_000;
  switch (cadence) {
    case "daily": return Math.floor(ms / DAY_MS) * DAY_MS;
    case "weekly": return Math.floor(eat / WEEK_MS) * WEEK_MS - 3 * 3_600_000;
    case "monthly": {
      const d = new Date(eat);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3 * 3_600_000;
    }
    case "yearly": {
      const d = new Date(eat);
      return Date.UTC(d.getUTCFullYear(), 0, 1) - 3 * 3_600_000;
    }
  }
}

function periodLabel(startMs: number, cadence: Cadence): string {
  const d = new Date(startMs + 3 * 3_600_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = months[d.getUTCMonth()] ?? "?";
  if (cadence === "daily" || cadence === "weekly") return `${cadence === "daily" ? "" : "week of "}${d.getUTCDate()} ${mo} ${d.getUTCFullYear()}`;
  if (cadence === "monthly") return `${mo === "?" ? d.getUTCMonth() : months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCFullYear()}`;
}

export function rollup(txs: RollupTx[], cadence: Cadence): Bucket[] {
  const map = new Map<number, Bucket>();
  for (const t of txs) {
    const start = bucketStart(t.occurredAt, cadence);
    const b = map.get(start) ?? {
      periodStart: start, periodEnd: start + periodLength(cadence), label: periodLabel(start, cadence),
      inCents: 0, outCents: 0, feesCents: 0, loanDrawCents: 0, loanRepayCents: 0,
      byLabel: [], topCounterparties: [], chainBreaks: 0,
    };
    if (t.direction === "in") b.inCents += t.amount; else b.outCents += t.amount + (t.fee ?? 0);
    b.feesCents += t.fee ?? 0;
    if (t.kind === "loan_draw") b.loanDrawCents += t.amount;
    if (t.kind === "loan_repay") b.loanRepayCents += t.amount;
    if (t.chainStatus === "break") b.chainBreaks++;
    if (t.label) {
      const e = b.byLabel.find((x) => x.label === t.label);
      if (e) e.cents += t.amount; else b.byLabel.push({ label: t.label, cents: t.amount });
    }
    if (t.cpKey) {
      const e2 = b.topCounterparties.find((x) => x.key === t.cpKey);
      if (e2) { e2.cents += t.amount; e2.count++; }
      else b.topCounterparties.push({ key: t.cpKey, cents: t.amount, count: 1 });
    }
    map.set(start, b);
  }
  return [...map.values()].sort((a, b) => b.periodStart - a.periodStart);
}

function periodLength(cadence: Cadence): number {
  return cadence === "daily" ? DAY_MS : cadence === "weekly" ? WEEK_MS : cadence === "monthly" ? 31 * DAY_MS : 366 * DAY_MS;
}

/** Soft-merge candidates: same phone id under different name spellings, or same name slug across providers. */
export function mergeCandidates(txs: RollupTx[]): Array<{ a: string; b: string; reason: string }> {
  const byKey = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  for (const t of txs) {
    const k = counterpartyKey(t.cpId, t.cpName);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, new Set());
    if (t.cpName) byKey.get(k)!.add(t.cpName);
    if (t.cpName) {
      const slug = k.startsWith("n:") ? k.slice(2) : null;
      if (slug) {
        if (!names.has(slug)) names.set(slug, new Set());
        names.get(slug)!.add(t.cpName);
      }
    }
  }
  const out: Array<{ a: string; b: string; reason: string }> = [];
  for (const [k, spellings] of byKey) {
    if (spellings.size > 1) out.push({ a: k, b: [...spellings].slice(1).join(" | "), reason: `same phone/till key ${k} appears as ${spellings.size} spellings` });
  }
  return out.slice(0, 10);
}

export interface RollupTx {
  occurredAt: number;
  direction: "in" | "out" | "neutral";
  amount: Cents;
  fee?: Cents | null;
  kind?: string;
  label?: string | null;
  cpKey?: string | null;
  cpId?: string | null;
  cpName?: string | null;
  chainStatus?: string;
  provider?: string;
}

export function fromParsed(ps: ParsedSms): RollupTx {
  return {
    occurredAt: ps.occurredAt, direction: ps.direction, amount: ps.amount, fee: ps.fee,
    kind: ps.kind, cpId: ps.counterpartyId, cpName: ps.counterpartyName, chainStatus: "unknown", provider: ps.provider,
  };
}
