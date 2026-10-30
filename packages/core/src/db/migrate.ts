/**
 * Migration runner. The SCHEMA_SQL string works unchanged in Node (tests) and Expo (expo-sqlite).
 * Additive migrations only: new tables/columns via ALTER TABLE ADD COLUMN; never rename in place
 * (DECISIONS D12). Version tracked in `meta`.
 */
import { backfillFlowClass } from "../ledger/flow.js";
import { ensureModelTables } from "../ai/tables.js";
import { FTS_SQL, SCHEMA_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_V8_SQL, SCHEMA_V9_SQL, SCHEMA_V10_SQL, SCHEMA_VERSION } from "./schema.js";
import { SEED_LABELS, SEED_ROLES } from "../labels/taxonomy.js";
import { ensureAssistantTables } from "../assistant/tables.js";

export interface DbAdapter {
  exec(sql: string): unknown | void;
  run(sql: string, params?: unknown[]): unknown | void;
  get(sql: string, params?: unknown[]): any;
  all(sql: string, params?: unknown[]): any[];
}

/** Node sqlite returns `lastInsertRowid`; expo-sqlite returns `lastInsertRowId`. Never guess. */
export function lastInsertId(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as { lastInsertRowid?: number | bigint; lastInsertRowId?: number | bigint };
  const v = r.lastInsertRowid ?? r.lastInsertRowId ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function schemaVersion(db: DbAdapter): number {
  const hasMeta = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`);
  if (!hasMeta) return 0;
  const row = db.get(`SELECT value FROM meta WHERE key = 'schema_version'`);
  return row ? Number(row.value) : 0;
}

function columns(db: DbAdapter, table: string): Set<string> {
  try {
    return new Set(db.all(`PRAGMA table_info(${table})`).map((r: { name: string }) => r.name));
  } catch {
    return new Set();
  }
}

function addColumn(db: DbAdapter, table: string, name: string, decl: string): void {
  const exists = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  if (!exists) return;
  if (columns(db, table).has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}

/** Columns added in v3. Separate from table DDL so partial/older DBs converge safely. */
export function ensureV3Columns(db: DbAdapter): void {
  addColumn(db, "sms_raw", "purged_at", "INTEGER");
  addColumn(db, "tx_context", "source", "TEXT NOT NULL DEFAULT 'none'");
  addColumn(db, "tx_context", "captured_at", "INTEGER");
  addColumn(db, "tx_context", "age_ms", "INTEGER");
  addColumn(db, "places", "created_at", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "places", "updated_at", "INTEGER");
}

/** v4 columns. Tables are created by SCHEMA_V4_SQL; columns must exist before indexes. */
export function ensureV4Columns(db: DbAdapter): void {
  addColumn(db, "transactions", "account_id", "INTEGER");
  addColumn(db, "transactions", "settlement_status", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumn(db, "tx_context", "battery_pct", "INTEGER");
  addColumn(db, "tx_context", "is_charging", "INTEGER");
  addColumn(db, "tx_context", "step_delta", "INTEGER");
  addColumn(db, "tx_context", "circadian_phase", "TEXT");
}

/** v5 columns. Added outside the versioned DDL so a partially-migrated DB cannot wedge. */
export function ensureV5Columns(db: DbAdapter): void {
  addColumn(db, "accounts", "credit_limit_cents", "INTEGER");
  addColumn(db, "accounts", "available_credit_cents", "INTEGER");
  addColumn(db, "accounts", "outstanding_cents", "INTEGER");
  addColumn(db, "accounts", "due_at", "INTEGER");
}

/** v6 columns. Tables are in SCHEMA_V6_SQL; columns must exist before the canonical view is rebuilt. */
export function ensureV6Columns(db: DbAdapter): void {
  addColumn(db, "transactions", "bundle_id", "INTEGER");
  addColumn(db, "counterparties", "merged_into", "INTEGER");
  addColumn(db, "counterparties", "default_label_id", "INTEGER");
  addColumn(db, "accounts", "merged_into", "INTEGER");
  rebuildTxEventsView(db);
}

/** v7: money model. `flow_class` is set at ingest and backfilled here; the view is rebuilt so it carries the column. */
export function ensureV7Columns(db: DbAdapter): void {
  addColumn(db, "transactions", "flow_class", "TEXT");
  rebuildTxEventsView(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_flow ON transactions(flow_class, occurred_at)`);
}

/** v8: expected flows, occurrences, savings locations/goals, budgets. All statements are IF NOT EXISTS. */
export function ensureV8Tables(db: DbAdapter): void {
  db.exec(SCHEMA_V8_SQL);
}

/** v9: alerts, capture prompts, decision journal. All statements are IF NOT EXISTS. */
export function ensureV9Tables(db: DbAdapter): void {
  db.exec(SCHEMA_V9_SQL);
}

/** v10 tables (items, habits, goals, capture controls) and the columns added to older tables. */
export function ensureV10Tables(db: DbAdapter): void {
  db.exec(SCHEMA_V10_SQL);
}

export function ensureV10Columns(db: DbAdapter): void {
  addColumn(db, "experiments", "habit_id", "INTEGER");
  addColumn(db, "experiments", "mode", "TEXT DEFAULT 'live'");
  addColumn(db, "security_alerts", "verdict", "TEXT");
  addColumn(db, "security_alerts", "suppressed_reason", "TEXT");
  addColumn(db, "security_alerts", "visibility", "TEXT DEFAULT 'prominent'");
  addColumn(db, "findings", "q_value", "REAL");
  addColumn(db, "findings", "effect_json", "TEXT");
  addColumn(db, "findings", "gate", "TEXT");
  addColumn(db, "findings", "feedback", "INTEGER");
  addColumn(db, "tx_context", "fix_kind", "TEXT");
  addColumn(db, "tx_context", "fix_latency_ms", "INTEGER");
  addColumn(db, "tx_context", "provider", "TEXT");
  addColumn(db, "items", "key", "TEXT");
  try {
    db.run(`UPDATE items SET key = lower(trim(name)) WHERE key IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_key ON items(key)`);
  } catch { /* table not created yet on a fresh v10 path; SCHEMA_V10_SQL has the index */ }
}

/** The canonical view is deliberately narrow: only real cash movements. */
export function rebuildTxEventsView(db: DbAdapter): void {
  db.exec(`
    DROP VIEW IF EXISTS tx_events;
    CREATE VIEW tx_events AS
      SELECT * FROM transactions
       WHERE role = 'transaction'
         AND NOT (kind = 'airtime' AND direction = 'in')
         AND template NOT LIKE 'airtel.airtime_loan%'
         AND template NOT LIKE 'airtel.kopa_repay%'
         AND template NOT LIKE 'telco.okoa_%';
  `);
}

/**
 * FTS5 is compiled into Expo SQLite, but its coexistence with SQLCipher is spike S2.
 * Never let a missing FTS5 module brick the ledger: record availability in meta and
 * let search fall back to LIKE. Returns true when FTS is usable.
 */
export function ensureFts(db: DbAdapter): boolean {
  try {
    const has = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tx_fts'`);
    if (!has) db.exec(FTS_SQL);
    db.run(`INSERT INTO meta (key, value) VALUES ('fts5', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    return true;
  } catch {
    try {
      db.run(`INSERT INTO meta (key, value) VALUES ('fts5', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    } catch { /* meta not ready: fresh schema will create it before this is called */ }
    return false;
  }
}

export function ftsAvailable(db: DbAdapter): boolean {
  const row = db.get(`SELECT value FROM meta WHERE key = 'fts5'`);
  return row?.value === "1";
}

/**
 * v2/v3 shipped `proposals.id INTEGER PRIMARY KEY`, but profiler ids are strings
 * ("profiler:..."). SQLite raises "datatype mismatch" on insert. Rebuild once,
 * preserving any integer rows as text. Fresh databases already use TEXT.
 */
export function repairProposalsSchema(db: DbAdapter): void {
  const row = db.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'proposals'`);
  if (!row?.sql || /id\s+TEXT\s+PRIMARY\s+KEY/i.test(String(row.sql))) return;
  db.exec(`
    ALTER TABLE proposals RENAME TO proposals_old;
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      type TEXT NOT NULL,
      patch TEXT NOT NULL,
      rationale TEXT, predicted TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL, applied_at INTEGER, rolled_back_at INTEGER
    );
    INSERT INTO proposals (id, origin, type, patch, rationale, predicted, evidence, status, created_at, applied_at, rolled_back_at)
      SELECT CAST(id AS TEXT), origin, type, patch, rationale, predicted, evidence, status, created_at, applied_at, rolled_back_at
        FROM proposals_old;
    DROP TABLE proposals_old;
  `);
}

export function migrate(db: DbAdapter): void {
  ensureModelTables(db);
  const v = schemaVersion(db);
  ensureAssistantTables(db); // idempotent, independent of SCHEMA_VERSION (assistant/tables.ts)
  if (v === 0) {
    db.exec(SCHEMA_SQL);
    ensureV5Columns(db);
    ensureV6Columns(db);
    ensureV7Columns(db);
    ensureV8Tables(db);
    ensureV9Tables(db);
    ensureV10Tables(db);
    ensureV10Columns(db);
    backfillFlowClass(db);
    ensureFts(db);
    repairProposalsSchema(db);
    db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
    return;
  }
  if (v > SCHEMA_VERSION) throw new Error(`db newer than code: ${v} > ${SCHEMA_VERSION}`);
  if (v < 3) ensureV3Columns(db);
  if (v < 4) ensureV4Columns(db);
  if (v < 5) ensureV5Columns(db);
  if (v < 6) ensureV6Columns(db);
  if (v < 7) ensureV7Columns(db);
  if (v < 8) ensureV8Tables(db);
  if (v < 9) ensureV9Tables(db);
  for (const m of MIGRATIONS) {
    if (m.version <= schemaVersion(db)) continue;
    db.exec(m.sql);
    db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, [String(m.version)]);
  }
  if (schemaVersion(db) < 4) ensureV4Columns(db);
  ensureV5Columns(db);
  ensureV6Columns(db);
  ensureV7Columns(db);
  ensureV8Tables(db);
  ensureV9Tables(db);
  ensureV10Tables(db);
  ensureV10Columns(db);
  backfillFlowClass(db);
  ensureFts(db);
  repairProposalsSchema(db);
}

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 2,
    sql: /* sql */ `
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS transactions_v2;
      CREATE TABLE transactions_v2 (
        id INTEGER PRIMARY KEY,
        sms_id INTEGER REFERENCES sms_raw(id),
        provider TEXT NOT NULL,
        ref TEXT,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount INTEGER NOT NULL,
        fee INTEGER,
        balance_after INTEGER,
        counterparty_id INTEGER REFERENCES counterparties(id),
        account TEXT,
        occurred_at INTEGER NOT NULL,
        template TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        chain_status TEXT NOT NULL DEFAULT 'unknown',
        chain_discrepancy INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'pending',
        episode_id INTEGER REFERENCES episodes(id),
        role TEXT NOT NULL DEFAULT 'transaction',
        event_ref TEXT,
        UNIQUE (sms_id)
      );
      INSERT INTO transactions_v2
        (id, sms_id, provider, ref, kind, direction, amount, fee, balance_after, counterparty_id,
         account, occurred_at, template, parser_version, chain_status, chain_discrepancy, scope, status, episode_id)
      SELECT id, sms_id, provider, ref, kind, direction, amount, fee, balance_after, counterparty_id,
             account, occurred_at, template, parser_version, chain_status, chain_discrepancy, scope, status, episode_id
        FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_v2 RENAME TO transactions;
      CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_tx_cp ON transactions(counterparty_id);
      CREATE INDEX IF NOT EXISTS idx_tx_event ON transactions(event_ref);
      DROP VIEW IF EXISTS tx_events;
      CREATE VIEW tx_events AS SELECT * FROM transactions WHERE role = 'transaction';
      UPDATE transactions SET role = 'funding_notice' WHERE template = 'mpesa.fuliza_draw';
      UPDATE transactions SET event_ref = 'ref:' || ref WHERE ref IS NOT NULL;
      UPDATE transactions SET role = 'bank_mirror'
       WHERE template LIKE 'equity.%' AND event_ref IS NOT NULL
         AND EXISTS (SELECT 1 FROM transactions m
                      WHERE m.provider = 'mpesa' AND m.event_ref = transactions.event_ref AND m.id <> transactions.id);
      PRAGMA foreign_keys = ON;
    `,
  },
  {
    version: 3,
    sql: SCHEMA_V3_SQL,
  },
  {
    version: 4,
    sql: SCHEMA_V4_SQL,
  },
  {
    version: 5,
    sql: SCHEMA_V5_SQL,
  },
  {
    version: 6,
    sql: SCHEMA_V6_SQL,
  },
  {
    version: 7,
    sql: "SELECT 1;", // flow_class column, view and backfill are applied by ensureV7Columns
  },
  {
    version: 8,
    sql: SCHEMA_V8_SQL, // additive tables only; ensureV8Tables re-applies idempotently
  },
  {
    version: 9,
    sql: SCHEMA_V9_SQL, // additive tables only; ensureV9Tables re-applies idempotently
  },
  {
    version: 10,
    sql: SCHEMA_V10_SQL, // tables only; columns are added tolerantly below
  },
];

/**
 * Idempotent seed of roles + labels (taxonomy is data; user-created ones never touched).
 * G4: parent labels ("Expenses", "Personal") must exist and child parent_id must be filled,
 * including on databases seeded by earlier versions.
 */
export function seedTaxonomy(db: DbAdapter, now = Date.now()): void {
  for (const l of SEED_LABELS) {
    const existing = db.get(`SELECT id, parent_id, status FROM labels WHERE name = ? LIMIT 1`, [l.name]);
    if (!existing) {
      const parent = l.parent ? db.get(`SELECT id FROM labels WHERE name = ? AND status = 'active' LIMIT 1`, [l.parent]) : null;
      db.run(`INSERT INTO labels (name, parent_id, created_at) VALUES (?, ?, ?)`, [l.name, parent?.id ?? null, now]);
      continue;
    }
    if (l.parent && existing.parent_id == null && existing.status === "active") {
      const parent = db.get(`SELECT id FROM labels WHERE name = ? AND status = 'active' LIMIT 1`, [l.parent]);
      if (parent) db.run(`UPDATE labels SET parent_id = ? WHERE id = ?`, [parent.id, existing.id]);
    }
  }
  for (const r of SEED_ROLES) {
    db.run(`INSERT OR IGNORE INTO roles (name, created_at) VALUES (?, ?)`, [r, now]);
  }
}
