import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at, NOW } from "./fixtures.js";
import { parseNote } from "../src/items/parse.js";
import { addTxItem, ensureGroup, ensureItem, learnItemPricesForTx, listTxItems, rebuildItemPrices } from "../src/items/store.js";
import { inferItems } from "../src/items/infer.js";
import { itemRollup } from "../src/items/rollup.js";
import { createHabitCategory } from "../src/habits/categories.js";

test("note grammar: context + priced items that balance", () => {
  const p = parseNote("shop-cigarettes 30 + lemon 10", { direction: "out", txAmountCents: 4000 });
  assert.equal(p.category, "Groceries");
  assert.deepEqual(p.items.map((i) => [i.name, i.display, i.amountCents]), [["cigarette", "cigarettes", 3000], ["lemon", "lemon", 1000]]);
  assert.equal(p.amountsBalanced, true);
});

test("note grammar: quantities, units and Swahili names", () => {
  const p = parseNote("duka-6eggs, maziwa 65, sukari1/2kg");
  assert.equal(p.category, "Groceries");
  assert.equal(p.items[0]!.name, "egg");
  assert.equal(p.items[0]!.qty, 6);
  assert.equal(p.items[1]!.name, "milk");
  assert.equal(p.items[1]!.amountCents, 6500);
  assert.equal(p.items[2]!.name, "sugar");
  assert.equal(p.items[2]!.qty, 0.5);
  assert.equal(p.items[2]!.unit, "kg");
});

test("note grammar: amounts are dropped when they do not match the payment", () => {
  const p = parseNote("shop-bread 60 + milk 65", { txAmountCents: 10000 });
  assert.equal(p.amountsBalanced, false);
  assert.ok(p.items.every((i) => i.amountCents == null));
});

test("note grammar: friend clause becomes a role, food becomes eating out", () => {
  assert.equal(parseNote("friend-alex").counterpartyRole, "alex");
  assert.equal(parseNote("friend-alex").category, "Personal transfer");
  assert.equal(parseNote("food-chapo + smokie").category, "Eating out");
  assert.equal(parseNote("cigarettes 30").category, "Groceries");
});

test("items: confirmed items learn unit prices and infer exact and basket candidates", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number };
  const tx = (amount: number, atMs: number) => {
    const r = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
      VALUES ('mpesa','till','out',?,?,?,'mpesa.till','1','confirmed','transaction')`).run(amount, cp.id, atMs);
    return Number(r.lastInsertRowid);
  };
  const t1 = tx(3000, at(2026, 10, 1)); addTxItem(a, t1, { item: "cigarette", amountCents: 3000 });
  const t2 = tx(3000, at(2026, 10, 2)); addTxItem(a, t2, { item: "cigarette", amountCents: 3000 });
  const t3 = tx(4000, at(2026, 10, 3)); addTxItem(a, t3, { item: "cigarette", amountCents: 3000 }); addTxItem(a, t3, { item: "lemon", amountCents: 1000 });
  rebuildItemPrices(a);

  const exact = inferItems(a, { id: 0, counterpartyId: cp.id, amountCents: 3000 });
  assert.equal(exact[0]!.kind, "exact");
  assert.equal(exact[0]!.items[0]!.name, "cigarette");

  const basket = inferItems(a, { id: 0, counterpartyId: cp.id, amountCents: 4000 });
  assert.equal(basket[0]!.kind, "basket");
  assert.deepEqual(basket[0]!.items.map((i) => i.name).sort(), ["cigarette", "lemon"]);
  db.close();
});

test("items: group rollup uses the deepest level", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number };
  const r = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','till','out',3000,?,?,'mpesa.till','1','confirmed','transaction')`).run(cp.id, at(2026, 10, 5));
  const txId = Number(r.lastInsertRowid);
  const g = ensureGroup(a, "Fruits", { labelId: (db.prepare("SELECT id FROM labels WHERE name='Groceries'").get() as { id: number }).id });
  addTxItem(a, txId, { item: "lemon", groupId: g, amountCents: 3000 });
  const rows = itemRollup(a, at(2026, 10, 1), at(2026, 10, 31));
  assert.ok(rows.some((x) => x.level === "item" && x.name === "lemon" && x.totalCents === 3000 && x.labelName === "Groceries"));
  db.close();
});

test("habit category: accepting Tobacco moves existing and future cigarette items", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number };
  const insert = (amount: number) => Number(db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','till','out',?,?,?,'mpesa.till','1','confirmed','transaction')`).run(amount, cp.id, at(2026, 10, 6)).lastInsertRowid);
  const before = insert(3000); addTxItem(a, before, { item: "cigarettes", amountCents: 3000 });
  assert.ok(itemRollup(a, at(2026, 10, 1), at(2026, 10, 31)).some((r) => r.level === "item" && r.name === "cigarettes"));

  const h = createHabitCategory(a, "Tobacco");
  assert.ok(h.labelId > 0 && h.habitId > 0 && (h.groupId ?? 0) > 0);
  const rows = itemRollup(a, at(2026, 10, 1), at(2026, 10, 31));
  assert.ok(rows.some((r) => r.level === "item" && r.name === "cigarettes" && r.labelName === "Tobacco"), JSON.stringify(rows));

  const after = insert(4500); addTxItem(a, after, { item: "sigara", amountCents: 4500 });
  assert.ok(itemRollup(a, at(2026, 10, 1), at(2026, 10, 31)).some((r) => r.level === "item" && r.name === "sigara" && r.labelName === "Tobacco"));
  assert.equal(parseNote("shop-cigarettes 30").habitSuggestions[0], "Tobacco");
  db.close();
});
