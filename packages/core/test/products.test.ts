import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { brandLifespans, createProduct, hammingHex, listProducts, matchProducts, setProductStatus, warrantyInfo } from "../src/products/store.js";

test("products: warranty dates, local hash matching and brand lifespan", () => {
  const db = fixtureDb(); const a = adapter(db);
  const id = createProduct(a, {
    name: "Boda helmet", brand: "SMK", boughtAt: NOW - 100 * 86_400_000,
    priceCents: 250_000, warrantyMonths: 12, imageHash: "0123456789abcdef",
  }, NOW);
  assert.ok(id > 0);
  const p = listProducts(a)[0]!;
  const w = warrantyInfo(p, NOW);
  assert.equal(w.state, "active");
  assert.ok((w.daysLeft ?? 0) > 200);
  assert.equal(hammingHex("0000000000000000", "00000000000000ff"), 8);
  assert.equal(matchProducts(a, "0123456789abcdee")[0]?.product.id, id);
  setProductStatus(a, id, "retired", NOW);
  const life = brandLifespans(a, NOW)[0]!;
  assert.equal(life.brand, "SMK");
  assert.equal(life.avgOwnedDays, 100);
  assert.equal(listProducts(a).length, 0, "retired items are hidden by default");
  db.close();
});
