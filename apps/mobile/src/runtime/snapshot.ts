import type { SQLiteDatabase } from "expo-sqlite";
import {
  budgetPace, DAY_MS, dayOf, addDays, diffDays, expectedFee, feeBoundaries, floatSnapshot, listBudgets, listFlows, listOccurrences,
  type AlertSnapshot, type BudgetFact, type FloatResult, type FulizaFact, type IncomeFact, type ObligationFact, type PendingSendFact,
  type SpendFacts, type TariffKind,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { failedAttemptFacts } from "./failed";

/**
 * Everything the alert rules and the float card need, read from the live ledger in one pass.
 * All numbers are integer cents; days are EAT. No ledger content is logged.
 *
 * Not derivable from the ledger today (documented gaps, snapshot leaves the field undefined):
 *  - bundles: the ledger keeps airtime paid/received only (tx_bundles), no remaining/initial/expiry. The rule stays dormant
 *    until a bundle-balance SMS parser exists.
 *  - pendingSend: only meaningful before a send; pass it in via `extras` (see `pendingSendFact`).
 */

export interface SnapshotExtras { pendingSend?: PendingSendFact }

export interface RuntimeSnapshot {
  alert: AlertSnapshot;
  float: FloatResult;
  /** daily outflow (spend+fees) percentiles over the last 60 covered days */
  daily: { p50: number | null; p90: number | null; days: number };
  ms: number;
}

/** Linear-interpolated quantile of a sorted-or-unsorted list. */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(a[lo]! + (a[hi]! - a[lo]!) * (pos - lo));
}

const EAT = 3 * 3_600_000;

export function dailySpend(db: SQLiteDatabase, now: number, days = 60): { p50: number | null; p90: number | null; days: number } {
  const from = now - days * DAY_MS;
  const first = db.getFirstSync<{ t: number | null }>(`SELECT MIN(occurred_at) AS t FROM tx_events`)?.t ?? null;
  if (first == null) return { p50: null, p90: null, days: 0 };
  const rows = db.getAllSync<{ d: number; s: number }>(
    `SELECT (occurred_at + ?) / ? AS d, SUM(amount + COALESCE(fee, 0)) AS s FROM tx_events
      WHERE direction = 'out' AND flow_class IN ('spend','fee') AND occurred_at >= ? AND occurred_at < ? GROUP BY d`,
    [EAT, DAY_MS, from, now],
  );
  // zero-fill covered days (ledger start .. yesterday); today is partial and excluded
  const startDay = Math.floor((Math.max(first, from) + EAT) / DAY_MS);
  const endDay = Math.floor((now + EAT) / DAY_MS) - 1;
  if (endDay < startDay) return { p50: null, p90: null, days: 0 };
  const by = new Map(rows.map((r) => [r.d, r.s]));
  const series: number[] = [];
  for (let d = startDay; d <= endDay; d++) series.push(by.get(d) ?? 0);
  // too little history makes percentiles a guess; the float engine then falls back to its own defaults
  if (series.length < 7) return { p50: null, p90: null, days: series.length };
  return { p50: quantile(series, 0.5), p90: quantile(series, 0.9), days: series.length };
}

function spendFacts(db: SQLiteDatabase, now: number, daily: { p90: number | null }): SpendFacts {
  const since90 = now - 90 * DAY_MS;
  const amounts = db.getAllSync<{ a: number }>(
    `SELECT amount AS a FROM tx_events WHERE direction = 'out' AND flow_class = 'spend' AND occurred_at >= ?`, [since90],
  ).map((r) => r.a);
  const recent = db.getAllSync<{ id: number; a: number; t: number }>(
    `SELECT id, amount AS a, occurred_at AS t FROM tx_events WHERE direction = 'out' AND flow_class = 'spend' AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 20`,
    [now - DAY_MS],
  ).map((r) => ({ txId: r.id, amountCents: r.a, at: r.t }));
  const dayStart = Math.floor((now + EAT) / DAY_MS) * DAY_MS - EAT;
  const today = db.getFirstSync<{ s: number | null }>(
    `SELECT SUM(amount + COALESCE(fee, 0)) AS s FROM tx_events WHERE direction = 'out' AND flow_class IN ('spend','fee') AND occurred_at >= ?`, [dayStart],
  )?.s ?? 0;
  return { recent, todayCents: today, txP95Cents: quantile(amounts, 0.95), dailyP90Cents: daily.p90, sampleN: amounts.length };
}

function feeFacts(db: SQLiteDatabase, now: number) {
  const q = (from: number, to: number) => db.getFirstSync<{ f: number | null; s: number | null }>(
    `SELECT SUM(CASE WHEN flow_class = 'fee' THEN amount ELSE COALESCE(fee, 0) END) AS f,
            SUM(CASE WHEN flow_class = 'spend' THEN amount ELSE 0 END) AS s
       FROM tx_events WHERE direction = 'out' AND flow_class IN ('spend','fee') AND occurred_at >= ? AND occurred_at < ?`, [from, to],
  );
  const cur = q(now - 30 * DAY_MS, now + 1), prior = q(now - 60 * DAY_MS, now - 30 * DAY_MS);
  return { feeCents30d: cur?.f ?? 0, spendCents30d: cur?.s ?? 0, priorFeeCents30d: prior?.f ?? 0 };
}

/**
 * Oldest draw that still makes up the outstanding balance: walk draws newest-first until their sum covers it.
 * Approximation (repayments are not matched to draws) but it only feeds an age threshold in whole days.
 */
export function fulizaOldestDraw(db: SQLiteDatabase, outstandingCents: number): number | null {
  if (!(outstandingCents > 0)) return null;
  const draws = db.getAllSync<{ a: number; t: number }>(
    `SELECT amount AS a, occurred_at AS t FROM transactions WHERE template LIKE '%fuliza_draw%' ORDER BY occurred_at DESC LIMIT 30`,
  );
  let sum = 0, oldest: number | null = null;
  for (const d of draws) { sum += d.a; oldest = d.t; if (sum >= outstandingCents) break; }
  return oldest;
}

/** Tariff cliff for a send about to happen: the nearest lower amount that lands in a cheaper fee band. */
export function pendingSendFact(kind: TariffKind, amountCents: number, now: number, counterpartyKey?: string): PendingSendFact | null {
  const fee = expectedFee(kind, amountCents, now);
  if (fee == null) return null;
  let cheaper: { amount: number; fee: number } | null = null;
  for (const b of feeBoundaries(kind, now)) {
    if (b.boundaryCents >= amountCents) continue;
    const f = expectedFee(kind, b.boundaryCents, now);
    if (f != null && f < fee && (!cheaper || b.boundaryCents > cheaper.amount)) cheaper = { amount: b.boundaryCents, fee: f };
  }
  return { amountCents, feeCents: fee, cheaperAmountCents: cheaper?.amount ?? null, cheaperFeeCents: cheaper?.fee ?? null, counterpartyKey };
}

export function buildSnapshot(db: SQLiteDatabase, now = Date.now(), extras: SnapshotExtras = {}): RuntimeSnapshot {
  const t0 = Date.now();
  const adapter = asDbAdapter(db);
  const daily = dailySpend(db, now);
  const float = floatSnapshot(adapter, now, {
    dailySpendP50Cents: daily.p50 ?? undefined, dailySpendP90Cents: daily.p90 ?? undefined,
  });

  const today = dayOf(now);
  const flows = new Map(listFlows(adapter, { status: ["active", "suggested"] }).map((f) => [f.id, f]));
  const open = listOccurrences(adapter, { states: ["upcoming", "late", "partial"], toDay: addDays(today, 14) });
  const obligations: ObligationFact[] = [];
  const income: IncomeFact[] = [];
  for (const o of open) {
    const f = flows.get(o.flowId);
    if (!f) continue;
    const expected = o.expectedCents ?? f.amountTypCents ?? 0;
    if (f.direction === "out") {
      const remaining = Math.max(0, expected - o.receivedCents);
      if (remaining > 0) obligations.push({ id: o.id, name: f.name, dueOn: o.dueOn, remainingCents: remaining });
    } else if (expected > 0) {
      income.push({ id: o.id, name: f.name, dueOn: o.dueOn, expectedCents: expected, state: o.state });
    }
  }

  const budgets: BudgetFact[] = [];
  for (const b of listBudgets(adapter)) {
    const p = budgetPace(adapter, b.id, now);
    budgets.push({
      id: b.id, name: b.name, limitCents: p.effectiveLimitCents, spentCents: p.spentCents, projectedCents: p.projectedEndCents,
      periodStartDay: p.bounds.startDay, periodEndDay: p.bounds.endDay, elapsedFraction: p.elapsedShare,
    });
  }

  const fz = db.getFirstSync<{ o: number | null }>(`SELECT outstanding_cents AS o FROM accounts WHERE kind = 'credit' AND name LIKE '%uliza%' ORDER BY id LIMIT 1`);
  const outstanding = Number(fz?.o ?? 0);
  let fuliza: FulizaFact | undefined;
  if (fz && outstanding > 0) {
    const nextIn = income.filter((i) => i.state !== "waived" && diffDays(i.dueOn, today) >= 0).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1))[0];
    fuliza = {
      outstandingCents: outstanding, oldestDrawAt: fulizaOldestDraw(db, outstanding),
      sweepAbsorbedCents: float.sweep?.expectedInflowAbsorbedCents ?? 0, nextInflowDueOn: nextIn?.dueOn ?? null,
    };
  }

  const alert: AlertSnapshot = {
    nowMs: now,
    float: {
      balanceCents: float.balanceCents, freeFloatCents: float.freeFloatCents, quality: float.quality,
      daysToZeroExpected: float.daysToZero.expected, daysToZeroPessimistic: float.daysToZero.pessimistic,
    },
    obligations, income, budgets, fuliza,
    pendingSend: extras.pendingSend,
    failedAttempts: failedAttemptFacts(db, now),
    spend: spendFacts(db, now, daily),
    fees: feeFacts(db, now),
  };
  return { alert, float, daily, ms: Date.now() - t0 };
}
