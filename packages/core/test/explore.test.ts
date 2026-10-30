import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { exploreSummary, exploreTransactions, exploreCategories, explorePlaces, wrapped } from "../src/analytics/explore.js";

test("explore summary and filters read only tx_events", () => {
  const db = fixtureDb(); const a = adapter(db);
  const s = exploreSummary(a, { period: "this_month" }, NOW);
  assert.equal(s.incomeCents, 1_000_000);
  assert.equal(s.spendCents, 350_000);
  assert.equal(s.feeCents, 1_500);
  assert.equal(s.count, 4);
  const food = exploreTransactions(a, { period: "this_month", label: "Groceries" }, 10, NOW);
  assert.equal(food.length, 2);
  assert.ok(food.every((t) => t.label === "Groceries"));
  const searched = exploreTransactions(a, { period: "this_month", search: "tomatoes" }, 10, NOW);
  assert.equal(searched.length, 1);
  const cats = exploreCategories(a, { period: "this_month" }, 5, NOW);
  assert.equal(cats[0]!.name, "Groceries");
  assert.equal(cats[0]!.totalCents, 300_000);
  db.close();
});

test("explore places cluster coarse fixes and wrapped highlights are deterministic", () => {
  const db = fixtureDb(); const a = adapter(db);
  const tx = a.all(`SELECT id FROM transactions ORDER BY id LIMIT 2`) as Array<{ id: number }>;
  a.run(`INSERT INTO tx_context (tx_id, lat, lng, accuracy_m, source, captured_at) VALUES (?, -1.2861, 36.8172, 40, 'synthetic', ?)`, [tx[0]!.id, NOW]);
  a.run(`INSERT INTO tx_context (tx_id, lat, lng, accuracy_m, source, captured_at) VALUES (?, -1.2862, 36.8173, 60, 'synthetic', ?)`, [tx[1]!.id, NOW]);
  const places = explorePlaces(a, { period: "this_month" }, NOW);
  assert.equal(places.length, 1);
  assert.equal(places[0]!.count, 2);
  const w = wrapped(a, { period: "this_month" }, NOW);
  assert.equal(w.summary.spendCents, 350_000);
  assert.equal(w.biggestSpend?.amount, 200_000);
  assert.equal(w.biggestIncome?.amount, 1_000_000);
  assert.equal(w.topCategory?.name, "Groceries");
  assert.ok(w.highlights.length >= 5);
  assert.equal(w.places.count, 1);
  assert.equal(w.places.locatedTx, 2);
  assert.equal(w.places.locatedShare, 0.5);
  assert.equal(w.places.topByCount?.count, 2);
  assert.ok(w.highlights.some((h) => h.label === "Most visited place"));
  assert.ok(w.highlights.some((h) => h.label === "Payments with a place"));
  db.close();
});

test("wrapped omits place highlights when no location was captured", () => {
  const db = fixtureDb(); const a = adapter(db);
  const w = wrapped(a, { period: "this_month" }, NOW);
  assert.equal(w.places.count, 0);
  assert.equal(w.places.locatedTx, 0);
  assert.equal(w.highlights.some((h) => h.label === "Most visited place"), false);
  db.close();
});
