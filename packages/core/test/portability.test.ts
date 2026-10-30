import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lastInsertId, migrate, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";
import { createTag, createVenture, findTag } from "../src/tags/store.js";
import { repairDataIntegrity } from "../src/db/maintenance.js";

/** Node's result key, remapped to expo-sqlite's key (lastInsertRowId). */
function expoLikeAdapter(db: DatabaseSync): DbAdapter {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const r = db.prepare(sql).run(...((params ?? []) as never[]));
      return { lastInsertRowId: r.lastInsertRowid, changes: r.changes };
    },
    get: (sql, params) => db.prepare(sql).get(...((params ?? []) as never[])),
    all: (sql, params) => db.prepare(sql).all(...((params ?? []) as never[])),
  };
}

test("lastInsertId reads both adapter spellings", () => {
  assert.equal(lastInsertId({ lastInsertRowid: 7 }), 7);
  assert.equal(lastInsertId({ lastInsertRowId: 9 }), 9);
  assert.equal(lastInsertId({ lastInsertRowId: 9n }), 9);
  assert.equal(lastInsertId({}), 0);
});

test("tag/venture creation works with the expo-sqlite result key", () => {
  const db = new DatabaseSync(":memory:");
  const a = expoLikeAdapter(db);
  migrate(a);
  seedTaxonomy(a, 1);
  const tagId = createTag(a, "Stock", "user");
  assert.ok(tagId > 0);
  const v = createVenture(a, "Mama mboga", "business");
  assert.ok(v.tagId > 0);
  assert.ok(v.ventureId > 0);
  assert.equal(findTag(a, "Mama mboga")!.ventureKind, "business");
  db.close();
});

test("repairDataIntegrity fixes ventures stranded at tag_id 0", () => {
  const db = new DatabaseSync(":memory:");
  const a = expoLikeAdapter(db);
  migrate(a);
  seedTaxonomy(a, 1);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO tags (name, kind, created_at) VALUES ('Orphan', 'venture', 1)").run();
  db.prepare("INSERT INTO ventures (name, kind, tag_id, status) VALUES ('Orphan', 'business', 0, 'active')").run();
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(repairDataIntegrity(a, 2), 1);
  const row = db.prepare("SELECT v.tag_id AS tagId, t.name FROM ventures v JOIN tags t ON t.id = v.tag_id").get() as { tagId: number; name: string };
  assert.equal(row.name, "Orphan");
  assert.ok(row.tagId > 0);
  db.close();
});
