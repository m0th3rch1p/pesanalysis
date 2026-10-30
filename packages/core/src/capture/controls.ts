/**
 * D109 capture controls: never ask about a counterparty, pause questions, quiet-hours policy,
 * and the opt-in "tell me about auto-filed payments". These are user controls, not scoring.
 */
import type { DbAdapter } from "../db/migrate.js";

export type QuietCapturePolicy = "ask_anyway" | "hold";

const META_PAUSE = "capture_pause_until";
const META_QUIET_POLICY = "quiet_capture_policy";
const META_TELL_AUTO = "tell_auto_filed";

export function suppressCounterparty(db: DbAdapter, counterpartyId: number, now = Date.now()): void {
  db.run(`INSERT OR IGNORE INTO ask_suppress (counterparty_id, created_at) VALUES (?, ?)`, [counterpartyId, now]);
  // Suppression is immediate: cancel the ladder for every still-open payment to this counterparty.
  db.run(
    `UPDATE capture_prompts SET resolved_at = COALESCE(resolved_at, ?), resolution = COALESCE(resolution, 'dismissed')
      WHERE resolved_at IS NULL AND tx_id IN (SELECT id FROM transactions WHERE counterparty_id = ?)`,
    [now, counterpartyId],
  );
}

export function unsuppressCounterparty(db: DbAdapter, counterpartyId: number): void {
  db.run(`DELETE FROM ask_suppress WHERE counterparty_id = ?`, [counterpartyId]);
}

export function isCounterpartySuppressed(db: DbAdapter, counterpartyId: number | null | undefined): boolean {
  if (counterpartyId == null) return false;
  return !!db.get(`SELECT 1 AS x FROM ask_suppress WHERE counterparty_id = ? LIMIT 1`, [counterpartyId]);
}

export function listSuppressedCounterparties(db: DbAdapter): Array<{ id: number; name: string }> {
  return db.all(
    `SELECT c.id, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name
       FROM ask_suppress s JOIN counterparties c ON c.id = s.counterparty_id
      ORDER BY c.display_name`,
  ).map((r: { id: number; name: string }) => ({ id: Number(r.id), name: String(r.name) }));
}

export function pauseCaptureUntil(db: DbAdapter, untilMs: number): void {
  db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [META_PAUSE, String(untilMs)]);
}

export function capturePausedUntil(db: DbAdapter): number | null {
  const row = db.get(`SELECT value FROM meta WHERE key = ?`, [META_PAUSE]) as { value?: string } | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resumeCapture(db: DbAdapter): void {
  db.run(`DELETE FROM meta WHERE key = ?`, [META_PAUSE]);
}

export function setQuietCapturePolicy(db: DbAdapter, policy: QuietCapturePolicy): void {
  db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [META_QUIET_POLICY, policy]);
}

export function getQuietCapturePolicy(db: DbAdapter): QuietCapturePolicy {
  const row = db.get(`SELECT value FROM meta WHERE key = ?`, [META_QUIET_POLICY]) as { value?: string } | undefined;
  return row?.value === "hold" ? "hold" : "ask_anyway";
}

export function setTellAutoFiled(db: DbAdapter, on: boolean): void {
  db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [META_TELL_AUTO, on ? "1" : "0"]);
}

export function tellAutoFiled(db: DbAdapter): boolean {
  const row = db.get(`SELECT value FROM meta WHERE key = ?`, [META_TELL_AUTO]) as { value?: string } | undefined;
  return row?.value === "1";
}
