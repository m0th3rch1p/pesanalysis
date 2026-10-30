/**
 * Encrypted gold-label restore pack (WS3.5). The laptop tool builds it from the private
 * export; the app decrypts it locally and matches canonical transactions by M-Pesa ref.
 * Idempotent: applying the same pack twice changes nothing.
 */
import type { DbAdapter } from "../db/migrate.js";
import { addTxItem, learnItemPricesForTx } from "../items/store.js";
import { reindexTx } from "../search/service.js";

export const LABEL_PACK_FORMAT = "pesanalysis-label-pack-v1";
export interface LabelPackEvent {
  ref: string;
  category: string;
  detail: string;
  items: string[];
  rawLabel: string;
  rawLabels: string[];
  fundingNoticeRef: string | null;
}
export interface LabelPack { format: string; schemaVersion: number; createdAt: number; events: LabelPackEvent[] }

const REF = /^[A-Z0-9]{6,32}$/;
const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;

export function decodeLabelPack(input: unknown, appSchemaVersion = 10): LabelPack {
  if (!input || typeof input !== "object") throw new Error("label pack is not an object");
  const o = input as Record<string, unknown>;
  if (o.format !== LABEL_PACK_FORMAT) throw new Error("not a Pesanalysis label pack");
  if (typeof o.schemaVersion !== "number" || !Number.isInteger(o.schemaVersion) || o.schemaVersion > appSchemaVersion) throw new Error("label pack is from a newer app");
  if (!Array.isArray(o.events) || o.events.length > 5000) throw new Error("bad event list");
  const events: LabelPackEvent[] = [];
  for (const raw of o.events) {
    if (!raw || typeof raw !== "object") throw new Error("bad event");
    const e = raw as Record<string, unknown>;
    if (!str(e.ref, 40) || !REF.test(e.ref)) continue; // refs are the only join key; skip malformed rows
    if (!str(e.category, 80) || !e.category.trim()) continue;
    events.push({
      ref: e.ref,
      category: e.category.trim(),
      detail: str(e.detail, 200) ? e.detail : "",
      items: Array.isArray(e.items) ? e.items.filter((x): x is string => str(x, 80) && !!x.trim()).slice(0, 20) : [],
      rawLabel: str(e.rawLabel, 200) ? e.rawLabel : e.category,
      rawLabels: Array.isArray(e.rawLabels) ? e.rawLabels.filter((x): x is string => str(x, 200)).slice(0, 20) : [],
      fundingNoticeRef: str(e.fundingNoticeRef, 40) && REF.test(e.fundingNoticeRef) ? e.fundingNoticeRef : null,
    });
  }
  return { format: LABEL_PACK_FORMAT, schemaVersion: Number(o.schemaVersion), createdAt: typeof o.createdAt === "number" ? o.createdAt : 0, events };
}

export interface LabelPackPreview {
  events: number; matched: number; notFound: number; labelsToCreate: number; items: number;
  conflicts: number; fundingLinks: number;
}
export interface LabelPackResult extends LabelPackPreview { labelsCreated: number; applied: number; notes: number }

function labelId(db: DbAdapter, name: string, now: number, dryRun: boolean): { id: number; created: boolean } {
  const row = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE LIMIT 1`, [name]) as { id?: number } | undefined;
  if (row?.id) return { id: Number(row.id), created: false };
  if (dryRun) return { id: -1, created: true };
  const r = db.run(`INSERT INTO labels (name, parent_id, is_custom, created_at) VALUES (?, NULL, 1, ?)`, [name, now]);
  const id = Number((r as { lastInsertRowid?: number | bigint; lastInsertRowId?: number | bigint } | undefined)?.lastInsertRowid
    ?? (r as { lastInsertRowId?: number } | undefined)?.lastInsertRowId ?? 0);
  return { id: id || Number((db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE`, [name]) as { id?: number } | undefined)?.id ?? 0), created: true };
}

/** Figma-style "dry run then apply" is one function so the counts cannot disagree. */
export function applyLabelPack(db: DbAdapter, pack: LabelPack, opts: { dryRun?: boolean; now?: number } = {}): LabelPackResult {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const out: LabelPackResult = { events: pack.events.length, matched: 0, notFound: 0, labelsToCreate: 0, labelsCreated: 0, items: 0, conflicts: 0, fundingLinks: 0, applied: 0, notes: 0 };
  const seenLabels = new Set<string>();
  for (const e of pack.events) {
    const tx = db.get(
      `SELECT id FROM transactions WHERE ref = ? AND role = 'transaction' ORDER BY id LIMIT 1`,
      [e.ref],
    ) as { id?: number } | undefined;
    if (!tx?.id) { out.notFound++; continue; }
    out.matched++;
    const txId = Number(tx.id);
    const lab = labelId(db, e.category, now, dryRun);
    if (lab.created && !seenLabels.has(e.category.toLowerCase())) { out.labelsToCreate++; seenLabels.add(e.category.toLowerCase()); }
    if (!dryRun && lab.created) out.labelsCreated++;

    const current = db.get(`SELECT label_id AS id FROM tx_labels WHERE tx_id = ? AND confirmed_at IS NOT NULL LIMIT 1`, [txId]) as { id?: number } | undefined;
    if (current?.id && current.id !== lab.id && !dryRun) out.conflicts++;

    if (!dryRun) {
      if (lab.id > 0) {
        db.run(`UPDATE tx_labels SET confirmed_at = NULL WHERE tx_id = ? AND label_id <> ?`, [txId, lab.id]);
        db.run(
          `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
           VALUES (?, ?, 'user', 1.0, ?, ?)
           ON CONFLICT(tx_id, label_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, source = 'user', confidence = 1.0`,
          [txId, lab.id, now, now],
        );
      }
      db.run(`UPDATE transactions SET status = 'confirmed' WHERE id = ?`, [txId]);
      const existingNote = db.get(`SELECT id FROM tx_notes WHERE tx_id = ? AND kind = 'text' AND text = ? LIMIT 1`, [txId, e.rawLabel]) as { id?: number } | undefined;
      if (!existingNote?.id) {
        db.run(`INSERT INTO tx_notes (tx_id, kind, text, created_at) VALUES (?, 'text', ?, ?)`, [txId, e.rawLabel, now]);
        out.notes++;
      }
      db.run(`DELETE FROM tx_items WHERE tx_id = ? AND source = 'gold'`, [txId]);
      for (const item of e.items) {
        addTxItem(db, txId, { item, source: "gold", confirmed: true }, now);
        out.items++;
      }
      learnItemPricesForTx(db, txId, now);
      if (e.fundingNoticeRef) {
        db.run(`UPDATE transactions SET event_ref = ? WHERE id = ?`, [e.fundingNoticeRef, txId]);
        out.fundingLinks++;
      }
      reindexTx(db, txId);
      out.applied++;
    } else {
      out.items += e.items.length;
      if (e.fundingNoticeRef) out.fundingLinks++;
    }
  }
  return out;
}
