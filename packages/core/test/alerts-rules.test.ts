import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_RULES, DEFAULT_ALERT_CONFIG, evaluateAlertRules, fmtKes, type AlertSnapshot } from "../src/alerts/index.js";
import { at } from "./fixtures.js";

const NOW = at(2026, 10, 26, 12);
const run = (s: Partial<AlertSnapshot>, id?: string) => {
  const { candidates, errors } = evaluateAlertRules({ nowMs: NOW, ...s });
  assert.deepEqual(errors, []);
  return id ? candidates.filter((c) => c.ruleId === id) : candidates;
};
const floatF = (o: Partial<NonNullable<AlertSnapshot["float"]>> = {}) => ({ balanceCents: 500_000, freeFloatCents: 500_000, daysToZeroExpected: null, daysToZeroPessimistic: null, quality: "ok" as const, ...o });

test("registry: unique ids, every rule returns nothing on an empty snapshot", () => {
  const ids = ALERT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["low_float", "days_to_zero", "obligation_due_soon", "obligation_overdue", "income_late", "budget_pace", "fuliza_outstanding", "fuliza_sweep", "tariff_cliff", "repeated_failed", "bundle_depletion", "unusual_spend", "fee_drag"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(run({}), []);
});

test("fmtKes", () => {
  assert.equal(fmtKes(123_456), "KES 1,234.56");
  assert.equal(fmtKes(500_000), "KES 5,000");
  assert.equal(fmtKes(-100), "-KES 1");
});

test("every candidate: stable shape, redacted body has no digits or names", () => {
  const all = run({
    float: floatF({ freeFloatCents: -5_000, daysToZeroExpected: 1 }),
    obligations: [{ id: 1, name: "Landlord Wanjiku", dueOn: "2026-10-27", remainingCents: 1_500_000 }, { id: 2, name: "Loan Otieno", dueOn: "2026-10-20", remainingCents: 250_000 }],
    income: [{ id: 3, name: "Salary Acme", dueOn: "2026-10-25", expectedCents: 5_000_000, state: "late" }],
    budgets: [{ id: 4, name: "Food", limitCents: 1_000_000, spentCents: 850_000, projectedCents: 1_200_000, periodStartDay: "2026-10-01", periodEndDay: "2026-11-01", elapsedFraction: 0.8 }],
    fuliza: { outstandingCents: 300_000, oldestDrawAt: NOW - 8 * 86_400_000, sweepAbsorbedCents: 300_000, nextInflowDueOn: "2026-10-27" },
    pendingSend: { amountCents: 100_100, feeCents: 1_300, cheaperAmountCents: 100_000, cheaperFeeCents: 0, counterpartyKey: "n:Mama Mboga" },
    failedAttempts: [{ kind: "PIN", atMs: [NOW - 60_000, NOW - 120_000, NOW - 180_000] }],
    bundles: [{ id: 5, kind: "data", label: "Safaricom data", remaining: 50, initial: 1000, expiresAt: NOW + 3_600_000 }],
    spend: { recent: [{ txId: 9, amountCents: 900_000, at: NOW - 1000 }], todayCents: 1_500_000, txP95Cents: 100_000, dailyP90Cents: 300_000, sampleN: 100 },
    fees: { feeCents30d: 80_000, spendCents30d: 1_000_000 },
  });
  const ruleIds = new Set(all.map((c) => c.ruleId));
  for (const r of ALERT_RULES) assert.ok(ruleIds.has(r.id), `rule ${r.id} fired in the kitchen-sink snapshot`);
  for (const c of all) {
    assert.ok(c.id && c.dedupeKey && c.title && c.body, c.ruleId);
    assert.ok(c.cooldownMs > 0 && c.expiresAt > NOW, c.ruleId);
    assert.match(c.action.url, /^yako:\/\//);
    assert.ok(c.what && c.when && c.stake && c.evidenceUrl, `missing evidence fields: ${c.ruleId}`);
    assert.ok((c.actions ?? []).length > 0 && c.evidenceUrl === c.action.url, c.ruleId);
    assert.doesNotMatch(c.redactedBody, /\d|KES|Wanjiku|Otieno|Acme|Mboga/i, `redacted body leaks: ${c.redactedBody}`);
  }
  // determinism
  assert.deepEqual(run({ float: floatF({ freeFloatCents: -5_000 }) }), run({ float: floatF({ freeFloatCents: -5_000 }) }));
});

test("low_float: ok / low / negative / unknown quality", () => {
  assert.deepEqual(run({ float: floatF() }, "low_float"), []);
  const low = run({ float: floatF({ freeFloatCents: 10_000 }) }, "low_float");
  assert.equal(low[0]?.severity, "normal");
  const neg = run({ float: floatF({ freeFloatCents: -1 }) }, "low_float");
  assert.equal(neg[0]?.severity, "high");
  assert.notEqual(low[0]?.dedupeKey, neg[0]?.dedupeKey);
  assert.deepEqual(run({ float: floatF({ freeFloatCents: -1, quality: "unknown" }) }, "low_float"), []);
  assert.deepEqual(run({ float: floatF({ freeFloatCents: null }) }, "low_float"), []);
  assert.equal(run({ float: floatF({ freeFloatCents: DEFAULT_ALERT_CONFIG.lowFloatCents }) }, "low_float").length, 0);
  assert.equal(run({ float: floatF({ freeFloatCents: 30_000 }), config: { lowFloatCents: 40_000 } }, "low_float").length, 1);
});

test("days_to_zero: expected beats pessimistic; far or null does nothing", () => {
  assert.equal(run({ float: floatF({ daysToZeroExpected: 2 }) }, "days_to_zero")[0]?.severity, "high");
  assert.equal(run({ float: floatF({ daysToZeroPessimistic: 3 }) }, "days_to_zero")[0]?.severity, "normal");
  assert.match(run({ float: floatF({ daysToZeroExpected: 0 }) }, "days_to_zero")[0]!.body, /today/);
  assert.equal(run({ float: floatF({ daysToZeroExpected: 10, daysToZeroPessimistic: 5 }) }, "days_to_zero").length, 0);
  assert.equal(run({ float: floatF({ daysToZeroExpected: 1, quality: "unknown" }) }, "days_to_zero").length, 0);
});

test("obligations: due-soon window, today is high, overdue escalates at 3 days, paid items ignored", () => {
  const o = (id: number, dueOn: string, rem = 100_000) => ({ id, name: `Bill ${id}`, dueOn, remainingCents: rem });
  const due = run({ obligations: [o(1, "2026-10-26"), o(2, "2026-10-28"), o(3, "2026-10-29"), o(4, "2026-10-30"), o(5, "2026-10-27", 0)] }, "obligation_due_soon");
  assert.deepEqual(due.map((c) => [c.id, c.severity]), [["obl:1", "high"], ["obl:2", "normal"], ["obl:3", "normal"]]);
  const over = run({ obligations: [o(1, "2026-10-25"), o(2, "2026-10-23"), o(3, "2026-10-26")] }, "obligation_overdue");
  assert.deepEqual(over.map((c) => [c.id, c.severity]), [["obl:1", "normal"], ["obl:2", "high"]]);
  assert.equal(over[0]!.dedupeKey, "obl_over:1:2026-10-25");
});

test("income_late: late normal, missed high, matched/upcoming silent", () => {
  const i = (id: number, state: any) => ({ id, name: "Pay", dueOn: "2026-10-24", expectedCents: 1, state });
  const r = run({ income: [i(1, "late"), i(2, "missed"), i(3, "matched"), i(4, "upcoming"), i(5, "waived"), i(6, "partial")] }, "income_late");
  assert.deepEqual(r.map((c) => [c.id, c.severity]), [["income:1", "normal"], ["income:2", "high"]]);
});

test("budget_pace: highest crossed level only, once per period key, projected breach, boundaries", () => {
  const b = (spent: number, over: any = {}) => ({ id: 1, name: "Food", limitCents: 1_000_000, spentCents: spent, projectedCents: null, periodStartDay: "2026-10-01", periodEndDay: "2026-11-01", elapsedFraction: 0.5, ...over });
  const r = (spent: number, over?: any) => run({ budgets: [b(spent, over)] }, "budget_pace");
  assert.equal(r(499_999).length, 0);
  assert.deepEqual([r(500_000)[0]?.dedupeKey, r(500_000)[0]?.severity], ["budget:1:2026-10-01:50", "low"]);
  assert.equal(r(799_999)[0]?.dedupeKey, "budget:1:2026-10-01:50");
  assert.deepEqual([r(800_000)[0]?.dedupeKey, r(800_000)[0]?.severity], ["budget:1:2026-10-01:80", "normal"]);
  assert.deepEqual([r(1_000_000)[0]?.dedupeKey, r(1_000_000)[0]?.severity], ["budget:1:2026-10-01:100", "high"]);
  assert.equal(r(5_000_000).length, 1);
  assert.equal(r(1_000_000, { periodStartDay: "2026-11-01", periodEndDay: "2026-12-01" })[0]?.dedupeKey, "budget:1:2026-11-01:100");
  // projected
  assert.equal(r(300_000, { projectedCents: 1_200_000 })[0]?.dedupeKey, "budget:1:2026-10-01:proj");
  assert.equal(r(300_000, { projectedCents: 1_200_000, elapsedFraction: 0.1 }).length, 0);
  assert.equal(r(300_000, { projectedCents: 900_000 }).length, 0);
  assert.equal(run({ budgets: [b(1, { limitCents: 0 })] }, "budget_pace").length, 0);
});

test("fuliza: age ladder and sweep warning", () => {
  const f = (ageDays: number | null, over: any = {}) => ({ outstandingCents: 100_000, oldestDrawAt: ageDays == null ? null : NOW - ageDays * 86_400_000 - 1000, sweepAbsorbedCents: 100_000, nextInflowDueOn: "2026-10-28", ...over });
  const sev = (d: number) => run({ fuliza: f(d) }, "fuliza_outstanding")[0]?.severity;
  assert.equal(sev(1), undefined); assert.equal(sev(2), "low"); assert.equal(sev(4), "normal"); assert.equal(sev(6), "normal"); assert.equal(sev(7), "high");
  assert.equal(run({ fuliza: f(null) }, "fuliza_outstanding").length, 0);
  assert.equal(run({ fuliza: f(5, { outstandingCents: 0 }) }).length, 0);
  assert.equal(run({ fuliza: f(1) }, "fuliza_sweep").length, 1);
  assert.equal(run({ fuliza: f(1, { nextInflowDueOn: "2026-11-30" }) }, "fuliza_sweep").length, 0);
  assert.equal(run({ fuliza: f(1, { sweepAbsorbedCents: 0 }) }, "fuliza_sweep").length, 0);
  assert.equal(run({ fuliza: f(1, { nextInflowDueOn: null }) }, "fuliza_sweep").length, 0);
});

test("tariff_cliff: needs a real saving and a small give-up", () => {
  const p = (o: any = {}) => ({ amountCents: 100_100, feeCents: 1_300, cheaperAmountCents: 100_000, cheaperFeeCents: 0, ...o });
  assert.equal(run({ pendingSend: p() }, "tariff_cliff").length, 1);
  assert.equal(run({ pendingSend: p({ cheaperFeeCents: 1_000 }) }, "tariff_cliff").length, 0); // saves 300 < 1000
  assert.equal(run({ pendingSend: p({ cheaperAmountCents: 50_000 }) }, "tariff_cliff").length, 0); // gives up too much
  assert.equal(run({ pendingSend: p({ cheaperAmountCents: null }) }, "tariff_cliff").length, 0);
  assert.equal(run({ pendingSend: p({ cheaperAmountCents: 100_100 }) }, "tariff_cliff").length, 0);
  const c = run({ pendingSend: p() }, "tariff_cliff")[0]!;
  assert.equal(c.expiresAt - NOW, 600_000);
});

test("repeated_failed: safety severity, window boundary, per-key grouping", () => {
  const m = 60_000;
  const r = (atMs: number[], kind = "PIN", cp?: string) => run({ failedAttempts: [{ kind, counterpartyKey: cp, atMs }] }, "repeated_failed");
  assert.equal(r([NOW - m, NOW - 2 * m]).length, 0);
  assert.equal(r([NOW - m, NOW - 2 * m, NOW - 3 * m])[0]?.severity, "safety");
  assert.equal(r([NOW - 31 * m, NOW - m, NOW - 2 * m]).length, 0); // one outside the 30-min window
  assert.equal(r([NOW - 29 * m, NOW - m, NOW - 2 * m]).length, 1);
  assert.notEqual(r([NOW - m, NOW - 2 * m, NOW - 3 * m], "PIN", "a")[0]!.id, r([NOW - m, NOW - 2 * m, NOW - 3 * m], "PIN", "b")[0]!.id);
  assert.equal(r([NOW + m, NOW + 2 * m, NOW + 3 * m]).length, 0); // future timestamps ignored
});

test("bundle_depletion: thresholds and expiry", () => {
  const b = (remaining: number, expiresAt: number | null = null) => run({ bundles: [{ id: 1, kind: "data", label: "Data", remaining, initial: 1000, expiresAt }] }, "bundle_depletion")[0];
  assert.equal(b(500), undefined);
  assert.equal(b(200)?.severity, "low");
  assert.equal(b(100)?.severity, "normal");
  assert.equal(b(0)?.severity, "normal");
  assert.equal(b(500, NOW + 3_600_000)?.severity, "low");
  assert.equal(b(500, NOW - 1000), undefined);
  assert.equal(run({ bundles: [{ id: 1, kind: "data", label: "x", remaining: 0, initial: 0, expiresAt: null }] }, "bundle_depletion").length, 0);
});

test("unusual_spend: needs sample, minimum size, multiple of p95", () => {
  const sp = (o: any = {}) => ({ recent: [{ txId: 1, amountCents: 300_000, at: NOW }], todayCents: 0, txP95Cents: 100_000, dailyP90Cents: 300_000, sampleN: 50, ...o });
  assert.equal(run({ spend: sp() }, "unusual_spend").length, 1);
  assert.equal(run({ spend: sp({ sampleN: 19 }) }, "unusual_spend").length, 0);
  assert.equal(run({ spend: sp({ recent: [{ txId: 1, amountCents: 200_000, at: NOW }] }) }, "unusual_spend").length, 0); // = 2x, not above
  assert.equal(run({ spend: sp({ txP95Cents: 1_000, recent: [{ txId: 1, amountCents: 40_000, at: NOW }] }) }, "unusual_spend").length, 0); // under absolute minimum
  const day = run({ spend: sp({ recent: [], todayCents: 500_000 }) }, "unusual_spend");
  assert.deepEqual(day.map((c) => [c.id, c.severity]), [["unusual_day", "low"]]);
  assert.equal(run({ spend: sp({ recent: [], todayCents: 450_000 }) }, "unusual_spend").length, 0);
});

test("fee_drag: share and absolute floor", () => {
  const f = (fee: number, spend: number) => run({ fees: { feeCents30d: fee, spendCents30d: spend } }, "fee_drag");
  assert.equal(f(30_000, 970_000).length, 1);
  assert.equal(f(29_999, 100_000).length, 0); // below absolute floor
  assert.equal(f(30_000, 10_000_000).length, 0); // share too small
  assert.equal(f(0, 0).length, 0);
  assert.equal(f(30_000, 970_000)[0]!.dedupeKey, "fee_drag:2026-10");
});

test("a throwing rule is isolated", () => {
  const bad = { id: "boom", description: "", defaultSeverity: "low" as const, evaluate: () => { throw new Error("x"); } };
  const r = evaluateAlertRules({ nowMs: NOW, float: floatF({ freeFloatCents: -1 }) }, [bad, ...ALERT_RULES]);
  assert.equal(r.errors[0]?.ruleId, "boom");
  assert.ok(r.candidates.length > 0);
});
