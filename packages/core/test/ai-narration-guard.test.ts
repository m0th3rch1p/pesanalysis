import test from "node:test";
import assert from "node:assert/strict";
import { amountIssue, checkNarration, currencyAmounts, inventsTime, looksComplete, missingNumbers, numbers, rolePairs } from "../src/ai/narration-guard.js";

// Cases mirror the checks proven in the former apps/mobile/src/narrate.ts (git 1b17468^).
test("numbers: 3-7 digit runs, separators joined, msisdn-length runs ignored", () => {
  assert.deepEqual(numbers("Spent 2,705 and 2.705 and 2 705 and 27 and 12345678 on 26/10/26"), ["2705", "2705", "2705"]);
});

test("missingNumbers: every amount in the finding must survive", () => {
  assert.deepEqual(missingNumbers("Fees took 1,500 of 20,000", "Fees took 1500 of your money"), ["20000"]);
  assert.deepEqual(missingNumbers("Fees took 1,500", "Fees took Ksh1.500."), []);
});

test("inventsTime: duration words not in the finding are rejected", () => {
  assert.equal(inventsTime("You paid 5 times", "You paid 5 times over 3 days"), true);
  assert.equal(inventsTime("You paid 5 times this month", "You paid 5 times this month"), false);
  assert.equal(inventsTime("A count of 5", "That is 5 weeks"), true);
});

test("currency amounts and role pairs", () => {
  assert.deepEqual(currencyAmounts("Ksh 1,250 and KES27"), ["1250", "27"]);
  assert.deepEqual([...rolePairs("You borrowed Ksh 500 and repaid KES 300")].sort(), ["borrowed:500", "repaid:300"]);
});

test("amountIssue: small amounts (KES 27) are protected", () => {
  assert.match(amountIssue("You paid KES 27 in fees", "You paid KES 42 in fees")!, /missing 27/);
  assert.match(amountIssue("You paid KES 27", "You paid KES 27 and KES 42")!, /invented 42/);
  assert.equal(amountIssue("You paid KES 27 in fees", "You paid KES 27 in fees."), null);
  // original behaviour kept: the role word must survive too, a paraphrase without it falls back to the template
  assert.equal(amountIssue("You paid KES 27 in fees", "Fees came to Ksh 27."), "amount role check failed");
  assert.equal(amountIssue("Fees were KES 0", "There were no fees."), null); // zero may be rephrased
});

test("amountIssue: role swaps are caught (borrowed 27, repaid 42)", () => {
  const title = "You borrowed KES 27 and repaid KES 42";
  assert.equal(amountIssue(title, "You borrowed KES 27 and repaid KES 42."), null);
  assert.equal(amountIssue(title, "You repaid KES 27 and borrowed KES 42."), "amount role check failed");
  assert.equal(amountIssue(title, "You repaid KES 27 and KES 42."), "amount role check failed");
});

test("looksComplete", () => {
  for (const t of ["Done.", "Really?", "Wow!", "Ok…", 'He said "go."', "(yes.)"]) assert.equal(looksComplete(t), true, t);
  for (const t of ["You spent Ksh", "and then", "ends with comma,"]) assert.equal(looksComplete(t), false, t);
});

test("checkNarration: accepts a faithful rewrite", () => {
  const v = checkNarration("You borrowed KES 2705 and repaid KES 900 this month", "This month you borrowed KES 2705 and repaid KES 900.");
  assert.deepEqual(v, { accepted: true, reasons: [] });
});

test("checkNarration: each failure mode, in the original order", () => {
  const title = "You borrowed KES 2705 and repaid KES 900 this month";
  assert.deepEqual(checkNarration(title, "").reasons, ["empty model output"]);
  assert.deepEqual(checkNarration(title, "   ").reasons, ["empty model output"]);
  assert.deepEqual(checkNarration(title, "You borrowed KES 2705 and").reasons, ["model output incomplete"]);
  assert.match(checkNarration(title, "You borrowed some money and repaid some.").reasons[0]!, /number check failed: missing 2705, 900/);
  assert.match(checkNarration(title, "You borrowed KES 2705 and repaid KES 900 and KES 1200.").reasons[0]!, /invented 1200/);
  assert.equal(checkNarration(title, "You repaid KES 2705 and borrowed KES 900.").reasons[0], "amount role check failed");
  assert.equal(checkNarration("You paid KES 2705 in fees", "You paid KES 2705 in fees over 3 weeks.").reasons[0], "time-word check failed");
  assert.equal(checkNarration("You paid KES 2705 in fees", "You paid KES 2705 in fees over 3 weeks.").accepted, false);
});

test("checkNarration: non-string model output never throws", () => {
  assert.equal(checkNarration("x 1000", undefined as never).accepted, false);
  assert.equal(checkNarration("x 1000", null as never).accepted, false);
});
