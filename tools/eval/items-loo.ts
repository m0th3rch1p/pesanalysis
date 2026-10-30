/**
 * Item inference leave-one-out acceptance (WS3.3). Prints aggregates only; reads the
 * founder's private gold export locally.   npx tsx tools/eval/items-loo.ts [path]
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate, seedTaxonomy, type DbAdapter } from "../../packages/core/src/db/migrate.js";
import { addTxItem, rebuildItemPrices } from "../../packages/core/src/items/store.js";
import { inferItems } from "../../packages/core/src/items/infer.js";
import { normalizeItemName } from "../../packages/core/src/items/normalize.js";

interface Event {
  occurredAt: number; amount: number; kind: string; direction: "in" | "out" | "neutral";
  detail?: string; counterparty?: { key?: string; name?: string };
}
const ad = (db: DatabaseSync): DbAdapter => ({
  exec: (s) => db.exec(s), run: (s, p) => db.prepare(s).run(...((p ?? []) as never[])),
  get: (s, p) => db.prepare(s).get(...((p ?? []) as never[])), all: (s, p) => db.prepare(s).all(...((p ?? []) as never[])),
});
const path = process.argv[2] ?? "data/private/gold.events.jsonl";
const all = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event)
  .filter((e) => e.detail && e.counterparty?.key)
  .sort((a, b) => a.occurredAt - b.occurredAt);

function itemsOf(e: Event): string[] {
  return e.detail!.split(/\s*(?:\+|,|;|\band\b)\s*/i).map(normalizeItemName).filter(Boolean);
}

let exactN = 0, exactRight = 0, exactCovered = 0;
let basketN = 0, basketRight = 0, basketCovered = 0, modeRight = 0, modeN = 0;
for (let i = 0; i < all.length; i++) {
  const target = all[i]!;
  const goldItems = itemsOf(target);
  if (!goldItems.length) continue;
  const db = new DatabaseSync(":memory:");
  const a = ad(db);
  migrate(a); seedTaxonomy(a, 1);
  for (let j = 0; j < all.length; j++) {
    if (j === i) continue;
    const e = all[j]!;
    const cpKey = e.counterparty!.key!;
    const cp = db.prepare(`SELECT id FROM counterparties WHERE key = ?`).get(cpKey) as { id: number } | undefined;
    const cpId = cp?.id ?? Number(db.prepare(`INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)`).run(cpKey, e.counterparty!.name ?? cpKey, "[]", e.occurredAt).lastInsertRowid);
    const txId = Number(db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
      VALUES ('mpesa',?,?,?,?,?,'mpesa.till','1','confirmed','transaction')`).run(e.kind, e.direction, e.amount, cpId, e.occurredAt).lastInsertRowid);
    const its = itemsOf(e);
    for (const it of its) {
      addTxItem(a, txId, { item: it, amountCents: its.length === 1 ? e.amount : null, source: "gold", confirmed: true }, e.occurredAt);
    }
  }
  rebuildItemPrices(a);
  const cpTarget = db.prepare(`SELECT id FROM counterparties WHERE key = ?`).get(target.counterparty!.key!) as { id: number } | undefined;
  if (!cpTarget) { db.close(); continue; }
  const cands = inferItems(a, { id: -1, counterpartyId: cpTarget.id, amountCents: target.amount });
  const wantsBasket = goldItems.length > 1;
  if (!wantsBasket) {
    exactN++;
    const exact = cands.find((c) => c.kind === "exact");
    if (exact) {
      exactCovered++;
      const got = exact.items.map((x) => normalizeItemName(x.name)).sort();
      if (got.join("|") === goldItems.sort().join("|")) exactRight++;
    }
  } else {
    basketN++;
    const basket = cands.find((c) => c.kind === "basket");
    if (basket) {
      basketCovered++;
      const got = basket.items.map((x) => normalizeItemName(x.name)).sort();
      if (got.join("|") === goldItems.sort().join("|")) basketRight++;
    }
  }
  modeN++;
  const mode = cands.find((c) => c.kind === "mode");
  if (mode && normalizeItemName(mode.items[0]!.name) === goldItems[0]) modeRight++;
  db.close();
}
console.log(JSON.stringify({
  events: all.length,
  exact: { n: exactN, coverage: exactN ? +(exactCovered / exactN).toFixed(3) : 0, accuracy: exactCovered ? +(exactRight / exactCovered).toFixed(3) : 0 },
  basket: { n: basketN, coverage: basketN ? +(basketCovered / basketN).toFixed(3) : 0, accuracy: basketCovered ? +(basketRight / basketCovered).toFixed(3) : 0 },
  mode: { n: modeN, agreement: modeN ? +(modeRight / modeN).toFixed(3) : 0 },
}, null, 2));
