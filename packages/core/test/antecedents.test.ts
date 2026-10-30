import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { antecedents, conditionalRates } from "../src/insight/antecedents.js";

const DAY = 86_400_000, HOUR = 3_600_000;
const base = Date.UTC(2026, 0, 1, 7); // 10:00 EAT

function add(db: ReturnType<typeof fixtureDb>, label: string, at: number, amount = 10_000, dir: "in" | "out" = "out") {
  const cp = db.prepare(`SELECT id FROM counterparties LIMIT 1`).get() as { id: number };
  const id = Number(db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role,balance_after)
    VALUES ('mpesa','till',?,?,?,?,'x','1','confirmed','transaction',?)`).run(dir, amount, cp.id, at, 100_000).lastInsertRowid);
  const labelId = (db.prepare(`SELECT id FROM labels WHERE name = ?`).get(label) as { id: number }).id;
  db.prepare(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`).run(id, labelId, at, at);
  return id;
}

test("antecedents finds hours-since-groceries for late food and stays silent on a null persona", () => {
  const db = fixtureDb(); const a = adapter(db);
  for (let d = 0; d < 16; d++) {
    add(db, "Groceries", base + d * DAY - 2 * HOUR);
    add(db, "Eating out", base + d * DAY + 13 * HOUR);
  }
  const r = antecedents(a, base - DAY, base + 20 * DAY, { label: "Eating out" });
  assert.ok(r.factors.some((f) => f.key === "hours_since_groceries" && f.separates), JSON.stringify(r));

  const db2 = fixtureDb(); const a2 = adapter(db2);
  for (let d = 0; d < 16; d++) {
    add(db2, "Eating out", base + d * DAY + 13 * HOUR);
    add(db2, "Shopping", base + d * DAY + 13 * HOUR + 60_000);
  }
  const r2 = antecedents(a2, base - DAY, base + 20 * DAY, { label: "Eating out" });
  assert.ok(r2.factors.every((f) => f.separates), JSON.stringify(r2));
  db.close(); db2.close();
});

test("conditional rates compare days with and without the preparation event", () => {
  const db = fixtureDb(); const a = adapter(db);
  for (let d = 0; d < 10; d++) add(db, "Groceries", base + d * DAY - HOUR);
  for (let d = 10; d < 20; d++) if (d < 16) add(db, "Eating out", base + d * DAY + 13 * HOUR);
  const r = conditionalRates(a, base, base + 20 * DAY, { label: "Eating out" }, { label: "Groceries" }, 24);
  assert.equal(r.withCondition.n, 10);
  assert.equal(r.withCondition.k, 0);
  assert.equal(r.withoutCondition.k, 6);
  assert.match(r.message, /0 of 10/);
  db.close();
});
