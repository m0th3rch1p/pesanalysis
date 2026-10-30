import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { askQuestion, executePlan } from "../src/analyst/ask.js";
import { addTxItem, ensureItem } from "../src/items/store.js";

test("ask: spend this month end-to-end", () => {
  const db = fixtureDb();
  const r = askQuestion("How much did I spend this month?", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.match(r.answer!.headline, /Ksh3,500/);
  assert.equal(r.answer!.numbersVerified, true);
  assert.ok(r.sql!.includes("tx_events"));
  db.close();
});

test("ask: top merchants returns real counterparties", () => {
  const db = fixtureDb();
  const r = askQuestion("Top merchants this month", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.rows!.map((x) => [x.k0, x.v]), [["NAIVAS", 300_000], ["KPLC", 50_000]]);
  assert.match(r.answer!.headline, /Ksh3,500/);
  db.close();
});

test("ask: summary combines spend, income, fees and count", () => {
  const db = fixtureDb();
  const r = askQuestion("How am I doing this month?", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.match(r.answer!.headline, /in Ksh10,000/);
  assert.match(r.answer!.headline, /out Ksh3,500/);
  assert.match(r.answer!.headline, /net Ksh6,500/);
  assert.ok(r.answer!.detail.some((d) => d.includes("Ksh15")));
  db.close();
});

test("ask: fees last month", () => {
  const db = fixtureDb();
  const r = askQuestion("fees last month", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.match(r.answer!.headline, /Ksh20/);
  db.close();
});

test("ask: empty period is honest, not invented", () => {
  const db = fixtureDb();
  const r = askQuestion("What did I spend today?", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.equal(r.answer!.empty, true);
  assert.match(r.answer!.headline, /found nothing/);
  db.close();
});

test("executePlan rejects invalid plans before building SQL", () => {
  const db = fixtureDb();
  assert.throws(() => executePlan(adapter(db), { version: 1, measure: "steal" } as never, NOW), /invalid plan/);
  db.close();
});

test("ask returns a clarifying question instead of guessing", () => {
  const db = fixtureDb();
  const r = askQuestion("do the thing", { db: adapter(db), now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.needs?.options?.length);
  db.close();
});

test("ask: free text searches notes", () => {
  const db = fixtureDb();
  const r = askQuestion("How much did I spend on kale this month?", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.match(r.answer!.headline, /Ksh2,000/);
  assert.equal(r.rows![0]!.k0, "total");
  db.close();
});

test("ask: summary headline is capitalised and flags unlabelled spend", () => {
  const db = fixtureDb();
  const r = askQuestion("How am I doing this month?", { db: adapter(db), now: NOW });
  assert.ok(r.ok);
  assert.match(r.answer!.headline, /^This month/);
  db.close();
});

test("ask: Swahili item question compiles to an item filter", () => {
  const db = fixtureDb(); const a = adapter(db);
  const item = ensureItem(a, "cigarette", {});
  addTxItem(a, 1, { itemId: item, amountCents: 30_000, source: "gold", confirmed: true }, NOW);
  const r = askQuestion("nimetumia pesa ngapi kwa sigara mwezi huu", { db: a, now: NOW });
  assert.ok(r.ok, r.error);
  assert.equal(r.plan!.measure, "spend");
  assert.deepEqual(r.plan!.filters?.items, ["cigarette"]);
  assert.equal(r.plan!.filters?.time?.kind, "named");
  assert.equal(r.rows?.[0]?.v, 30_000);
  db.close();
});

test("ask: Fuliza cost, late-night and weekday filters are first-class", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cost = askQuestion("what did Fuliza cost me this month", { db: a, now: NOW });
  assert.ok(cost.ok, cost.error);
  assert.equal(cost.plan!.measure, "credit_cost");
  assert.ok(!cost.plan!.filters?.labels?.includes("Debt repayment"));
  const late = askQuestion("how much did I spend late night this month", { db: a, now: NOW });
  assert.ok(late.ok, late.error);
  assert.deepEqual(late.plan!.filters?.hourWindow, { startMin: 1320, endMin: 300 });
  const friday = askQuestion("how much did I spend on Friday this month", { db: a, now: NOW });
  assert.ok(friday.ok, friday.error);
  assert.deepEqual(friday.plan!.filters?.weekdays, [5]);
  db.close();
});

test("ask: evidence count and rows match the answer's measure scope", () => {
  const db = fixtureDb();
  const r = askQuestion("How much did I spend this month?", { db: adapter(db), now: NOW });
  assert.ok(r.ok, r.error);
  assert.ok((r.matches ?? 0) > 0);
  assert.equal(r.evidence!.length, r.matches);
  const sum = r.evidence!.reduce((n, x) => n + (x.direction === "out" ? x.amount : 0), 0);
  assert.equal(sum, 350_000);
  db.close();
});
