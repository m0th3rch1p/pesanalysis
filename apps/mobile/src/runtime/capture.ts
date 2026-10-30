import type { SQLiteDatabase } from "expo-sqlite";
import { addTxItem, confirmTxItems, inferItems, listTxItems } from "@yako/core";
import {
  decidePrompt, detailCompleteness, expectedFee, formatKes, getAlertPrefs, listOpenCaptures, recordPromptSent,
  registerCapture, resolveCapture, tariffKindOf, updateCompleteness, markDigestSent, reindexTx,
  capturePausedUntil, getQuietCapturePolicy, isCounterpartySuppressed, learnItemPricesForTx, tellAutoFiled,
  type CaptureItem, type CaptureTx, type DetailFlags, type IngestActions, type PromptDecision,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { bump } from "./obs";

/** Only brand-new transactions get a ladder. Backfilled history must never produce a burst of prompts. */
export const FRESH_MS = 12 * 3_600_000;

/** Which detail fields each transaction already has, in one grouped query set. */
export function detailFlagsFor(db: SQLiteDatabase, txIds: number[]): Map<number, DetailFlags> {
  const out = new Map<number, DetailFlags>();
  if (!txIds.length) return out;
  const ph = txIds.map(() => "?").join(",");
  const base = (): DetailFlags => ({ label: false, note: false, tag: false, photo: false, voice: false, place: false, counterpartyRole: false });
  for (const id of txIds) out.set(id, base());
  const set = (id: number, k: keyof DetailFlags) => { const f = out.get(id); if (f) f[k] = true; };
  for (const r of db.getAllSync<{ id: number }>(`SELECT id FROM transactions WHERE id IN (${ph}) AND status IN ('confirmed','edited')`, txIds)) set(r.id, "label");
  for (const r of db.getAllSync<{ id: number }>(`SELECT DISTINCT tx_id AS id FROM tx_labels WHERE tx_id IN (${ph}) AND confirmed_at IS NOT NULL`, txIds)) set(r.id, "label");
  for (const r of db.getAllSync<{ id: number; k: string }>(`SELECT DISTINCT tx_id AS id, kind AS k FROM tx_notes WHERE tx_id IN (${ph}) AND (text IS NOT NULL AND text <> '' OR uri IS NOT NULL)`, txIds)) {
    if (r.k === "note" || r.k === "text") set(r.id, "note");
    else if (r.k === "tag") set(r.id, "tag");
    else if (r.k === "voice") set(r.id, "voice");
    else if (r.k === "photo") set(r.id, "photo");
  }
  for (const r of db.getAllSync<{ id: number }>(`SELECT DISTINCT tx_id AS id FROM tx_tags WHERE tx_id IN (${ph})`, txIds)) set(r.id, "tag");
  for (const r of db.getAllSync<{ id: number; k: string }>(`SELECT DISTINCT tx_id AS id, kind AS k FROM attachments WHERE tx_id IN (${ph})`, txIds)) {
    if (r.k === "photo") set(r.id, "photo"); else if (r.k === "voice") set(r.id, "voice");
  }
  for (const r of db.getAllSync<{ id: number }>(`SELECT id FROM transactions WHERE id IN (${ph}) AND counterparty_id IN (SELECT id FROM counterparties WHERE role_id IS NOT NULL)`, txIds)) set(r.id, "counterpartyRole");
  return out;
}

function captureTx(db: SQLiteDatabase, a: IngestActions, flags: DetailFlags): CaptureTx | null {
  const t = db.getFirstSync<{
    id: number; amount: number; fee: number | null; direction: string; occurred_at: number; counterparty_id: number | null; scope: string; status: string;
    kind: string; template: string; cp_key: string | null; cp_name: string | null; label_id: number | null; label_src: string | null; label_conf: number | null;
  }>(
    `SELECT t.id, t.amount, t.fee, t.direction, t.occurred_at, t.counterparty_id, t.scope, t.status, t.kind, t.template,
            c.key AS cp_key, c.display_name AS cp_name,
            tl.label_id AS label_id, tl.source AS label_src, tl.confidence AS label_conf
       FROM transactions t
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id ORDER BY (x.confirmed_at IS NULL), x.confidence DESC LIMIT 1)
      WHERE t.id = ?`, [a.txId]);
  if (!t) return null;
  const prior = t.counterparty_id == null ? 0 : (db.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM transactions WHERE counterparty_id = ? AND role = 'transaction' AND id < ?`, [t.counterparty_id, t.id])?.n ?? 0);
  const confirmed = t.status === "confirmed" || t.status === "edited";
  const tk = tariffKindOf({ kind: t.kind as never, template: t.template, counterpartyName: t.cp_name });
  return {
    id: t.id, amountCents: t.amount, feeCents: t.fee ?? 0, direction: t.direction === "in" ? "in" : "out", occurredAt: t.occurred_at,
    counterpartyKey: t.cp_key, counterpartyPriorCount: prior, labelId: t.label_id,
    labelConfidence: confirmed ? 1 : (t.label_conf ?? 0), labelSource: confirmed ? "user" : t.label_id != null ? "auto" : "none",
    businessProb: t.scope === "business" ? 1 : t.scope === "mixed" ? 0.5 : 0,
    expectedFeeCents: tk ? expectedFee(tk, t.amount, t.occurred_at) : null, details: flags,
  };
}

export interface NewCapture { action: IngestActions; decision: PromptDecision }

/**
 * Decide the tier for each fresh transaction and persist it (idempotent per tx: a second call never resets the ladder).
 * Returns the ones whose first prompt is due right now; deferred/batched ones are picked up by the scheduler.
 */
export function registerNewCaptures(db: SQLiteDatabase, actions: IngestActions[], now = Date.now()): NewCapture[] {
  const fresh = actions.filter((a) => a.notify !== "silent" && a.txId > 0 && !a.duplicate && now - a.occurredAt < FRESH_MS && a.occurredAt <= now + 5 * 60_000);
  if (!fresh.length) return [];
  const adapter = asDbAdapter(db);
  const prefs = getAlertPrefs(adapter);
  const flags = detailFlagsFor(db, fresh.map((a) => a.txId));
  const history = db.getAllSync<{ a: number }>(
    `SELECT amount AS a FROM tx_events WHERE direction = 'out' AND flow_class = 'spend' AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 400`, [now - 120 * 86_400_000],
  ).map((r) => r.a);
  const paused = capturePausedUntil(adapter);
  const quietPolicy = getQuietCapturePolicy(adapter);
  const autoTell = tellAutoFiled(adapter);
  const due: NewCapture[] = [];
  for (const a of fresh) {
    const tx = captureTx(db, a, flags.get(a.txId)!);
    if (!tx) continue;
    // "Never ask about this counterparty" wins over everything.
    const cpId = db.getFirstSync<{ cp: number | null }>(`SELECT counterparty_id AS cp FROM transactions WHERE id = ?`, [a.txId])?.cp ?? null;
    if (isCounterpartySuppressed(adapter, Number(cpId))) continue;
    // Auto-filed payments stay silent unless the user asked to hear about them.
    if (a.notify === "auto" && !autoTell) continue;
    // Propose item detail for shops with learned prices. Never confirms; the sheet shows chips.
    try {
      if (tx.counterpartyKey && !listTxItems(adapter, tx.id).length) {
        const cand = inferItems(adapter, { id: tx.id, counterpartyId: cpId == null ? null : Number(cpId), amountCents: tx.amountCents })[0];
        if (cand) {
          for (const it of cand.items) {
            addTxItem(adapter, tx.id, { itemId: it.itemId, qty: it.qty, amountCents: it.amountCents, source: "inferred", confidence: cand.confidence, confirmed: false }, now);
          }
        }
      }
    } catch { /* inference is optional */ }
    let d = decidePrompt(tx, history, now, { quiet: prefs.quiet, quietPolicy });
    if (paused != null && paused > now && d.action !== "none") {
      d = { ...d, action: "defer", promptAtMs: paused };
    }
    if (registerCapture(adapter, { id: tx.id, amountCents: tx.amountCents, counterpartyKey: tx.counterpartyKey, details: tx.details }, d, now)) {
      bump(db, "capture_registered");
      if (d.action === "prompt_now") due.push({ action: a, decision: d });
    }
  }
  return due;
}

/** Marks the first prompt as sent so the ladder continues from step 2. */
export function markFirstSent(db: SQLiteDatabase, txId: number, now = Date.now()): void {
  recordPromptSent(asDbAdapter(db), txId, 1, now);
}

/**
 * Re-derives completeness for every open item and closes the ones that now qualify as "properly submitted"
 * (category + note/tag/photo/voice). Resolution therefore never depends on which screen added the detail.
 * Returns the ids resolved this pass (the caller cancels their scheduled reminders).
 */
export function syncCaptureState(db: SQLiteDatabase, now = Date.now()): { open: CaptureItem[]; resolved: number[] } {
  const adapter = asDbAdapter(db);
  const open = listOpenCaptures(adapter);
  if (!open.length) return { open, resolved: [] };
  const flags = detailFlagsFor(db, open.map((i) => i.txId));
  const resolved: number[] = [];
  for (const it of open) {
    const f = flags.get(it.txId);
    if (!f) continue;
    const c = detailCompleteness(f);
    updateCompleteness(adapter, it.txId, f);
    if (c.submitted) { resolveCapture(adapter, it.txId, "submitted", now); resolved.push(it.txId); bump(db, "capture_resolved"); }
  }
  return { open: open.filter((i) => !resolved.includes(i.txId)), resolved };
}

/** User says "done" without more detail (explicit, never inferred). */
export function markCaptureDone(db: SQLiteDatabase, txId: number, now = Date.now()): void {
  resolveCapture(asDbAdapter(db), txId, "done", now);
  bump(db, "capture_resolved");
}

export function markDigestShown(db: SQLiteDatabase, txIds: number[], now = Date.now()): void {
  markDigestSent(asDbAdapter(db), txIds, now);
}

/** How often this counterparty's confirmed labels agreed with the proposed one (for "seen 9 of 9"). */
export function suggestionEvidence(db: SQLiteDatabase, txId: number, label: string): { seen: number; total: number } {
  try {
    const row = db.getFirstSync<{ seen: number; total: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN l.name = ? THEN 1 ELSE 0 END) AS seen
         FROM tx_labels tl JOIN labels l ON l.id = tl.label_id JOIN transactions t ON t.id = tl.tx_id
        WHERE tl.confirmed_at IS NOT NULL AND t.role = 'transaction'
          AND t.counterparty_id = (SELECT counterparty_id FROM transactions WHERE id = ?)`,
      [label, txId],
    );
    return { seen: Number(row?.seen ?? 0), total: Number(row?.total ?? 0) };
  } catch { return { seen: 0, total: 0 }; }
}

/** Headless "yes, the guess is right": confirm the top unconfirmed suggestion. */
export function confirmSuggestedLabel(db: SQLiteDatabase, txId: number, now = Date.now()): { ok: boolean; label: string | null } {
  try {
    const row = db.getFirstSync<{ labelId: number; label: string }>(
      `SELECT tl.label_id AS labelId, l.name AS label
         FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
        WHERE tl.tx_id = ? AND tl.confirmed_at IS NULL AND l.status = 'active'
        ORDER BY COALESCE(tl.confidence, 0) DESC, tl.label_id LIMIT 1`,
      [txId],
    );
    if (!row) return { ok: false, label: null };
    db.runSync(`UPDATE tx_labels SET confirmed_at = ?, source = 'user', confidence = 1 WHERE tx_id = ? AND label_id = ?`, [now, txId, row.labelId]);
    db.runSync(`UPDATE tx_labels SET confirmed_at = NULL WHERE tx_id = ? AND label_id <> ? AND confirmed_at IS NULL`, [txId, row.labelId]);
    db.runSync(`UPDATE transactions SET status = 'confirmed' WHERE id = ?`, [txId]);
    reindexTx(asDbAdapter(db), txId);
    return { ok: true, label: row.label };
  } catch { return { ok: false, label: null }; }
}

/** Specific text for a transaction, used only when the user allows details on the lock screen. */
export function txTitle(db: SQLiteDatabase, txId: number): string | null {
  const r = db.getFirstSync<{ amount: number; direction: string; kind: string; display: string | null; raw: string | null }>(
    `SELECT t.amount, t.direction, t.kind, c.display_name AS display, c.raw_names AS raw FROM transactions t LEFT JOIN counterparties c ON c.id = t.counterparty_id WHERE t.id = ?`, [txId]);
  if (!r) return null;
  let name = r.display ?? "";
  if (!name && r.raw) { try { name = (JSON.parse(r.raw) as string[])[0] ?? ""; } catch { /* no name */ } }
  const verb = r.direction === "in" ? "received from" : "paid to";
  return `${formatKes(r.amount)} ${name ? `${verb} ${name}` : r.direction === "in" ? "received" : "paid"}`;
}
