import test from "node:test";
import assert from "node:assert/strict";
import { PLANNER_EVAL_CASES, scorePlannerCase } from "../src/analyst/planner-eval.js";
import type { QueryPlan } from "../src/analyst/plan.js";

test("planner eval: 60 unique hand-written cases cover measures, groups, time and filters", () => {
  assert.equal(PLANNER_EVAL_CASES.length, 60);
  assert.equal(new Set(PLANNER_EVAL_CASES.map((c) => c.q)).size, 60);
  assert.ok(PLANNER_EVAL_CASES.some((c) => c.measure === "income"));
  assert.ok(PLANNER_EVAL_CASES.some((c) => c.measure === "fees"));
  assert.ok(PLANNER_EVAL_CASES.some((c) => c.group?.includes("counterparty")));
  assert.ok(PLANNER_EVAL_CASES.some((c) => c.expect?.labels?.length));
  assert.ok(PLANNER_EVAL_CASES.some((c) => c.expect?.counterparties?.length));
});

test("planner eval: semantic score rejects wrong measure, group, time and missing filter", () => {
  const c = PLANNER_EVAL_CASES.find((x) => x.expect?.labels?.includes("Fuel"))!;
  const base: QueryPlan = {
    version: 1, measure: "spend",
    filters: { time: { kind: "named", name: "last_month" }, labels: ["Fuel"] },
  };
  assert.equal(scorePlannerCase(c, base).ok, true);
  assert.equal(scorePlannerCase(c, { ...base, measure: "net" }).ok, false);
  assert.equal(scorePlannerCase(c, { ...base, groupBy: ["label"] }).ok, false);
  assert.equal(scorePlannerCase(c, { version: 1, measure: "spend" }).ok, false);
  assert.equal(scorePlannerCase(c, { ...base, filters: { time: base.filters!.time, labels: ["Transport"] } }).ok, false);
  assert.equal(scorePlannerCase(c, null).ok, false);
});
