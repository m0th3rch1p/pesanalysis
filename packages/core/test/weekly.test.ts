import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { createHabit } from "../src/habits/suggest.js";
import { weeklyReview } from "../src/weekly/review.js";

const DAY = 86_400_000;

test("weekly review reads habits, gated findings, episodes and credit share", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const groceries = a.get(`SELECT id FROM labels WHERE name = 'Groceries'`) as { id: number };
  const cp = a.get(`SELECT id FROM counterparties WHERE display_name = 'NAIVAS'`) as { id: number };
  const tx = (when: number) => Number(db.prepare(`INSERT INTO transactions
    (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,chain_status,status,role,event_ref,ref)
    VALUES ('mpesa','till','out',12000,?,?,'mpesa.till','1','ok','confirmed','transaction',?,?)`)
    .run(cp.id, when, `W${when}`, `W${when}`).lastInsertRowid);
  const t1 = tx(NOW - 2 * DAY);
  db.prepare(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`).run(t1, groceries.id, NOW - 2 * DAY, NOW - 2 * DAY);
  const t2 = tx(NOW - 9 * DAY);
  db.prepare(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`).run(t2, groceries.id, NOW - 9 * DAY, NOW - 9 * DAY);
  db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,occurred_at,template,parser_version,status,role,ref)
    VALUES ('mpesa','loan_draw','in',12000,?,'mpesa.fuliza_draw','1','confirmed','funding_notice',?)`).run(NOW - 2 * DAY - 1000, `W${NOW - 2 * DAY}`);

  const habit = createHabit(a, { name: "Groceries habit", selector: { labels: [groceries.id], direction: "out" }, direction: "reduce", target: { period: "week", count: 2 } }, NOW);
  assert.ok(habit > 0);
  a.run(`INSERT INTO findings (id, detector, title, n, p_value, evidence, first_seen, last_seen, state, gate)
    VALUES ('f1','time_of_day','Late shopping is common',20,0.01,'{"window":[20,22],"group":"label:Groceries|out"}',?,?,'new','shown')`, [NOW - DAY, NOW - DAY]);
  a.run(`INSERT INTO findings (id, detector, title, n, p_value, evidence, first_seen, last_seen, state, gate)
    VALUES ('e1','episodes','Spend episode: 4 payments',4,0.01,?,?,?,'new','shown')`, [JSON.stringify({ startedAt: NOW - 2 * DAY, totalCents: 40000, txIds: [t1], creditShare: 0.5 }), NOW - 2 * DAY, NOW - 2 * DAY]);

  const r = weeklyReview(a, NOW);
  assert.equal(r.findings.length, 1);
  assert.equal(r.episodes.length, 1);
  assert.deepEqual(r.episodes[0]?.txIds, [t1]);
  assert.equal(r.habits.length, 1);
  assert.equal(r.habits[0]?.name, "Groceries habit");
  assert.equal(r.credit.thisCents, 12000);
  assert.ok(r.credit.thisShare > 0);
  assert.ok(r.credit.thisOutflowCents >= 12000);
  assert.equal(r.experiment?.habitId, habit);
  assert.equal(r.hasAnything, true);
  db.close();
});
