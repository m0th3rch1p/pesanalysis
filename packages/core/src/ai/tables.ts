/** Idempotent DDL for the on-device model queue (F2). Created on every migrate; no schema-version bump needed. */
import type { DbAdapter } from "../db/migrate.js";

export const MODEL_TABLES = ["model_proposals", "model_candidates"] as const;

export function ensureModelTables(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_candidates (
      sms_id INTEGER PRIMARY KEY,
      sender TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | classified | proposed | rejected | skipped
      reason TEXT,
      detail TEXT,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_model_cand_status ON model_candidates(status, received_at);
    CREATE TABLE IF NOT EXISTS model_proposals (
      id INTEGER PRIMARY KEY,
      sms_id INTEGER NOT NULL,
      tx_id INTEGER,
      classification TEXT,
      fields TEXT,
      reasons TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_prop_sms ON model_proposals(sms_id);
  `);
}
