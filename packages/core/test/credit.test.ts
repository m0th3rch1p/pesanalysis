import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at } from "./fixtures.js";
import { creditShare, fulizaCost } from "../src/insight/credit.js";

test("credit share uses event_ref links, not labels or amounts", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = (db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number }).id;
  const ins = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role,event_ref,ref)
    VALUES ('mpesa',?,?,?,?,?,'x','1','confirmed',?,?,?)`);
  ins.run("till", "out", 5_000, cp, at(2026, 10, 1), "transaction", "F1", "TX1");
  ins.run("till", "out", 5_000, cp, at(2026, 10, 2), "transaction", null, "TX2");
  db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,occurred_at,template,parser_version,status,role,ref)
    VALUES ('mpesa','loan_draw','in',5000,?,'mpesa.fuliza_draw','1','confirmed','funding_notice','F1')`).run(at(2026, 10, 1) - 1000);
  const s = creditShare(a, at(2026, 10, 1) - 86_400_000, at(2026, 11, 1));
  assert.equal(s.creditOutflows, 1);
  assert.equal(s.creditCents, 5_000);
  assert.equal(s.shareCount, 1 / s.outflows);
  const cost = fulizaCost(a, at(2026, 9, 1), at(2026, 10, 5));
  assert.equal(cost.draws, 1);
  assert.ok(cost.totalFeesCents >= 0);
  db.close();
});
