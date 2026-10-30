import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import {
  acceptProposal, addTagRule, applyTagRules, createTag, createVenture, findTag, listTags,
  mergeTags, suggestTags, tagTx, tagsForTx, untagTx, venturePnl,
} from "../src/tags/store.js";

test("tags: create, tag, list and untag are idempotent", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const id = createTag(a, "Stock");
  assert.equal(createTag(a, "stock"), id);
  tagTx(a, 5, "Stock");
  tagTx(a, 5, "Stock");
  assert.deepEqual(tagsForTx(a, 5).map((t) => t.name), ["Stock"]);
  assert.equal(listTags(a).find((t) => t.id === id)!.txCount, 1);
  untagTx(a, 5, id);
  assert.equal(tagsForTx(a, 5).length, 0);
  db.close();
});

test("tags: ventures and P&L include fees", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const { tagId } = createVenture(a, "Mama mboga", "business");
  tagTx(a, 3, "Mama mboga"); // KPLC 500 + 15 fee, out
  const pnl = venturePnl(a, tagId);
  assert.equal(pnl.incomeCents, 0);
  assert.equal(pnl.expenseCents, 300_000 + 50_000);
  assert.equal(pnl.feeCents, 1_500);
  assert.equal(pnl.netCents, -351_500);
  assert.equal(pnl.txCount, 3);
  db.close();
});

test("tags: retroactive counterparty rule tags existing history", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const id = createTag(a, "Supplier");
  addTagRule(a, id, "counterparty", "naivas");
  const n = applyTagRules(a);
  assert.equal(n, 2);
  assert.equal(listTags(a).find((t) => t.id === id)!.txCount, 2);
  assert.equal(applyTagRules(a), 0);
  db.close();
});

test("tags: merge moves links and keeps a tombstone", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const from = createTag(a, "Vendor");
  const into = createTag(a, "Supplier");
  tagTx(a, 1, "Vendor");
  mergeTags(a, from, into);
  const tomb = findTag(a, "Vendor");
  assert.equal(tomb!.id, into);
  assert.equal(findTag(a, "Supplier")!.txCount, 1);
  db.close();
});

test("tags: suggestions only propose untagged recurring counterparties", () => {
  const db = fixtureDb();
  const a = adapter(db);
  db.exec("DELETE FROM ventures; DELETE FROM tx_tags; DELETE FROM tags;");
  const props = suggestTags(a, Date.UTC(2026, 9, 26), 2);
  assert.ok(props.length >= 1);
  const naivas = props.find((p) => p.tag === "NAIVAS");
  assert.ok(naivas);
  assert.equal(naivas!.candidateTxIds.length, 2);
  const id = acceptProposal(a, naivas!);
  assert.equal(listTags(a).find((t) => t.id === id)!.txCount, 2);
  assert.equal(suggestTags(a, Date.UTC(2026, 9, 26), 2).find((p) => p.tag === "NAIVAS"), undefined);
  db.close();
});
