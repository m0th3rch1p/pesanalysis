import test from "node:test";
import assert from "node:assert/strict";
import { adapter } from "./fixtures.js";
import { DatabaseSync } from "node:sqlite";
import { migrate, seedTaxonomy } from "../src/db/migrate.js";
import { linkAirtimeCredit, upsertBundle } from "../src/ledger/bundles.js";
import { at } from "./fixtures.js";

function db() {
  const d = new DatabaseSync(":memory:");
  migrate(adapter(d)); seedTaxonomy(adapter(d), 1);
  return d;
}
function cp(d: DatabaseSync, name: string) {
  d.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?, ?, ?, 1)")
    .run(`n:${name.toLowerCase()}`, name, JSON.stringify([name]));
  return Number((d.prepare("SELECT id FROM counterparties WHERE key = ?").get(`n:${name.toLowerCase()}`) as { id: number }).id);
}
function tx(d: DatabaseSync, cpId: number, amount: number, dir: string, kind: string, when: number) {
  d.prepare(`INSERT INTO transactions (provider, kind, direction, amount, counterparty_id, occurred_at, template, parser_version, status, role)
             VALUES ('mpesa', ?, ?, ?, ?, ?, 'test', '1', 'pending', 'transaction')`).run(kind, dir, amount, cpId, when);
  return Number((d.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

test("airtime purchase + credit becomes one cash event with hidden fee", () => {
  const d = db(); const a = adapter(d);
  const tingg = cp(d, "TINGG");
  const paid = tx(d, tingg, 5300, "out", "till", at(2026, 10, 27, 15));
  const credit = tx(d, tingg, 5000, "in", "airtime", at(2026, 10, 27, 15) + 1000);
  const b = linkAirtimeCredit(a, credit, 5000, at(2026, 10, 27, 15) + 1000, at(2026, 10, 27, 15) + 2000);
  assert.ok(b); assert.equal(b!.paidCents, 5300); assert.equal(b!.receivedCents, 5000); assert.equal(b!.hiddenFeeCents, 300);
  assert.equal((d.prepare("SELECT role FROM transactions WHERE id = ?").get(credit) as { role: string }).role, "airtime_credit");
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM tx_events").get() as { n: number }).n, 1);
  const label = d.prepare(`SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = ?`).get(paid) as { name: string } | undefined;
  assert.equal(label?.name, "Airtime & data");
  d.close();
});

test("a random payment is not bundled with an airtime gift", () => {
  const d = db(); const a = adapter(d);
  const shop = cp(d, "RANDOM SHOP");
  tx(d, shop, 5300, "out", "till", at(2026, 10, 27, 15));
  const credit = tx(d, shop, 5000, "in", "airtime", at(2026, 10, 27, 15) + 1000);
  assert.equal(linkAirtimeCredit(a, credit, 5000, at(2026, 10, 27, 15) + 1000), null);
  assert.equal((d.prepare("SELECT role FROM transactions WHERE id = ?").get(credit) as { role: string }).role, "airtime_credit");
  d.close();
});

test("upsertBundle is idempotent and keeps one primary row", () => {
  const d = db(); const a = adapter(d);
  const c = cp(d, "AIRTIME SHOP");
  const paid = tx(d, c, 1000, "out", "airtime", 1000);
  const b1 = upsertBundle(a, { primaryTxId: paid, paidCents: 1000, receivedCents: 900, hiddenFeeCents: 100 }, 1);
  const b2 = upsertBundle(a, { primaryTxId: paid, paidCents: 1000, receivedCents: 900, hiddenFeeCents: 100 }, 2);
  assert.equal(b1, b2);
  d.close();
});
