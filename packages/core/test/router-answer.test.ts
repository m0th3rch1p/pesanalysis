import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestionTime, routeQuestion } from "../src/analyst/router.js";
import { composeAnswer, composeSummary, type PlanRow } from "../src/analyst/answer.js";
import { resolveRange } from "../src/analyst/plan.js";

const NOW = Date.UTC(2026, 9, 26, 9, 0);
const CP = ["Naivas", "KPLC", "Shell", "Mama Mboga"];

test("router: spend this month", () => {
  const r = routeQuestion("How much did I spend this month?", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "spend");
  assert.deepEqual(r.plan!.filters!.time, { kind: "named", name: "this_month" });
  assert.deepEqual(r.plan!.filters!.direction, "out");
});

test("router: category and last month", () => {
  const r = routeQuestion("What did I spend on food last month?", NOW, { labels: ["Eating out", "Groceries"] });
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "spend");
  assert.ok(r.plan!.filters!.labels!.includes("Eating out"));
  assert.deepEqual(r.plan!.filters!.time, { kind: "named", name: "last_month" });
});

test("router: top merchants defaults to spend and sets group/limit", () => {
  const r = routeQuestion("Top 5 merchants this month", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "spend");
  assert.deepEqual(r.plan!.groupBy, ["counterparty"]);
  assert.equal(r.plan!.limit, 5);
});

test("router: income from a known counterparty", () => {
  const r = routeQuestion("How much did I receive from Naivas this month?", NOW, { counterparties: CP });
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "income");
  assert.deepEqual(r.plan!.filters!.counterparties, ["Naivas"]);
  assert.equal(r.plan!.filters!.direction, "in");
});

test("router: fees over a relative window", () => {
  const r = routeQuestion("fees last 30 days", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "fees");
  assert.deepEqual(r.plan!.filters!.time, { kind: "relative", unit: "day", n: 30 });
});

test("router: count yesterday", () => {
  const r = routeQuestion("How many payments did I make yesterday?", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.measure, "count");
  assert.deepEqual(r.plan!.filters!.time, { kind: "named", name: "yesterday" });
});

test("router: tagged venture", () => {
  const r = routeQuestion("How much did I spend tagged Mama mboga this month?", NOW, { tags: ["Mama mboga"] });
  assert.ok(r.ok);
  assert.deepEqual(r.plan!.filters!.tags, ["Mama mboga"]);
});

test("router: free text becomes a note/counterparty filter", () => {
  const r = routeQuestion("How much did I spend on kale this month?", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.filters!.text, "kale");
});

test("router: where did my money go groups by category", () => {
  const r = routeQuestion("Where did my money go this month?", NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.plan!.groupBy, ["label"]);
});

test("router: venture profit is net by venture", () => {
  const r = routeQuestion("Are my ventures making a profit?", NOW);
  assert.ok(r.ok, JSON.stringify(r.needs));
  assert.equal(r.plan!.measure, "net");
  assert.deepEqual(r.plan!.groupBy, ["venture"]);
});

test("router: follow-up time parser", () => {
  assert.deepEqual(parseQuestionTime("and last month?", NOW), { kind: "named", name: "last_month" });
  assert.deepEqual(parseQuestionTime("what about the last 7 days", NOW), { kind: "relative", unit: "day", n: 7 });
});

test("router: amount filter", () => {
  const r = routeQuestion("spending over 1,000 this month", NOW);
  assert.ok(r.ok);
  assert.equal(r.plan!.filters!.minAmountCents, 100_000);
});

test("router: summary intent asks net with comparison", () => {
  const r = routeQuestion("How am I doing this month?", NOW);
  assert.ok(r.ok);
  assert.equal(r.summary, true);
  assert.equal(r.plan!.measure, "net");
  assert.ok(r.plan!.compare);
});

test("router: unknown intent asks a clarifying question", () => {
  const r = routeQuestion("hmm", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.needs?.options?.length);
});

test("answer: grouped totals, shares and comparison", () => {
  const range = resolveRange({ kind: "named", name: "this_month" }, NOW);
  const rows: PlanRow[] = [{ k0: "Groceries", v: 300_000 }, { k0: "Utilities", v: 50_000 }];
  const prev: PlanRow[] = [{ k0: "total", v: 400_000 }];
  const a = composeAnswer({ version: 1, measure: "spend", groupBy: ["label"] }, rows, prev, range);
  assert.match(a.headline, /Ksh3,500/);
  assert.match(a.headline, /2 groups/);
  assert.ok(a.bullets.some((b) => b.includes("Groceries")));
  assert.ok(a.detail.some((d) => d.includes("% less")));
  assert.equal(a.numbersVerified, true);
});

test("answer: empty is honest", () => {
  const range = resolveRange({ kind: "named", name: "today" }, NOW);
  const a = composeAnswer({ version: 1, measure: "spend" }, [], null, range);
  assert.equal(a.empty, true);
  assert.match(a.headline, /found nothing/);
});

test("answer: summary prose uses computed numbers", () => {
  const range = resolveRange({ kind: "named", name: "this_month" }, NOW);
  const a = composeSummary({
    range, spend: 350_000, income: 1_000_000, fees: 1_500, count: 4, previousSpend: 300_000,
    top: [{ k0: "Groceries", v: 300_000 }],
  });
  assert.match(a.headline, /in Ksh10,000/);
  assert.match(a.headline, /out Ksh3,500/);
  assert.match(a.detail[0]!, /higher/);
});
