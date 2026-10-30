import { test } from "node:test";
import assert from "node:assert/strict";
import { interpret, learnLexicon } from "../src/labels/interpret.js";

test("interpret: learned vocabulary handles a dog named Rex", () => {
  const r = interpret("dog food for rex", { direction: "out" }, { rex: "Pets" });
  assert.equal(r.category, "Pets");
  assert.equal(r.detail, "dog food for rex");
  assert.equal(r.source, "lexicon");
  assert.ok(r.confidence > 0.9);
});

test("interpret: detail keeps the item, drops the price", () => {
  const r = interpret("cigarettes 30", { direction: "out" });
  assert.equal(r.category, "Groceries");
  assert.equal(r.detail, "cigarettes");
});

test("interpret: user vocabulary beats generic words (recreation fun)", () => {
  const r = interpret("recreation fun", {}, { fun: "Entertainment" });
  assert.equal(r.category, "Entertainment");
  assert.equal(r.detail, "recreation fun");
});

test("interpret: Kenyan merchant vocabulary", () => {
  assert.equal(interpret("supermarket eggs", {}).category, "Groceries");
  assert.equal(interpret("fries", {}).category, "Eating out");
  assert.equal(interpret("airtime airtel", {}).category, "Airtime & data");
  assert.equal(interpret("google one", {}).category, "Subscriptions");
  assert.equal(interpret("maintenance bike", {}).category, "Transport");
});

test("interpret: income and direction", () => {
  assert.equal(interpret("payout hackathon", { direction: "in" }).category, "Other income");
  assert.equal(interpret("friend alex", { direction: "out" }).category, "Personal transfer");
  assert.equal(interpret("friend alex", { direction: "in" }).category, "Transfer in");
  assert.equal(interpret("transfer to equity bank", { direction: "in" }).category, "Transfer in");
});

test("interpret: repayments are definitive even when the words say airtime", () => {
  const r = interpret("okoa repayment", { kind: "loan_repay", template: "telco.okoa_repay" });
  assert.equal(r.category, "Debt repayment");
});

test("interpret: context fills empty descriptions", () => {
  assert.equal(interpret("", { kind: "withdraw" }).category, "Cash withdrawal");
  assert.equal(interpret("", { kind: "fee" }).category, "Fees & charges");
  assert.equal(interpret("", { kind: "receive" }).category, "Transfer in");
  assert.equal(interpret("", { kind: "loan_draw", template: "mpesa.fuliza_draw" }).category, null);
});

test("interpret: abstains on unknown text", () => {
  const r = interpret("xyzzy", { direction: "out" });
  assert.equal(r.category, null);
  assert.equal(r.confidence, 0);
});

test("interpret: ambiguity is exposed", () => {
  const r = interpret("food", { direction: "out" });
  assert.equal(r.category, "Eating out");
  assert.ok(r.alternates.some((a) => a.category === "Groceries"));
});

test("learnLexicon: learns names, refuses generic category words", () => {
  const l = learnLexicon("food rex", "Pets");
  assert.equal(l.rex, "Pets");
  assert.equal(l.food, undefined);
  const l2 = learnLexicon("recreation fun", "Entertainment");
  assert.equal(l2.fun, "Entertainment");
  const l3 = learnLexicon("rex", "NotACategory");
  assert.deepEqual(l3, {});
});
