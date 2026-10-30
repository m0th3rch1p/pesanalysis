import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/migrate.js";
import { adapter, at } from "./fixtures.js";
import { adherenceVerdict, planAdherence } from "../src/expect/adherence.js";
import { createFlow, listOccurrences, refreshOccurrences } from "../src/expect/store.js";

const NOW = at(2026, 10, 29, 12);

function mk() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const a = adapter(db);
  migrate(a);
  return { db, a };
}

test("plan adherence separates on-time, late/partial and missed outcomes", () => {
  const { db, a } = mk();
  const fid = createFlow(a, { direction: "out", name: "Rent", cadence: "monthly", dayOfMonth: 1, amountTypCents: 3_000_000, graceDays: 1, missedAfterDays: 5 }, 1);
  refreshOccurrences(a, NOW);
  const occ = listOccurrences(a, { flowId: fid });
  const pick = (day: string) => occ.find((o) => o.dueOn === day)!;
  a.run(`UPDATE expected_occurrences SET state='matched', delay_days=0, received_cents=3000000, expected_cents=3000000 WHERE id=?`, [pick("2026-08-01").id]);
  a.run(`UPDATE expected_occurrences SET state='matched', delay_days=2, received_cents=3000000, expected_cents=3000000 WHERE id=?`, [pick("2026-09-01").id]);
  a.run(`UPDATE expected_occurrences SET state='missed', delay_days=NULL, received_cents=0, expected_cents=3000000 WHERE id=?`, [pick("2026-10-01").id]);
  const r = planAdherence(a, { fromDay: "2026-08-01", toDay: "2026-10-31", now: NOW });
  assert.equal(r.planned, 3);
  assert.equal(r.arrived, 2);
  assert.equal(r.onTime, 1);
  assert.equal(r.withinGrace, 1);
  assert.equal(r.missed, 1);
  assert.equal(r.valueRatio, 2 / 3);
  assert.equal(r.weightedRate, 1 / 3);
  assert.equal(adherenceVerdict(r.weightedRate), "drifted");
  assert.equal(r.flows[0]!.name, "Rent");
  db.close();
});

test("an empty plan reports no rate rather than zero", () => {
  const { db, a } = mk();
  const r = planAdherence(a, { fromDay: "2026-08-01", toDay: "2026-10-31", now: NOW });
  assert.equal(r.planned, 0);
  assert.equal(r.weightedRate, null);
  assert.equal(adherenceVerdict(r.weightedRate), "no_plan");
  db.close();
});
