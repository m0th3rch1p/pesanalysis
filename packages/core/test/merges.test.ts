import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { adapter } from "./fixtures.js";
import { migrate, seedTaxonomy } from "../src/db/migrate.js";
import { autoMergeNameOnlyVariants, mergeCounterparties, suggestCounterpartyMerges, dismissMergeCandidate } from "../src/entities/merges.js";

function db() {
  const d = new DatabaseSync(":memory:");
  migrate(adapter(d)); seedTaxonomy(adapter(d), 1);
  return d;
}
function add(d: DatabaseSync, key: string, name: string, at: number) {
  d.prepare("INSERT INTO counterparties (key, raw_names, first_seen) VALUES (?, ?, ?)").run(key, JSON.stringify([name]), at);
  return Number((d.prepare("SELECT id FROM counterparties WHERE key = ?").get(key) as { id: number }).id);
}
function tx(d: DatabaseSync, cpId: number, at: number) {
  d.prepare(`INSERT INTO transactions (provider, kind, direction, amount, counterparty_id, occurred_at, template, parser_version, status)
             VALUES ('mpesa','send','out',1000,?,?,'mpesa.send','1','pending')`).run(cpId, at);
}

test("same person full and masked phone becomes a merge candidate, then merges", () => {
  const d = db(); const a = adapter(d);
  const full = add(d, "p:254700000001", "ALEX KAMAU", 1);
  const masked = add(d, "m:254700***001:alex_kamau", "ALEX KAMAU", 2);
  tx(d, full, 10); tx(d, masked, 20);
  const candidates = suggestCounterpartyMerges(a, 100);
  assert.ok(candidates.length >= 1);
  const c = candidates.find((x) => (x.leftId === full && x.rightId === masked) || (x.leftId === masked && x.rightId === full))!;
  assert.ok(c.score >= 0.9);
  const survivor = mergeCounterparties(a, full, masked);
  assert.equal(survivor, full);
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM transactions WHERE counterparty_id = ?").get(masked) as { n: number }).n, 0);
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM transactions WHERE counterparty_id = ?").get(full) as { n: number }).n, 2);
  assert.ok((d.prepare("SELECT merged_into FROM counterparties WHERE id = ?").get(masked) as { merged_into: number }).merged_into === full);
  d.close();
});

test("a dismissed merge candidate stays dismissed", () => {
  const d = db(); const a = adapter(d);
  add(d, "p:254700000001", "ALEX KAMAU", 1);
  add(d, "m:254700***002:alex_kamau", "ALEX KAMAU", 2);
  const c = suggestCounterpartyMerges(a, 100)[0]!;
  dismissMergeCandidate(a, c.id, 101);
  assert.equal(suggestCounterpartyMerges(a, 102).length, 0);
  d.close();
});


test("name-only case variants auto-merge, but identifier rows stay candidates (WS0.4)", () => {
  const d = db(); const a = adapter(d);
  const lower = add(d, "n:alex kamau", "alex kamau", 1);
  const upper = add(d, "n:ALEX KAMAU", "ALEX KAMAU", 2);
  tx(d, lower, 10); tx(d, upper, 20);
  assert.equal(autoMergeNameOnlyVariants(a, 100), 1);
  const survivor = d.prepare("SELECT id, merged_into FROM counterparties WHERE id IN (?,?) AND merged_into IS NULL").all(lower, upper) as Array<{ id: number }>;
  assert.equal(survivor.length, 1);
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM transactions WHERE counterparty_id = ?").get(survivor[0]!.id) as { n: number }).n, 2);

  const named = add(d, "n:acme shop", "ACME SHOP", 3);
  const phone = add(d, "p:254700000009", "ACME SHOP", 4);
  assert.equal(autoMergeNameOnlyVariants(a, 101), 0);
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM counterparties WHERE id IN (?,?) AND merged_into IS NULL").get(named, phone) as { n: number }).n, 2);
  d.close();
});
