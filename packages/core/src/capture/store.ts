/** Persistence for capture_prompts. */
import type { DbAdapter } from "../db/migrate.js";
import { detailCompleteness, type DetailFlags } from "./completeness.js";
import type { CaptureItem } from "./ladder.js";
import type { CaptureTier, PromptDecision } from "./materiality.js";

export function rowToItem(r: any): CaptureItem {
  return {
    txId: Number(r.tx_id), tier: r.tier as CaptureTier, materiality: Number(r.materiality), counterpartyKey: r.counterparty_key ?? null,
    amountCents: Number(r.amount_cents), createdAt: Number(r.created_at), stepsSent: Number(r.steps_sent),
    resolvedAt: r.resolved_at ?? null, snoozeUntil: r.snooze_until ?? null, lastPromptAt: r.last_prompt_at ?? null, staleEscalatedAt: r.stale_escalated_at ?? null,
  };
}

/** Idempotent per transaction: a second call never resets the ladder. Tier "none" is not stored. */
export function registerCapture(db: DbAdapter, tx: { id: number; amountCents: number; counterpartyKey: string | null; details: Partial<DetailFlags> }, d: PromptDecision, now: number): boolean {
  if (d.tier === "none") return false;
  const before = db.get(`SELECT id FROM capture_prompts WHERE tx_id = ?`, [tx.id]);
  if (before) return false;
  db.run(
    `INSERT INTO capture_prompts (tx_id, tier, materiality, reasons_json, counterparty_key, amount_cents, created_at, completeness) VALUES (?,?,?,?,?,?,?,?)`,
    [tx.id, d.tier, d.score, JSON.stringify(d.reasons), tx.counterpartyKey, tx.amountCents, now, detailCompleteness(tx.details).score],
  );
  return true;
}

export function listOpenCaptures(db: DbAdapter): CaptureItem[] {
  return db.all(`SELECT * FROM capture_prompts WHERE resolved_at IS NULL ORDER BY created_at, tx_id`).map(rowToItem);
}

export function recordPromptSent(db: DbAdapter, txId: number, stepsNowSent: number, now: number, stale = false): void {
  db.run(
    `UPDATE capture_prompts SET steps_sent = MAX(steps_sent, ?), last_prompt_at = ?, stale_escalated_at = CASE WHEN ? = 1 AND stale_escalated_at IS NULL THEN ? ELSE stale_escalated_at END WHERE tx_id = ?`,
    [stepsNowSent, now, stale ? 1 : 0, now, txId],
  );
}
export function markDigestSent(db: DbAdapter, txIds: number[], now: number): void {
  for (const id of txIds) db.run(`UPDATE capture_prompts SET last_prompt_at = ? WHERE tx_id = ?`, [now, id]);
}
export function snoozeCapture(db: DbAdapter, txId: number, untilMs: number): void {
  db.run(`UPDATE capture_prompts SET snooze_until = ? WHERE tx_id = ?`, [untilMs, txId]);
}
export function updateCompleteness(db: DbAdapter, txId: number, details: Partial<DetailFlags>): number {
  const c = detailCompleteness(details);
  db.run(`UPDATE capture_prompts SET completeness = MAX(completeness, ?) WHERE tx_id = ?`, [c.score, txId]);
  return c.score;
}
/** Resolution is explicit: 'submitted' only when the details actually qualify; otherwise the caller says 'done' or 'dismissed'. */
export function resolveCapture(db: DbAdapter, txId: number, how: "submitted" | "done" | "dismissed", now: number): void {
  db.run(`UPDATE capture_prompts SET resolved_at = COALESCE(resolved_at, ?), resolution = COALESCE(resolution, ?) WHERE tx_id = ?`, [now, how, txId]);
}
