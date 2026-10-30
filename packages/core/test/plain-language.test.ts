import test from "node:test";
import assert from "node:assert/strict";
import { plainDetector, plainLabel, plainTerms } from "../src/narration/plain.js";

test("plain language preserves numbers and removes internal jargon", () => {
  assert.equal(plainTerms("Branching Ratio R=0.42, KES 1,000"), "chain-reaction share R=0.42, KES 1,000");
  assert.equal(plainTerms("Off-radar transfer"), "money moved outside SMS view");
  assert.equal(plainDetector("hawkes_cascade"), "spending chains");
  assert.equal(plainLabel("Off-radar transfer"), "Money outside SMS");
});
