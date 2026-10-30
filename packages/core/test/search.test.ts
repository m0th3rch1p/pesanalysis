import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { parseSearch } from "../src/search/parse.js";
import { buildFtsQuery, ensureSearchIndex, markSearchIndexDirty, rebuildSearchIndex, searchTransactions } from "../src/search/service.js";

function prep() {
  const db = fixtureDb();
  const n = rebuildSearchIndex(adapter(db));
  return { db, n };
}

test("search: free text hits a note", () => {
  const { db, n } = prep();
  assert.equal(n, 5);
  const hits = searchTransactions(adapter(db), parseSearch("kale", NOW), NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.amount, 200_000);
  assert.match(hits[0]!.note ?? "", /kale/);
  db.close();
});

test("search: tags and categories are structured filters", () => {
  const { db } = prep();
  const tagged = searchTransactions(adapter(db), parseSearch("tag:Mama mboga", NOW, { tags: ["Mama mboga"] }), NOW);
  assert.deepEqual(tagged.map((h) => h.amount).sort((a, b) => a - b), [100_000, 200_000]);
  const groceries = searchTransactions(adapter(db), parseSearch("cat:Groceries", NOW), NOW);
  assert.equal(groceries.length, 2);
  db.close();
});

test("search: amount, direction and time chips", () => {
  const { db } = prep();
  const p = parseSearch("over 2500 out", NOW);
  assert.equal(p.filters.minAmountCents, 250_000);
  assert.equal(p.filters.direction, "out");
  const hits = searchTransactions(adapter(db), p, NOW);
  assert.deepEqual(hits.map((h) => h.amount), [300_000]);
  const last = searchTransactions(adapter(db), parseSearch("last month", NOW), NOW);
  assert.deepEqual(last.map((h) => h.amount), [300_000]);
  db.close();
});

test("search: combined full text + tag", () => {
  const { db } = prep();
  const hits = searchTransactions(adapter(db), parseSearch("kale tag:Mama mboga", NOW, { tags: ["Mama mboga"] }), NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.amount, 200_000);
  db.close();
});

test("search: FTS query quotes operators", () => {
  assert.equal(buildFtsQuery('foo" OR "bar'), '"foo" AND "OR" AND "bar"*');
  const { db } = prep();
  assert.doesNotThrow(() => searchTransactions(adapter(db), parseSearch('foo" OR "bar', NOW), NOW));
  db.close();
});

test("search: LIKE fallback works when FTS is unavailable", () => {
  const { db } = prep();
  db.exec("DROP TABLE tx_fts; UPDATE meta SET value='0' WHERE key='fts5';");
  const hits = searchTransactions(adapter(db), parseSearch("kale", NOW), NOW);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.amount, 200_000);
  db.close();
});

test("search: after/before absolute dates", () => {
  const { db } = prep();
  const p = parseSearch("after:2026-10-01 before:2026-10-08", NOW);
  assert.equal(p.filters.time?.kind, "absolute");
  const hits = searchTransactions(adapter(db), p, NOW);
  assert.equal(hits.length, 4);
  db.close();
});

test("search: startup index is write-free when clean, rebuilds when dirty", () => {
  const db = fixtureDb();
  const a = adapter(db);
  assert.equal(rebuildSearchIndex(a), 5);
  assert.equal(ensureSearchIndex(a), 0);
  db.prepare(`INSERT INTO transactions (id, provider, kind, direction, amount, occurred_at, template, parser_version, chain_status, status, role) VALUES (99, 'mpesa', 'till', 'out', 1000, ?, 'mpesa.till', '1', 'ok', 'pending', 'transaction')`).run(NOW);
  assert.equal(ensureSearchIndex(a), 6);
  assert.equal(ensureSearchIndex(a), 0);
  markSearchIndexDirty(a);
  assert.equal(ensureSearchIndex(a), 6);
  assert.equal(ensureSearchIndex(a), 0);
  db.close();
});
