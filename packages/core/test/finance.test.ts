import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW, at } from "./fixtures.js";
import { financeReport, financeWindows, flowTotals, monthlyFlow, wrappedAccess } from "../src/index.js";

test("finance windows compare this month like-for-like", () => {
  const w = financeWindows("this_month", NOW);
  assert.equal(w.current.from, at(2026, 10, 1, 0));
  assert.equal(w.prior!.from, at(2026, 9, 1, 0));
  assert.ok(w.prior!.to < at(2026, 10, 1, 0));
  assert.equal(w.basis, "mtd");
  const full = financeWindows("this_month", NOW, "full");
  assert.equal(full.prior!.to, at(2026, 10, 1, 0));
  assert.equal(full.mode, "full");
  const ly = financeWindows("this_year", NOW);
  assert.equal(ly.current.from, at(2026, 1, 1, 0));
  assert.equal(ly.prior!.from, at(2025, 1, 1, 0));
  assert.equal(ly.basis, "ytd");
});

test("finance report computes horizontal, vertical and unit metrics", () => {
  const db = fixtureDb(); const a = adapter(db);
  const r = financeReport(a, { period: "this_month" }, NOW);
  assert.equal(r.current.incomeCents, 1_000_000);
  assert.equal(r.current.spendCents, 350_000);
  assert.equal(r.current.feeCents, 1_500);
  assert.equal(r.current.netCents, 648_500);
  assert.equal(r.current.outCount, 3);
  assert.equal(r.current.avgOutCents, Math.round(350_000 / 3));
  assert.equal(r.current.savingsRate, 0.6485);
  assert.equal(r.prior!.spendCents, 300_000);
  assert.equal(r.prior!.feeCents, 2_000);
  assert.ok(Math.abs(r.deltas.find((d) => d.id === "spend")!.pct! - (350_000 / 300_000 - 1)) < 1e-12);
  assert.equal(r.categories[0]!.name, "Groceries");
  assert.ok(r.categories[0]!.share > 0.85 && r.categories[0]!.share < 0.86);
  assert.equal(r.merchants[0]!.name, "NAIVAS");
  assert.equal(r.feeBands[1]!.count, 1);
  assert.equal(r.risk.incomeHhi, 1);
  assert.equal(r.risk.topIncomeShare, 1);
  assert.equal(r.ventures[0]!.name, "Mama mboga");
  assert.equal(r.ventures[0]!.expenseCents, 300_000);
  assert.ok(r.headline.length > 10);
  assert.ok(r.kpis.length >= 5);
  db.close();
});

test("wrapped gates on one calendar month and twelve", () => {
  const db = fixtureDb(); const a = adapter(db);
  assert.equal(wrappedAccess(a, "month", NOW).unlocked, true);
  assert.equal(wrappedAccess(a, "year", NOW).unlocked, false);
  a.run(`INSERT INTO transactions (provider, kind, direction, amount, occurred_at, template, parser_version, status)
         VALUES ('mpesa','receive','in',1,?,'test','1','confirmed')`, [at(2025, 8, 1)]);
  assert.equal(wrappedAccess(a, "year", NOW).unlocked, true);
  a.run(`DELETE FROM transactions`);
  a.run(`INSERT INTO transactions (provider, kind, direction, amount, occurred_at, template, parser_version, status)
         VALUES ('mpesa','receive','in',1,?,'test','1','confirmed')`, [at(2026, 10, 1)]);
  const locked = wrappedAccess(a, "month", NOW);
  assert.equal(locked.unlocked, false);
  assert.equal(locked.reason, "too_early");
  db.close();
});

test("flow totals and monthly series handle empty ranges", () => {
  const db = fixtureDb(); const a = adapter(db);
  const empty = flowTotals(a, at(2026, 3, 1), at(2026, 4, 1), { period: "all" });
  assert.equal(empty.count, 0);
  assert.equal(empty.savingsRate, null);
  const months = monthlyFlow(a, "this_month", NOW, 6);
  assert.equal(months.length, 6);
  assert.equal(months.at(-1)!.month, "2026-10");
  const groceries = monthlyFlow(a, "this_month", NOW, 6, { period: "this_month", label: "Groceries" });
  assert.equal(groceries.at(-1)!.spendCents, 300_000);
  db.close();
});
