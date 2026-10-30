/**
 * Data lifecycle: G3 reset completeness, G5 note-kind normalisation, G8 SMS-body retention.
 * All destructive operations list every table explicitly; tests assert new tables are covered.
 */
import { lastInsertId, type DbAdapter } from "./migrate.js";
import { SCHEMA_VERSION } from "./schema.js";

export const NOTE_KINDS = ["note", "tag", "voice", "photo", "video", "document"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Old rows used `description`/`text`; normalise at every write and during reset/reindex. */
export function normalizeNoteKind(kind: string | null | undefined): NoteKind {
  const k = (kind ?? "").trim().toLowerCase();
  if (k === "description" || k === "text" || k === "caption") return "note";
  if ((NOTE_KINDS as readonly string[]).includes(k)) return k as NoteKind;
  return "note";
}

/** Order matters: children before parents. Keep in sync with schema v4 and the test. */
export const RESET_TABLES = [
  "assistant_audit", "pack_history", "assistant_state",
  "model_proposals", "model_candidates", "journal_checks", "journal_entries", "capture_prompts", "alert_prefs", "alerts_log",
  "messages", "conversations", "questions", "analyses", "facts", "experiments",
  "expected_occurrences", "expected_flows", "savings_goals", "savings_locations", "budgets",
  "debt_links", "debts", "tx_bundles", "entity_merge_candidates",
  "tx_items", "item_prices", "items", "item_groups", "habits", "goal_plans", "ask_suppress",
  "tx_tags", "attachments", "tag_rules", "ventures", "tags",
  "products", "security_alerts", "entity_links", "custom_templates", "accounts",
  "tx_notes", "tx_context", "tx_labels", "transactions", "counterparties",
  "labels", "roles",
  "places", "episodes", "findings", "proposals", "sessions", "goals",
  "hosts", "tool_audit", "airlock_monthly", "airlock_categories", "airlock_meta",
  "tx_fts", "sms_raw", "profile", "meta",
] as const;

/**
 * Wipes all user data but preserves the schema and the SQLCipher key (the file stays decryptable).
 * meta is rebuilt with only schema_version; the next start reseeds taxonomy and settings.
 */
/** Deletes every user table row. No transaction handling: the caller owns atomicity (staged restore). */
export function clearUserTables(db: DbAdapter): void {
  for (const t of RESET_TABLES) {
    try { db.exec(`DELETE FROM ${t};`); } catch { /* table may not exist on old DBs */ }
  }
}

export function resetAllData(db: DbAdapter): void {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  try {
    for (const t of RESET_TABLES) {
      try { db.exec(`DELETE FROM ${t};`); } catch { /* table may not exist on old DBs */ }
    }
    db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
    db.exec("COMMIT; PRAGMA foreign_keys = ON;");
  } catch (e) {
    db.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw e;
  }
}

export const RETENTION_KEY = "retention_sms_days";
export const DEFAULT_RETENTION_DAYS = 0;

export function getRetentionDays(db: DbAdapter): number {
  const row = db.get(`SELECT value FROM meta WHERE key = ?`, [RETENTION_KEY]);
  const n = Number(row?.value ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function setRetentionDays(db: DbAdapter, days: number, now = Date.now()): void {
  const n = Math.max(0, Math.floor(days));
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RETENTION_KEY, String(n)],
  );
  if (n > 0) purgeSmsBodies(db, n, now);
}

/**
 * G8: raw SMS bodies are the most sensitive text on the phone. Once a transaction is parsed,
 * the body is only needed for re-parsing. Retention purges it after N days while keeping the
 * row (sender/time/hash) so dedupe still works. 0 = never purge (default; explicit user choice).
 */
export function purgeSmsBodies(db: DbAdapter, days: number, now = Date.now()): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - Math.floor(days) * 86_400_000;
  const before = db.get(`SELECT COUNT(*) AS n FROM sms_raw WHERE received_at < ? AND purged_at IS NULL AND body <> ''`, [cutoff]);
  db.run(
    `UPDATE sms_raw SET body = '', purged_at = ? WHERE received_at < ? AND purged_at IS NULL AND body <> ''`,
    [now, cutoff],
  );
  return Number(before?.n ?? 0);
}

/**
 * Repair rows written by the lastInsertRowid/lastInsertRowId portability bug: ventures could
 * point at tag_id 0. Keep the venture if its name matches a tag; never silently drop a name
 * that has no tag (create one). Idempotent; safe to run on every open.
 */
export function repairDataIntegrity(db: DbAdapter, now = Date.now()): number {
  let repaired = 0;
  const bad = db.all(
    `SELECT v.id, v.name, v.kind, v.tag_id AS tagId FROM ventures v
      WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = v.tag_id)`,
  ) as Array<{ id: number; name: string; kind: string; tagId: number }>;
  for (const v of bad) {
    let tag = db.get(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`, [v.name]);
    if (!tag) {
      const r = db.run(`INSERT INTO tags (name, kind, created_at) VALUES (?, 'venture', ?)`, [v.name, now]);
      const id = lastInsertId(r);
      tag = id ? { id } : db.get(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`, [v.name]);
    }
    if (!tag) continue;
    const clash = db.get(`SELECT id FROM ventures WHERE tag_id = ? AND id <> ?`, [tag.id, v.id]);
    if (clash) {
      // The valid venture already represents this tag; remove the orphan row only.
      db.run(`DELETE FROM ventures WHERE id = ?`, [v.id]);
    } else {
      db.run(`UPDATE ventures SET tag_id = ? WHERE id = ?`, [tag.id, v.id]);
      db.run(`UPDATE tags SET kind = 'venture' WHERE id = ?`, [tag.id]);
    }
    repaired++;
  }
  // Normalise any legacy note kinds left by older builds.
  db.run(`UPDATE tx_notes SET kind = 'note' WHERE kind IN ('description', 'text', 'caption')`);
  return repaired;
}
