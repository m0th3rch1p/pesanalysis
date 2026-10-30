import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { getPrimaryMode, listGoalPlans, setPrimaryMode } from "../src/goals/modes.js";
import { bufferDays, modeMeasures, monthTotals, savingsRate } from "../src/goals/measures.js";
import { creditShare } from "../src/insight/credit.js";

test("goal modes persist defaults and measures compute locally", () => {
  const db = fixtureDb(); const a = adapter(db);
  assert.equal(getPrimaryMode(a), "clarity");
  setPrimaryMode(a, "steady", NOW);
  assert.equal(getPrimaryMode(a), "steady");
  assert.deepEqual(listGoalPlans(a, "steady").map((p) => p.kind).sort(), ["buffer", "credit_share"]);
  setPrimaryMode(a, "steady", NOW + 1);
  assert.equal(listGoalPlans(a, "steady").filter((p) => p.kind === "buffer").length, 1);

  db.prepare(`INSERT INTO accounts (provider,kind,name,account_mask,last_balance_cents,last_balance_at,created_at,updated_at)
    VALUES ('mpesa','wallet','M-PESA','2547',500000,?,?,?)`).run(NOW - 3_600_000, NOW - 3_600_000, NOW - 3_600_000);
  const s = modeMeasures(a, "steady", NOW);
  assert.ok(s.some((m) => m.key === "buffer" && m.value >= 0));
  assert.ok(bufferDays(a, NOW) != null);
  assert.ok(creditShare(a, NOW - 40 * 86_400_000, NOW).outflows >= 2);
  assert.ok(modeMeasures(a, "clarity", NOW).some((m) => m.key === "month_net"));
  const t = monthTotals(a, NOW);
  assert.equal(t.netCents, t.inCents - t.outCents);
  assert.ok(savingsRate(a, NOW) != null);
  db.close();
});
