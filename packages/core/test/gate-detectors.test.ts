import test from "node:test";
import assert from "node:assert/strict";
import { detectTimeOfDay } from "../src/detectors/time-of-day.js";
import { gateFindings, benjaminiHochberg } from "../src/detectors/gate.js";
import type { LedgerTx } from "../src/detectors/types.js";

const at = (day: number, hour: number) => Date.UTC(2026, 6, 1 + day, hour) - 3 * 3_600_000;
function tx(i: number, hour: number, label = "Groceries"): LedgerTx {
  return { id: String(i), occurredAt: at(i, hour), direction: "out", amount: 10_000, counterpartyKey: "n:shop", label };
}

test("BH is monotone and controls the largest q", () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03]).map((q) => Math.round(q * 1000) / 1000), [0.03, 0.04, 0.04]);
  assert.deepEqual(benjaminiHochberg([]), []);
});

test("time-of-day: a late-night label is found; daytime-only and uniform data produce none", () => {
  const base: LedgerTx[] = [];
  for (let d = 0; d < 90; d++) for (let h = 8; h < 20; h += 2) base.push(tx(base.length, h, "Groceries"));
  const late = Array.from({ length: 28 }, (_, i) => tx(base.length + i, 23, "Late food"));
  const found = detectTimeOfDay([...base, ...late], { minN: 15 });
  assert.ok(found.some((f) => f.id.includes("label:Late food") && f.evidence.window instanceof Array));

  const daytimeOnly = detectTimeOfDay(base, { minN: 15 });
  assert.equal(daytimeOnly.length, 0);

  const uniform: LedgerTx[] = [];
  for (let d = 0; d < 120; d++) uniform.push(tx(d, d % 24, "Misc"));
  const gated = gateFindings(detectTimeOfDay(uniform, { minN: 15 }));
  assert.equal(gated.filter((f) => f.gate === "shown").length, 0);
});

test("gate: high p and below-floor effects are never shown", () => {
  const g = gateFindings([
    { detector: "time_of_day", id: "x", title: "x", n: 100, pValue: 0.4, evidence: { share: 0.3, baseline: 0.1, count: 30 } },
    { detector: "bocpd_regime", id: "y", title: "y", n: 100, pValue: 0.001, evidence: { beforeMeanCents: 10_000, afterMeanCents: 10_500, beforeN: 50, afterN: 50 }, effect: { abs: 500, rel: 0.05, unit: "cents" } },
    { detector: "fee_drag", id: "z", title: "z", n: 5, evidence: {} },
  ]);
  assert.equal(g.find((f) => f.id === "x")?.gate, "not_significant");
  assert.equal(g.find((f) => f.id === "y")?.gate, "below_effect");
  assert.equal(g.find((f) => f.id === "z")?.gate, "shown");
});

test("gate: planted time-of-day is shown; p-values are stripped from copy", () => {
  const base: LedgerTx[] = [];
  for (let d = 0; d < 90; d++) for (let h = 8; h < 20; h++) base.push(tx(base.length, h, "Groceries"));
  const late = Array.from({ length: 40 }, (_, i) => tx(base.length + i, 23, "Late food"));
  const gated = gateFindings(detectTimeOfDay([...base, ...late]));
  const shown = gated.find((f) => f.gate === "shown" && f.detector === "time_of_day");
  assert.ok(shown);
  assert.ok(!/P\s*=/.test(shown.title));
});
