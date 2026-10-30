import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { compilePlan, describePlan, QUERY_PLAN_JSON_SCHEMA, resolveRange, validatePlan, type QueryPlan } from "../src/analyst/plan.js";
import { MEASURES, DIMENSIONS } from "../src/analyst/semantic.js";
import { adapter, at, fixtureDb as fixture, NOW } from "./fixtures.js";

function run(db: DatabaseSync, plan: QueryPlan): Array<{ k0: string; v: number }> {
  const v = validatePlan(plan);
  assert.ok(v.ok, JSON.stringify(v));
  const q = compilePlan(v.plan, NOW);
  return (adapter(db).all(q.sql, q.params) as Array<{ k0: string; v: number }>).map((r) => ({ ...r }));
}

test("validatePlan rejects unknown keys, bad enums, limits and time", () => {
  assert.equal(validatePlan({ version: 1, measure: "spend", bogus: 1 }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "steal" }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "spend", limit: 1000 }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "spend", groupBy: [] }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "spend", filters: { time: { kind: "absolute", fromMs: 5, toMs: 1 } } }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "spend", filters: { direction: "sideways" } }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "spend", filters: { minAmountCents: 10, maxAmountCents: 5 } }).ok, false);
  assert.equal(validatePlan({ version: 1, measure: "count", groupBy: ["label"], filters: { time: { kind: "named", name: "this_month" } } }).ok, true);
});

test("JSON schema is closed and uses the same vocabularies", () => {
  const s = QUERY_PLAN_JSON_SCHEMA as any;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.measure.enum, [...MEASURES]);
  assert.deepEqual(s.properties.groupBy.items.enum, [...DIMENSIONS]);
  assert.equal(s.properties.filters.properties.time.additionalProperties, false);
  assert.equal(s.properties.filters.additionalProperties, false);
});

test("spend by label for this month, ordered by value", () => {
  const db = fixture();
  const rows = run(db, { version: 1, measure: "spend", groupBy: ["label"], filters: { time: { kind: "named", name: "this_month" } } });
  assert.deepEqual(rows, [
    { k0: "Groceries", v: 300_000 },
    { k0: "Utilities", v: 50_000 },
  ]);
  db.close();
});

test("income, fees, count and net are computed from the right directions", () => {
  const db = fixture();
  const income = run(db, { version: 1, measure: "income", filters: { time: { kind: "named", name: "this_month" } } });
  assert.equal(income[0]!.v, 1_000_000);
  const fees = run(db, { version: 1, measure: "fees", filters: { time: { kind: "named", name: "this_month" } } });
  assert.equal(fees[0]!.v, 1_500);
  const count = run(db, { version: 1, measure: "count", filters: { time: { kind: "named", name: "this_month" } } });
  assert.equal(count[0]!.v, 4);
  const net = run(db, { version: 1, measure: "net", filters: { time: { kind: "named", name: "this_month" } } });
  assert.equal(net[0]!.v, 1_000_000 - 350_000);
  db.close();
});

test("comparison range is the previous month", () => {
  const db = fixture();
  const v = validatePlan({
    version: 1, measure: "spend", filters: { time: { kind: "named", name: "this_month" } },
    compare: { to: { kind: "named", name: "last_month" } },
  });
  assert.ok(v.ok);
  const q = compilePlan(v.plan, NOW);
  assert.ok(q.comparison);
  const rows = (adapter(db).all(q.comparison!.sql, q.comparison!.params) as Array<{ k0: string; v: number }>).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ k0: "total", v: 300_000 }]);
  assert.match(q.explain, /previous period|last month/);
  db.close();
});

test("tag/venture filtering and grouping", () => {
  const db = fixture();
  const tagged = run(db, { version: 1, measure: "spend", filters: { time: { kind: "named", name: "this_month" }, ventures: ["Mama mboga"] } });
  assert.equal(tagged[0]!.v, 300_000);
  const byTag = run(db, { version: 1, measure: "spend", groupBy: ["venture"], filters: { time: { kind: "named", name: "this_month" } } });
  assert.ok(byTag.some((r) => r.k0 === "Mama mboga" && r.v === 300_000));
  db.close();
});

test("text filter searches notes and counterparties", () => {
  const db = fixture();
  const note = run(db, { version: 1, measure: "count", filters: { time: { kind: "named", name: "this_month" }, text: "tomatoes" } });
  assert.equal(note[0]!.v, 1);
  const cp = run(db, { version: 1, measure: "count", filters: { time: { kind: "named", name: "this_month" }, text: "NAIVAS" } });
  assert.equal(cp[0]!.v, 2);
  db.close();
});

test("relative windows and EAT week boundaries", () => {
  const week = resolveRange({ kind: "named", name: "this_week" }, NOW);
  assert.equal(new Date(week.from).toISOString(), "2026-10-25T21:00:00.000Z"); // Mon 26 Oct 00:00 EAT
  assert.equal(new Date(week.to).toISOString(), "2026-10-26T09:00:00.000Z");
  const last7 = resolveRange({ kind: "relative", unit: "day", n: 7 }, NOW);
  assert.equal(new Date(last7.from).toISOString(), "2026-10-19T21:00:00.000Z");
  const shifted = resolveRange({ kind: "relative", unit: "day", n: 7, offset: 1 }, NOW);
  assert.equal(shifted.to, last7.from);
  assert.match(describePlan({ version: 1, measure: "spend", filters: { time: { kind: "named", name: "this_week" } } }, week), /this week/);
});
