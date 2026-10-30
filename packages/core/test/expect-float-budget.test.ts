import test from "node:test";
import assert from "node:assert/strict";
import { computeFloat, projectDaysToZero, type FloatInput } from "../src/expect/float.js";
import { BUDGET_THRESHOLDS, budgetReserve, pace, periodBounds, previousPeriod, rolloverCarry, spentIn, type BudgetRule } from "../src/expect/budget.js";
import { dipsIntoPots, goalProgress, availableOutsidePots } from "../src/expect/savings.js";
import { obligationFromNotice, parseDueDate } from "../src/expect/auto-obligations.js";
import { weekdayWeightsFromHistory } from "../src/expect/store.js";
import { at } from "./fixtures.js";

const NOW = at(2026, 10, 29, 12);
const base = (o: Partial<FloatInput> = {}): FloatInput => ({
  nowMs: NOW, balanceCents: 1_000_000, balanceAsOf: NOW - 3_600_000, potsCents: 200_000,
  obligations: [
    { name: "overdue", dueOn: "2026-10-27", cents: 100_000 },
    { name: "soon", dueOn: "2026-11-01", cents: 300_000 },
    { name: "later", dueOn: "2026-11-20", cents: 500_000 },
  ],
  expectedIncome: [], budgetReserveCents: 50_000, horizonDays: 7, ...o,
});

test("free float = balance - pots - obligations in horizon (overdue included) - budget reserve", () => {
  const r = computeFloat(base());
  assert.equal(r.obligationsDueCents, 400_000);
  assert.equal(r.overdueCents, 100_000);
  assert.equal(r.freeFloatCents, 1_000_000 - 200_000 - 400_000 - 50_000);
  assert.equal(r.quality, "ok");
  assert.equal(r.inputs.obligations, 3);
  // extending the horizon pulls the later obligation in
  assert.equal(computeFloat(base({ horizonDays: 30 })).obligationsDueCents, 900_000);
  // free float may be negative: shortfall is information
  assert.equal(computeFloat(base({ balanceCents: 100_000 })).freeFloatCents, 100_000 - 200_000 - 400_000 - 50_000);
});

test("safe-to-spend is an ordered range; income weighted by reliability; buffers from p50/p90", () => {
  const r = computeFloat(base({
    dailySpendP50Cents: 20_000, dailySpendP90Cents: 50_000,
    expectedIncome: [{ dueOn: "2026-10-29", cents: 400_000, reliability: 0.5 }, { dueOn: "2026-11-05", cents: 999_999, reliability: 1 }],
  }));
  assert.deepEqual(r.safeToSpend, { lowCents: 300_000, midCents: 500_000, highCents: 730_000, confidence: "medium" });
  const none = computeFloat(base({ dailySpendP90Cents: 50_000, dailySpendP50Cents: 20_000 }));
  assert.equal(none.safeToSpend!.lowCents, none.safeToSpend!.midCents);
  assert.equal(none.safeToSpend!.confidence, "high");
  // never negative, always ordered
  for (const bal of [0, 10_000, 600_000, 5_000_000]) {
    const s = computeFloat(base({ balanceCents: bal, dailySpendP90Cents: 80_000, expectedIncome: [{ dueOn: "2026-10-28", cents: 70_000, reliability: 0.3 }] })).safeToSpend!;
    assert.ok(s.lowCents >= 0 && s.lowCents <= s.midCents && s.midCents <= s.highCents);
  }
});

test("Fuliza sweep reduces expected income and raises a warning", () => {
  const inc = [{ dueOn: "2026-10-29", cents: 400_000, reliability: 0.5 }];
  const r = computeFloat(base({ dailySpendP50Cents: 20_000, dailySpendP90Cents: 50_000, expectedIncome: inc, fulizaOutstandingCents: 150_000 }));
  assert.deepEqual(r.safeToSpend, { lowCents: 300_000, midCents: 350_000, highCents: 580_000, confidence: "medium" });
  assert.equal(r.sweep!.severity, "warn");
  assert.equal(r.sweep!.expectedInflowAbsorbedCents, 150_000);
  assert.equal(computeFloat(base({ fulizaOutstandingCents: 150_000 })).sweep!.severity, "info");
  assert.equal(computeFloat(base({ fulizaOutstandingCents: 10_000, expectedIncome: [{ dueOn: "2026-10-30", cents: 5_000 }] })).sweep!.expectedInflowAbsorbedCents, 5_000);
  assert.equal(computeFloat(base()).sweep, null);
});

test("stale or missing balance degrades the output instead of lying", () => {
  const stale = computeFloat(base({ balanceAsOf: NOW - 72 * 3_600_000 }));
  assert.equal(stale.quality, "estimate"); assert.equal(stale.safeToSpend!.confidence, "low"); assert.ok(stale.balanceAgeHours! > 71);
  const unk = computeFloat(base({ balanceCents: null, balanceAsOf: null }));
  assert.equal(unk.quality, "unknown"); assert.equal(unk.freeFloatCents, null); assert.equal(unk.safeToSpend, null);
  assert.equal(unk.obligationsDueCents, 400_000);
  assert.equal(computeFloat(base({ balanceAsOf: NOW - 72 * 3_600_000, staleAfterHours: 100 })).quality, "ok");
});

test("days to zero: burn, obligations, weighted income, Fuliza sweep, bounds", () => {
  const z = (o: { bal?: number; obl?: Array<[string, number]>; inc?: Array<[string, number, number]>; burn?: number; fz?: number; w?: boolean; days?: number }) =>
    projectDaysToZero(o.bal ?? 100_000, "2026-10-29",
      (o.obl ?? []).map(([d, c]) => ({ dueOn: d, cents: c })),
      (o.inc ?? []).map(([d, c, r]) => ({ dueOn: d, cents: c, reliability: r })),
      o.burn ?? 30_000, o.fz ?? 0, o.days ?? 60, o.w ?? true);
  assert.equal(z({}), 4);
  assert.equal(z({ burn: 40_000 }), 3);
  assert.equal(z({ obl: [["2026-10-31", 50_000]] }), 2);
  assert.equal(z({ obl: [["2026-10-31", 50_000]], inc: [["2026-10-30", 200_000, 0.5]] }), 5);
  assert.equal(z({ obl: [["2026-10-31", 50_000]], inc: [["2026-10-30", 200_000, 0.5]], fz: 60_000 }), 3);
  assert.equal(z({ obl: [["2026-10-20", 150_000]] }), 0, "overdue lands on day 0");
  assert.equal(z({ bal: 0 }), 0);
  assert.equal(z({ burn: 0 }), null);
  assert.equal(z({ days: 2 }), null);
  const r = computeFloat(base({ dailySpendP50Cents: 30_000, dailySpendP90Cents: 40_000, potsCents: 0, obligations: [], expectedIncome: [{ dueOn: "2026-10-30", cents: 5_000_000, reliability: 0.9 }], balanceCents: 100_000 }));
  assert.equal(r.daysToZero.pessimistic, 3);
  assert.equal(r.daysToZero.expected, null);
  assert.ok(r.daysToZero.expected === null || r.daysToZero.pessimistic! <= r.daysToZero.expected);
});

test("budget periods: monthly boundaries are EAT midnights", () => {
  const m: BudgetRule = { period: "monthly", limitCents: 1 };
  assert.equal(periodBounds(m, Date.UTC(2026, 8, 30, 21, 0)).startDay, "2026-10-01");
  assert.equal(periodBounds(m, Date.UTC(2026, 8, 30, 20, 59, 59, 999)).startDay, "2026-09-01");
  const oct = periodBounds(m, NOW);
  assert.deepEqual([oct.startDay, oct.endDay, oct.days], ["2026-10-01", "2026-11-01", 31]);
  assert.equal(oct.startMs, Date.UTC(2026, 8, 30, 21, 0));
  assert.equal(periodBounds(m, at(2028, 2, 10)).days, 29);
  assert.equal(periodBounds(m, at(2027, 2, 10)).days, 28);
  assert.equal(periodBounds(m, at(2026, 12, 31, 23)).endDay, "2027-01-01");
});

test("payday-anchored, clamped, weekly and custom periods", () => {
  const p28: BudgetRule = { period: "monthly", anchor: 28, limitCents: 1 };
  const a = periodBounds(p28, at(2026, 10, 27)); assert.deepEqual([a.startDay, a.endDay], ["2026-09-28", "2026-10-28"]);
  const b = periodBounds(p28, at(2026, 10, 28, 0)); assert.deepEqual([b.startDay, b.endDay], ["2026-10-28", "2026-11-28"]);
  const p31: BudgetRule = { period: "monthly", anchor: 31, limitCents: 1 };
  const c = periodBounds(p31, at(2027, 3, 1)); assert.deepEqual([c.startDay, c.endDay], ["2027-02-28", "2027-03-31"]);
  const d = periodBounds(p31, at(2028, 3, 1)); assert.deepEqual([d.startDay, d.endDay], ["2028-02-29", "2028-03-31"]);
  const e = periodBounds(p31, at(2026, 12, 31, 1)); assert.deepEqual([e.startDay, e.endDay], ["2026-12-31", "2027-01-31"]);
  const w = periodBounds({ period: "weekly", limitCents: 1 }, NOW); assert.deepEqual([w.startDay, w.endDay], ["2026-10-26", "2026-11-02"]);
  const ws = periodBounds({ period: "weekly", anchor: 0, limitCents: 1 }, NOW); assert.deepEqual([ws.startDay, ws.endDay], ["2026-10-25", "2026-11-01"]);
  const cu: BudgetRule = { period: "custom", periodDays: 10, anchorOn: "2026-10-01", limitCents: 1 };
  const f = periodBounds(cu, NOW); assert.deepEqual([f.startDay, f.endDay], ["2026-10-21", "2026-10-31"]);
  const g = periodBounds(cu, at(2026, 9, 25)); assert.deepEqual([g.startDay, g.endDay], ["2026-09-21", "2026-10-01"]);
  assert.throws(() => periodBounds({ period: "custom", limitCents: 1 }, NOW));
  // periods tile with no gaps/overlaps
  for (const rule of [p28, p31, cu, { period: "weekly" as const, limitCents: 1 }]) {
    let t = at(2026, 1, 1);
    for (let i = 0; i < 60; i++) { const cur = periodBounds(rule, t); const nxt = periodBounds(rule, cur.endMs); assert.equal(nxt.startMs, cur.endMs); assert.ok(previousPeriod(rule, nxt.startMs).endMs === cur.endMs); t = cur.endMs; }
  }
});

test("pace: on track, at risk, over, thresholds, breach day", () => {
  const rule: BudgetRule = { period: "monthly", limitCents: 3_000_000 };
  const now = at(2026, 10, 16, 12); // exactly halfway (15.5 of 31 days)
  const ev = (cents: number) => [{ occurredAt: at(2026, 10, 10), amountCents: cents }];
  const ok = pace(rule, ev(1_000_000), now);
  assert.equal(ok.projectedEndCents, 2_000_000); assert.equal(ok.status, "ok"); assert.equal(ok.projectedOverspendCents, 0); assert.deepEqual(ok.thresholdsCrossed, []);
  const risk = pace(rule, ev(2_000_000), now);
  assert.equal(risk.projectedEndCents, 4_000_000); assert.equal(risk.status, "at_risk"); assert.equal(risk.projectedOverspendCents, 1_000_000);
  assert.ok(risk.projectedBreachOn! > "2026-10-16" && risk.projectedBreachOn! <= "2026-10-31");
  assert.deepEqual(risk.thresholdsCrossed, [50]);
  const over = pace(rule, ev(3_100_000), now);
  assert.equal(over.status, "over"); assert.equal(over.remainingCents, 0); assert.deepEqual(over.thresholdsCrossed, [...BUDGET_THRESHOLDS]);
  assert.equal(pace(rule, ev(2_400_000), now).thresholdsCrossed.join(), "50,80");
  // spend outside the period or after now is ignored
  const out = pace(rule, [{ occurredAt: at(2026, 9, 30, 23), amountCents: 999 }, { occurredAt: at(2026, 11, 2), amountCents: 999 }], now);
  assert.equal(out.spentCents, 0);
  assert.equal(spentIn([{ occurredAt: 10, amountCents: 5 }], 10, 11), 5);
  assert.equal(spentIn([{ occurredAt: 11, amountCents: 5 }], 10, 11), 0);
});

test("pace early in the period leans on the prior, not on a tiny sample", () => {
  const rule: BudgetRule = { period: "monthly", limitCents: 3_100_000 };
  const now = at(2026, 10, 1, 12);
  const p = pace(rule, [{ occurredAt: at(2026, 10, 1, 9), amountCents: 1_000_000 }], now); // one big purchase on day 1
  assert.ok(p.projectedEndCents < 1_000_000 * 31, "not extrapolated linearly");
  const q = pace(rule, [], now);
  assert.ok(q.projectedEndCents > 0 && q.projectedEndCents <= 3_100_000);
  assert.equal(q.status, "ok");
  assert.ok(Math.abs(q.elapsedShare - 0.5 / 31) < 1e-9);
  assert.equal(pace(rule, [], at(2026, 10, 1, 0)).projectedEndCents, 3_100_000);
});

test("pace honours weekday weights and rejects invalid weights", () => {
  const rule: BudgetRule = { period: "weekly", limitCents: 700_000 }; // Mon..Sun, 2026-10-26..
  const now = at(2026, 10, 28, 23) + 59 * 60_000; // end of Wednesday
  const ev = [{ occurredAt: at(2026, 10, 26), amountCents: 300_000 }];
  const uniform = pace(rule, ev, now);
  const weekendHeavy = pace(rule, ev, now, { weekdayWeights: [3, 1, 1, 1, 1, 1, 3] });
  assert.ok(weekendHeavy.projectedEndCents > uniform.projectedEndCents);
  assert.ok(weekendHeavy.elapsedShare < uniform.elapsedShare);
  assert.equal(pace(rule, ev, now, { weekdayWeights: [0, 0, 0, 0, 0, 0, 0] }).projectedEndCents, uniform.projectedEndCents);
  assert.equal(pace(rule, ev, now, { weekdayWeights: [1, 1] }).projectedEndCents, uniform.projectedEndCents);
  assert.equal(weekdayWeightsFromHistory([]), null);
  const w = weekdayWeightsFromHistory(Array.from({ length: 40 }, (_, i) => ({ occurredAt: at(2026, 9, 1 + (i % 28)), amountCents: 1000 })))!;
  assert.equal(w.length, 7); assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 7) < 1e-9);
});

test("rollover carries unused budget forward, never negative, chains, and is off by default", () => {
  const rule: BudgetRule = { period: "monthly", limitCents: 1_000_000, rollover: true };
  const sp = (m: number, cents: number) => ({ occurredAt: at(2026, m, 10), amountCents: cents });
  assert.equal(rolloverCarry(rule, [sp(9, 600_000)], NOW), 400_000);
  assert.equal(rolloverCarry(rule, [sp(8, 200_000), sp(9, 500_000)], NOW), 1_300_000); // Aug carry 800k, Sep carry 1.0M+0.8M-0.5M
  assert.equal(rolloverCarry(rule, [sp(9, 1_500_000)], NOW), 0);
  assert.equal(rolloverCarry({ ...rule, rollover: false }, [sp(9, 100)], NOW), 0);
  const p = pace(rule, [{ occurredAt: at(2026, 10, 5), amountCents: 1_200_000 }], NOW, { carryCents: 400_000 });
  assert.equal(p.effectiveLimitCents, 1_400_000); assert.equal(p.status === "over", false); assert.equal(p.remainingCents, 200_000);
});

test("budget reserve prorates remaining allowance over the horizon", () => {
  const rule: BudgetRule = { period: "monthly", limitCents: 3_100_000 };
  const p = pace(rule, [], at(2026, 10, 21, 12));
  const left = 11; // Oct 21..31 -> end 2026-11-01
  assert.equal(budgetReserve([p], at(2026, 10, 21, 12), 7), Math.round(p.remainingCents * (7 / left)));
  assert.equal(budgetReserve([p], at(2026, 10, 21, 12), 30), p.remainingCents);
  assert.equal(budgetReserve([], NOW, 7), 0);
});

test("savings maths and pot guards", () => {
  const g = goalProgress({ targetCents: 1_000_000, savedCents: 250_000, targetOn: "2027-01-27" }, at(2026, 10, 29), 100_000);
  assert.equal(g.pct, 25); assert.equal(g.remainingCents, 750_000); assert.equal(g.projectedCompletionOn, "2027-06-11"); assert.equal(g.behindPace, true);
  assert.ok(g.requiredMonthlyCents! > 100_000);
  assert.equal(goalProgress({ targetCents: 100, savedCents: 100 }, NOW, null).achieved, true);
  assert.equal(goalProgress({ targetCents: 100, savedCents: 10 }, NOW, null).projectedCompletionOn, null);
  assert.equal(dipsIntoPots(500_000, 300_000, 250_000), true);
  assert.equal(dipsIntoPots(500_000, 300_000, 200_000), false);
  assert.equal(dipsIntoPots(500_000, 0, 500_000), false);
  assert.equal(availableOutsidePots(500_000, 300_000), 200_000);
});

test("lender due-date notices become suggested obligations with a stable dedupe key", () => {
  assert.equal(parseDueDate("25/11/26"), "2026-11-25");
  assert.equal(parseDueDate("5-1-2027"), "2027-01-05");
  assert.equal(parseDueDate("2026-10-24"), "2026-10-24");
  assert.equal(parseDueDate("31/02/26"), null);
  assert.equal(parseDueDate("garbage"), null);
  const f = obligationFromNotice({ kind: "fuliza", dueAt: at(2026, 11, 25, 12), outstandingCents: 123_400 })!;
  assert.deepEqual([f.direction, f.cadence, f.anchorOn, f.status, f.source, f.sourceRef, f.counterpartyHint, f.graceDays], ["out", "once", "2026-11-25", "suggested", "sms", "fuliza::2026-11-25", "fuliza", 0]);
  assert.equal(f.amountMinCents, 123_400);
  assert.equal(obligationFromNotice({ kind: "okoa", dueOn: "2026-10-30", outstandingCents: 5_000 })!.counterpartyHint, "okoa");
  assert.equal(obligationFromNotice({ kind: "lender", lender: "Acme Credit", dueOn: "2026-10-30", outstandingCents: 5_000 })!.sourceRef, "lender:acme credit:2026-10-30");
  assert.equal(obligationFromNotice({ kind: "fuliza", dueOn: "2026-10-30", outstandingCents: 0 }), null);
  assert.equal(obligationFromNotice({ kind: "fuliza", outstandingCents: 10 }), null);
});
