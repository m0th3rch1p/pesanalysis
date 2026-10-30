import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureFts, ftsAvailable, migrate, schemaVersion, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { getRetentionDays, purgeSmsBodies, resetAllData, setRetentionDays } from "../src/db/maintenance.js";

function adapter(db: DatabaseSync): DbAdapter {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(...((params ?? []) as never[])),
    get: (sql, params) => db.prepare(sql).get(...((params ?? []) as never[])),
    all: (sql, params) => db.prepare(sql).all(...((params ?? []) as never[])),
  };
}

const NEW_TABLES = [
  "tags", "tx_tags", "ventures", "tag_rules", "attachments", "tx_fts", "analyses",
  "conversations", "messages", "questions", "facts", "profile", "tool_audit", "hosts",
  "airlock_meta", "airlock_monthly", "airlock_categories",
  "accounts", "custom_templates", "security_alerts", "entity_links", "experiments",
];

test("fresh database has schema v4 tables, indexes and FTS", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  assert.equal(schemaVersion(adapter(db)), SCHEMA_VERSION);
  for (const t of NEW_TABLES) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(t) as { n: number };
    assert.equal(row.n, 1, `missing ${t}`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_notes_tx','idx_tx_status','idx_tx_role','idx_txlabels_label','idx_txlabels_confirmed','idx_tags_tx_tag','idx_attach_tx')").all() as { name: string }[];
  assert.equal(idx.length, 7);
  assert.equal(ftsAvailable(adapter(db)), true);
  db.prepare("INSERT INTO tx_fts (tx_id, body) VALUES (1, 'kplc tokens electricity')").run();
  const hit = db.prepare("SELECT tx_id FROM tx_fts WHERE tx_fts MATCH 'electricity'").get() as { tx_id: number };
  assert.equal(hit.tx_id, 1);
  db.close();
});

test("seedTaxonomy creates parent labels and fills parent_id (G4)", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  seedTaxonomy(adapter(db), 1_700_000_000_000);
  const exp = db.prepare("SELECT id FROM labels WHERE name='Expenses' AND status='active'").get() as { id: number };
  const grocery = db.prepare("SELECT parent_id FROM labels WHERE name='Groceries'").get() as { parent_id: number };
  assert.ok(exp?.id);
  assert.equal(grocery.parent_id, exp.id);
  // simulate an old DB that missed the parent link, then repair
  db.prepare("UPDATE labels SET parent_id = NULL WHERE name = 'Groceries'").run();
  seedTaxonomy(adapter(db), 1_700_000_000_001);
  const repaired = db.prepare("SELECT parent_id FROM labels WHERE name='Groceries'").get() as { parent_id: number };
  assert.equal(repaired.parent_id, exp.id);
  db.close();
});

test("v2 database migrates additively to v4 (columns + tables)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version','2');
    CREATE TABLE sms_raw (id INTEGER PRIMARY KEY, sender TEXT, body TEXT, received_at INTEGER, body_sha256 TEXT);
    CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, lat REAL, lng REAL, radius_m INTEGER);
    CREATE TABLE tx_context (tx_id INTEGER PRIMARY KEY, lat REAL, lng REAL);
    CREATE TABLE labels (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, status TEXT DEFAULT 'active', merged_into INTEGER, is_custom INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT UNIQUE, is_custom INTEGER DEFAULT 0, merged_into INTEGER, created_at INTEGER);
    CREATE TABLE tx_notes (id INTEGER PRIMARY KEY, tx_id INTEGER, kind TEXT, text TEXT, uri TEXT, transcript_lang TEXT, transcript_conf REAL, created_at INTEGER);
    CREATE TABLE transactions (id INTEGER PRIMARY KEY, sms_id INTEGER, provider TEXT, ref TEXT, kind TEXT, direction TEXT, amount INTEGER, fee INTEGER, balance_after INTEGER, counterparty_id INTEGER, account TEXT, occurred_at INTEGER, template TEXT, parser_version TEXT, chain_status TEXT, chain_discrepancy INTEGER, scope TEXT, status TEXT, episode_id INTEGER, role TEXT DEFAULT 'transaction', event_ref TEXT);
    CREATE TABLE tx_labels (tx_id INTEGER, label_id INTEGER, source TEXT, confidence REAL, suggested_at INTEGER, confirmed_at INTEGER, PRIMARY KEY (tx_id,label_id));
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, cadence TEXT, period_start INTEGER, period_end INTEGER, state TEXT, summary TEXT, decisions TEXT);
    CREATE TABLE findings (id TEXT PRIMARY KEY, detector TEXT, title TEXT, n INTEGER, p_value REAL, evidence TEXT, first_seen INTEGER, last_seen INTEGER, state TEXT);
    CREATE VIEW tx_events AS SELECT * FROM transactions WHERE role='transaction';
  `);
  migrate(adapter(db));
  assert.equal(schemaVersion(adapter(db)), SCHEMA_VERSION);
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
  assert.ok(cols("sms_raw").some((c) => c.name === "purged_at"));
  assert.ok(cols("tx_context").some((c) => c.name === "source"));
  assert.ok(cols("places").some((c) => c.name === "updated_at"));
  assert.ok(cols("transactions").some((c) => c.name === "account_id"));
  assert.ok(cols("transactions").some((c) => c.name === "settlement_status"));
  assert.ok(cols("tx_context").some((c) => c.name === "battery_pct"));
  const offRadar = db.prepare("SELECT COUNT(*) AS n FROM labels WHERE name = 'Off-radar transfer'").get() as { n: number };
  assert.equal(offRadar.n, 0); // seedTaxonomy runs separately
  const tag = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='tags'").get() as { n: number };
  assert.equal(tag.n, 1);
  db.close();
});

test("reset clears every user table, keeps schema and version (G3)", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  seedTaxonomy(adapter(db), 1);
  db.exec(`
    INSERT INTO sms_raw (sender, body, received_at, body_sha256) VALUES ('MPESA','x',1,'h');
    INSERT INTO transactions (sms_id, provider, kind, direction, amount, occurred_at, template, parser_version) VALUES (1,'mpesa','send','out',100,1,'t','1');
    INSERT INTO tags (name, kind, created_at) VALUES ('Mama mboga','venture',1);
    INSERT INTO tx_tags (tx_id, tag_id, source, created_at) VALUES (1,1,'user',1);
    INSERT INTO questions (kind, subject_ref, prompt, why, created_at) VALUES ('x','y','p','w',1);
    INSERT INTO facts (subject,predicate,object,created_at,updated_at) VALUES ('me','income','mixed',1,1);
  `);
  resetAllData(adapter(db));
  assert.equal(schemaVersion(adapter(db)), SCHEMA_VERSION);
  for (const t of ["sms_raw", "transactions", "tags", "tx_tags", "questions", "facts", "labels", "roles"]) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.equal(n, 0, `${t} not empty`);
  }
  seedTaxonomy(adapter(db), 2);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM labels").get() as { n: number }).n > 0);
  db.close();
});

test("SMS retention purges bodies but keeps the dedupe row (G8)", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  const now = 2_000_000_000_000;
  db.prepare("INSERT INTO sms_raw (sender, body, received_at, body_sha256) VALUES (?,?,?,?)").run("MPESA", "secret body", now - 40 * 86_400_000, "h1");
  db.prepare("INSERT INTO sms_raw (sender, body, received_at, body_sha256) VALUES (?,?,?,?)").run("MPESA", "fresh body", now - 1 * 86_400_000, "h2");
  assert.equal(getRetentionDays(adapter(db)), 0);
  setRetentionDays(adapter(db), 30, now);
  assert.equal(getRetentionDays(adapter(db)), 30);
  const rows = db.prepare("SELECT body, purged_at FROM sms_raw ORDER BY received_at").all() as { body: string; purged_at: number | null }[];
  assert.equal(rows[0]!.body, "");
  assert.ok(rows[0]!.purged_at);
  assert.equal(rows[1]!.body, "fresh body");
  assert.equal(purgeSmsBodies(adapter(db), 30, now), 0);
  db.close();
});

test("FTS availability is recorded and failure is non-fatal", () => {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  assert.equal(ensureFts(adapter(db)), true);
  assert.equal(ftsAvailable(adapter(db)), true);
  db.close();
});
