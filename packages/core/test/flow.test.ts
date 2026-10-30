import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, type DbAdapter } from "../src/db/migrate.js";
import { classifyFlow, moneyTotals, moneyTotalsOf, type FlowClass } from "../src/ledger/flow.js";

const adapter = (db: DatabaseSync): DbAdapter => ({
  exec: (s) => db.exec(s),
  run: (s, p) => db.prepare(s).run(...((p ?? []) as never[])),
  get: (s, p) => db.prepare(s).get(...((p ?? []) as never[])),
  all: (s, p) => db.prepare(s).all(...((p ?? []) as never[])),
});

test("classification rules", () => {
  const c = (kind: string, direction: string, extra = {}) => classifyFlow({ kind, direction, ...extra });
  assert.equal(c("receive", "in"), "income");
  assert.equal(c("send", "out"), "spend");
  assert.equal(c("loan_draw", "in"), "debt_draw");
  assert.equal(c("loan_repay", "out"), "debt_repay");
  assert.equal(c("withdraw", "out"), "cash_out");
  assert.equal(c("deposit", "in"), "cash_in");
  assert.equal(c("fee", "out"), "fee");
  assert.equal(c("reversal", "in"), "reversal");
  assert.equal(c("send", "out", { counterpartyName: "M-Shwari" }), "transfer_own");
  assert.equal(c("paybill", "out", { counterpartyName: "KCB M-PESA" }), "transfer_own");
  assert.equal(c("other", "neutral"), "neutral");
});

test("SQL totals match in-memory totals and exclude debt and own transfers from net", () => {
  const raw = new DatabaseSync(":memory:");
  const db = adapter(raw);
  migrate(db);
  const rows: Array<{ flowClass: FlowClass; direction: string; amount: number; fee: number | null; kind: string }> = [
    { flowClass: "income", direction: "in", amount: 100000, fee: null, kind: "receive" },
    { flowClass: "spend", direction: "out", amount: 30000, fee: 700, kind: "send" },
    { flowClass: "debt_draw", direction: "in", amount: 50000, fee: null, kind: "loan_draw" },
    { flowClass: "debt_repay", direction: "out", amount: 50000, fee: null, kind: "loan_repay" },
    { flowClass: "transfer_own", direction: "out", amount: 20000, fee: null, kind: "send" },
    { flowClass: "cash_out", direction: "out", amount: 10000, fee: 2900, kind: "withdraw" },
    { flowClass: "fee", direction: "out", amount: 1000, fee: null, kind: "fee" },
    { flowClass: "reversal", direction: "in", amount: 5000, fee: null, kind: "reversal" },
  ];
  rows.forEach((r, i) => raw.prepare(
    `INSERT INTO transactions (provider, ref, kind, direction, amount, fee, occurred_at, template, parser_version, flow_class)
     VALUES ('mpesa', ?, ?, ?, ?, ?, 1000, 't', 'p', ?)`,
  ).run(`R${i}`, r.kind, r.direction, r.amount, r.fee, r.flowClass));
  const sql = moneyTotals(db, 0, 10_000);
  const mem = moneyTotalsOf(rows);
  assert.deepEqual(sql, mem);
  // transfers count as money out (founder rule); debt excluded; fees 700+2900+1000
  assert.equal(sql.net, 100000 + 5000 - 30000 - 10000 - 20000 - 4600);
  assert.equal(sql.debtDraw - sql.debtRepay, 0);
  raw.close();
});

test("v7 backfill classifies legacy rows", () => {
  const raw = new DatabaseSync(":memory:");
  const db = adapter(raw);
  migrate(db);
  raw.prepare(`INSERT INTO transactions (provider, ref, kind, direction, amount, occurred_at, template, parser_version)
               VALUES ('mpesa','X','loan_repay','out',100,1,'t','p')`).run();
  migrate(db);
  const r = raw.prepare(`SELECT flow_class AS f FROM transactions WHERE ref='X'`).get() as { f: string };
  assert.equal(r.f, "debt_repay");
  raw.close();
});
