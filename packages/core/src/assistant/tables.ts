/**
 * Assistant connection tables (docs/plan/09). Created idempotently so this module never has to
 * bump SCHEMA_VERSION: `migrate()` calls `ensureAssistantTables(db)` on every run.
 *
 *  - assistant_audit : one row per outbound call attempt (I-11). Metadata always; the exact
 *                      payload text is retained locally for the user to inspect, and wiped by the
 *                      kill switch (I-12) or by `deleteAudit`.
 *  - pack_history    : versioned, content-hashed personalization changes with full before/after
 *                      snapshots so rollback is exact (I-8).
 *  - assistant_state : small key/value store (kill switch, current personalization state).
 *
 * No API key, no ledger row, no SMS text is ever written here.
 */
import type { DbAdapter } from "../db/migrate.js";

export const ASSISTANT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS assistant_audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL,                 -- ask | personalize | test
  purpose TEXT NOT NULL,
  session_id TEXT,
  payload_hash TEXT NOT NULL,         -- sha256 of the exact request body
  bytes_out INTEGER NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  field_list TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,               -- pending | ok | error | blocked
  detail TEXT,                        -- short machine reason; never a body, never a secret
  validation TEXT,                    -- accepted | rejected:<reason>
  tokens INTEGER NOT NULL DEFAULT 0,
  payload_text TEXT                   -- exact request body, local only, wiped by kill switch / deleteAudit
);
CREATE INDEX IF NOT EXISTS idx_assistant_audit_at ON assistant_audit(at);

CREATE TABLE IF NOT EXISTS pack_history (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  parent_hash TEXT,                   -- hash of the state this pack was applied to
  title TEXT NOT NULL,
  pack_json TEXT NOT NULL,
  state_before TEXT NOT NULL,
  state_after TEXT NOT NULL,
  summary TEXT NOT NULL,              -- plain-language diff the user confirmed
  applied_at INTEGER NOT NULL,
  rolled_back_at INTEGER
);

CREATE TABLE IF NOT EXISTS assistant_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function ensureAssistantTables(db: DbAdapter): void {
  db.exec(ASSISTANT_TABLES_SQL);
}

export function getAssistantState(db: DbAdapter, key: string): string | null {
  const r = db.get(`SELECT value FROM assistant_state WHERE key = ?`, [key]);
  return r ? String(r.value) : null;
}

export function setAssistantState(db: DbAdapter, key: string, value: string, now = Date.now()): void {
  db.run(
    `INSERT INTO assistant_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}
