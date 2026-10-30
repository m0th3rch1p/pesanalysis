import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { adapter, at } from "./fixtures.js";
import { migrate, seedTaxonomy } from "../src/db/migrate.js";
import { acceptDebtLink, createDebt, debtSummary, extractDebtTerms, getDebt, suggestDebtLinks } from "../src/debts/store.js";

function db() {
  const d = new DatabaseSync(":memory:");
  migrate(adapter(d)); seedTaxonomy(adapter(d), 1);
  return d;
}
function addTx(d: DatabaseSync, name: string, amount: number, at: number) {
  d.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?, ?, ?, 1)")
    .run(`n:${name.toLowerCase()}`, name, JSON.stringify([name]));
  const cp = Number((d.prepare("SELECT id FROM counterparties WHERE display_name = ?").get(name) as { id: number }).id);
  d.prepare(`INSERT INTO transactions (provider, kind, direction, amount, counterparty_id, occurred_at, template, parser_version, status)
             VALUES ('mpesa','send','out',?,?,?,'mpesa.send','1','pending')`).run(amount, cp, at);
  return Number((d.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

test("debt creation suggests a repayment and accepting labels it", () => {
  const d = db(); const a = adapter(d);
  const tx = addTx(d, "MARY WANJIKU", 500_00, at(2026, 10, 10, 10));
  const id = createDebt(a, { name: "Mama loan", creditor: "MARY WANJIKU", principalCents: 2000_00, paymentCents: 500_00, startAt: at(2026, 10, 1) }, at(2026, 10, 20));
  assert.ok(getDebt(a, id));
  const suggested = suggestDebtLinks(a, id, at(2026, 10, 20));
  assert.ok(suggested.some((x) => x.txId === tx));
  acceptDebtLink(a, id, tx, at(2026, 10, 20));
  const label = d.prepare(`SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = ? AND tl.confirmed_at IS NOT NULL`).get(tx) as { name: string } | undefined;
  assert.equal(label?.name, "Debt repayment");
  assert.equal(debtSummary(a).linkedRepayments, 1);
  d.close();
});

test("contract extractor reads common KES terms without inventing missing fields", () => {
  const x = extractDebtTerms("Personal loan agreement. Principal Ksh 50,000 at 12% per annum. Repay KES 4,500 per month. Dated 2026-01-15.");
  assert.equal(x.principalCents, 5_000_000);
  assert.equal(x.interestRateBps, 1_200);
  assert.equal(x.paymentCents, 450_000);
  assert.equal(x.paymentFrequency, "monthly");
  assert.ok(x.startAt != null);
  assert.ok(x.confidence > 0.5);
});
