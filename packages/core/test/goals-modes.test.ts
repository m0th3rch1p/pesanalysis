import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { getPrimaryMode, listGoalPlans, setPrimaryMode } from "../src/goals/modes.js";

test("goal modes create their default plans once and never duplicate", () => {
  const db = fixtureDb(); const a = adapter(db);
  const ids = setPrimaryMode(a, "steady", NOW);
  assert.equal(ids.length, 2);
  assert.equal(getPrimaryMode(a), "steady");
  assert.equal(listGoalPlans(a, "steady").length, 2);
  setPrimaryMode(a, "steady", NOW + 1);
  assert.equal(listGoalPlans(a, "steady").length, 2);
  const grow = setPrimaryMode(a, "grow", NOW + 2);
  assert.equal(grow.length, 1);
  assert.equal(getPrimaryMode(a), "grow");
  assert.equal(listGoalPlans(a, "grow")[0]!.kind, "save_target");
  db.close();
});

test("goal mode names are validated", () => {
  const db = fixtureDb(); const a = adapter(db);
  assert.throws(() => setPrimaryMode(a, "rich" as never, NOW));
  db.close();
});
