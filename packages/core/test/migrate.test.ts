import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, schemaVersion, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";
import { RESET_TABLES } from "../src/db/maintenance.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

function adapter(db: DatabaseSync): DbAdapter {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(...((params ?? []) as never[])),
    get: (sql, params) => db.prepare(sql).get(...((params ?? []) as never[])),
    all: (sql, params) => db.prepare(sql).all(...((params ?? []) as never[])),
  };
}

test("migrate works on a brand-new empty database (no meta table yet)", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(schemaVersion(adapter(db)), 0);
  migrate(adapter(db));
  assert.equal(schemaVersion(adapter(db)), SCHEMA_VERSION);
  const t = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { n: number };
  assert.equal(t.n, 1);
  db.close();
});

test("migrate is idempotent and seedTaxonomy does not duplicate", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  migrate(adapter(db));
  seedTaxonomy(adapter(db), 1_700_000_000_000);
  seedTaxonomy(adapter(db), 1_700_000_000_000);
  const labels = db.prepare("SELECT COUNT(*) AS n FROM labels").get() as { n: number };
  const roles = db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number };
  assert.ok(labels.n > 0);
  assert.ok(roles.n > 0);
  const dup = db.prepare("SELECT name, COUNT(*) AS n FROM labels GROUP BY name HAVING n > 1").all() as unknown[];
  assert.equal(dup.length, 0);
  db.close();
});

test("a database newer than the code is rejected", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  assert.throws(() => migrate(adapter(db)), /newer than code/);
  db.close();
});

test("legacy INTEGER proposals table is rebuilt so string profiler ids work", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  db.exec(`
    DROP TABLE proposals;
    CREATE TABLE proposals (
      id INTEGER PRIMARY KEY, origin TEXT NOT NULL, type TEXT NOT NULL, patch TEXT NOT NULL,
      rationale TEXT, predicted TEXT, evidence TEXT, status TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL, applied_at INTEGER, rolled_back_at INTEGER
    );
    INSERT INTO proposals (id, origin, type, patch, status, created_at)
      VALUES (1, 'profiler', 'rule_add', '{}', 'proposed', 1);
  `);
  migrate(adapter(db));
  const col = (db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string; type: string }>)
    .find((c) => c.name === "id");
  assert.equal(col?.type, "TEXT");
  assert.equal((db.prepare("SELECT id FROM proposals").get() as { id: string }).id, "1");
  db.prepare(`INSERT INTO proposals (id, origin, type, patch, status, created_at)
              VALUES ('profiler:test', 'profiler', 'rule_add', '{}', 'proposed', 2)`).run();
  db.close();
});

test("v9 install with an items table but no key column migrates without the index-before-column bug", () => {
  const db = new DatabaseSync(":memory:");
  const a = adapter(db);
  migrate(a);
  db.exec(`DROP INDEX IF EXISTS idx_items_key`);
  db.exec(`ALTER TABLE items DROP COLUMN key`);
  db.prepare(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`).run();
  migrate(a);
  assert.equal(schemaVersion(a), SCHEMA_VERSION);
  const cols = db.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "key"));
  assert.ok((db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_key'`).get() as { name?: string } | undefined)?.name);
  db.close();
});

test("every user table is in RESET_TABLES (no reset/backup leftovers)", () => {
  const db = new DatabaseSync(":memory:");
  const a = adapter(db);
  migrate(a);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("tx_fts_"));
  const missing = tables.filter((n) => n !== "meta" && !(RESET_TABLES as readonly string[]).includes(n));
  assert.deepEqual(missing, []);
  db.close();
});
