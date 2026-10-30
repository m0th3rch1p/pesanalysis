/**
 * FTS5 index and search fallback. The index answers "what did I buy that had kale"
 * over notes/captions/labels/tags; amounts and dates are structured filters, never FTS.
 */
import type { DbAdapter } from "../db/migrate.js";
import { ftsAvailable, lastInsertId } from "../db/migrate.js";
import { resolveRange } from "../analyst/plan.js";
import type { ParsedSearch, SearchFilters } from "./types.js";

export interface SearchHit {
  id: number;
  occurredAt: number;
  amount: number;
  fee: number | null;
  direction: "in" | "out" | "neutral";
  kind: string;
  provider: string;
  status: string;
  scope: string;
  cpName: string | null;
  label: string | null;
  tags: string | null;
  note: string | null;
  attachments: number;
  thumbUri: string | null;
  thumbKind: string | null;
  /** total canonical events for this counterparty, used by the social feed ranking */
  cpCount: number;
  /** v6: grouped airtime purchase evidence, if any. */
  bundleId: number | null;
  bundleKind: string | null;
  bundlePaidCents: number | null;
  bundleReceivedCents: number | null;
  bundleHiddenFeeCents: number | null;
}

function hasFts(db: DbAdapter): boolean {
  try {
    return ftsAvailable(db) && !!db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='tx_fts'`);
  } catch {
    return false;
  }
}

/** FTS5 query: every token quoted (never inject operators), prefix match on the last token. */
export function buildFtsQuery(text: string): string {
  const tokens = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean);
  if (!tokens.length) return "";
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(" AND ");
}

export function reindexTx(db: DbAdapter, txId: number): void {
  if (!hasFts(db)) return;
  const row = db.get(
    `SELECT t.id, t.amount, t.fee, t.kind, t.provider, t.account, t.template, t.occurred_at,
            COALESCE(c.display_name, '') AS cp_display,
            COALESCE(c.raw_names, '[]') AS cp_raw,
            (SELECT GROUP_CONCAT(l.name, ' ') FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id) AS labels,
            (SELECT GROUP_CONCAT(tg.name, ' ') FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id) AS tags,
            (SELECT GROUP_CONCAT(n.text, ' ') FROM tx_notes n WHERE n.tx_id = t.id AND n.text IS NOT NULL) AS notes,
            (SELECT GROUP_CONCAT(a.caption, ' ') FROM attachments a WHERE a.tx_id = t.id AND a.caption IS NOT NULL) AS captions
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id WHERE t.id = ?`,
    [txId],
  );
  if (!row) {
    db.run(`DELETE FROM tx_fts WHERE tx_id = ?`, [txId]);
    return;
  }
  let raw = "";
  try { raw = (JSON.parse(row.cp_raw ?? "[]") as string[]).join(" "); } catch { raw = ""; }
  const kes = (Number(row.amount) / 100).toFixed(2);
  const day = new Date(Number(row.occurred_at)).toISOString().slice(0, 10);
  const body = [
    row.cp_display, raw, row.labels, row.tags, row.notes, row.captions,
    row.kind, row.provider, row.account, row.template, kes, day,
  ].filter(Boolean).join(" ");
  db.run(`DELETE FROM tx_fts WHERE tx_id = ?`, [txId]);
  db.run(`INSERT INTO tx_fts (tx_id, body) VALUES (?, ?)`, [txId, body]);
}

/**
 * Rebuild only when the index is missing rows or explicitly marked dirty. This is
 * the startup path: an unchanged ledger performs two COUNTs and zero writes.
 */
export function ensureSearchIndex(db: DbAdapter): number {
  if (!hasFts(db)) return 0;
  try {
    const indexed = Number((db.get(`SELECT COUNT(*) AS n FROM tx_fts`) as { n?: number } | undefined)?.n ?? 0);
    const events = Number((db.get(`SELECT COUNT(*) AS n FROM tx_events`) as { n?: number } | undefined)?.n ?? 0);
    const dirty = db.get(`SELECT value FROM meta WHERE key = 'search_index_dirty'`)?.value;
    if (indexed === events && dirty !== "1") return 0;
  } catch { /* fall through to rebuild */ }
  const n = rebuildSearchIndex(db);
  try { db.run(`INSERT INTO meta (key, value) VALUES ('search_index_dirty', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value`); } catch { /* optional */ }
  return n;
}

/** Mark the derived index stale after a bulk ingest, restore, or reset. */
export function markSearchIndexDirty(db: DbAdapter): void {
  try { db.run(`INSERT INTO meta (key, value) VALUES ('search_index_dirty', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`); } catch { /* optional */ }
}

/** Rebuild the whole index once (startup/migration). ~500 rows on the itel demo. */
export function rebuildSearchIndex(db: DbAdapter): number {
  if (!hasFts(db)) return 0;
  const rows = db.all(
    `SELECT t.id, t.amount, t.kind, t.provider, t.account, t.template, t.occurred_at,
            COALESCE(c.display_name, '') AS cp_display, COALESCE(c.raw_names, '[]') AS cp_raw,
            (SELECT GROUP_CONCAT(l.name, ' ') FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id) AS labels,
            (SELECT GROUP_CONCAT(tg.name, ' ') FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id) AS tags,
            (SELECT GROUP_CONCAT(n.text, ' ') FROM tx_notes n WHERE n.tx_id = t.id AND n.text IS NOT NULL) AS notes,
            (SELECT GROUP_CONCAT(a.caption, ' ') FROM attachments a WHERE a.tx_id = t.id AND a.caption IS NOT NULL) AS captions
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id`,
  );
  db.exec("DELETE FROM tx_fts");
  for (const row of rows) {
    let raw = "";
    try { raw = (JSON.parse(row.cp_raw ?? "[]") as string[]).join(" "); } catch { raw = ""; }
    const body = [
      row.cp_display, raw, row.labels, row.tags, row.notes, row.captions,
      row.kind, row.provider, row.account, row.template,
      (Number(row.amount) / 100).toFixed(2), new Date(Number(row.occurred_at)).toISOString().slice(0, 10),
    ].filter(Boolean).join(" ");
    db.run(`INSERT INTO tx_fts (tx_id, body) VALUES (?, ?)`, [row.id, body]);
  }
  return rows.length;
}

export function searchTransactions(db: DbAdapter, parsed: ParsedSearch, now = Date.now(), limit = 100): SearchHit[] {
  const f: SearchFilters = parsed.filters;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.time) {
    const r = resolveRange(f.time, now);
    where.push("t.occurred_at >= ?", "t.occurred_at < ?");
    params.push(r.from, r.to);
  }
  if (f.direction && f.direction !== "any") { where.push("t.direction = ?"); params.push(f.direction); }
  if (f.minAmountCents != null) { where.push("t.amount >= ?"); params.push(f.minAmountCents); }
  if (f.maxAmountCents != null) { where.push("t.amount <= ?"); params.push(f.maxAmountCents); }
  if (f.labels?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND l.name COLLATE NOCASE IN (${f.labels.map(() => "?").join(",")}))`);
    params.push(...f.labels);
  }
  if (f.tags?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.name COLLATE NOCASE IN (${f.tags.map(() => "?").join(",")}))`);
    params.push(...f.tags);
  }
  if (f.ventures?.length) {
    where.push(`EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.kind = 'venture' AND tg.name COLLATE NOCASE IN (${f.ventures.map(() => "?").join(",")}))`);
    params.push(...f.ventures);
  }
  if (f.counterparties?.length) {
    where.push(`(${f.counterparties.map(() => `COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) LIKE ?`).join(" OR ")})`);
    params.push(...f.counterparties.map((x) => `%${x}%`));
  }
  if (f.place) {
    where.push(`EXISTS (SELECT 1 FROM tx_context ctx JOIN places p ON p.id = ctx.place_id WHERE ctx.tx_id = t.id AND p.name LIKE ?)`);
    params.push(`%${f.place}%`);
  }
  if (parsed.fts) {
    if (hasFts(db)) {
      where.push(`t.id IN (SELECT tx_id FROM tx_fts WHERE tx_fts MATCH ?)`);
      params.push(buildFtsQuery(parsed.fts));
    } else {
      const q = `%${parsed.fts}%`;
      where.push(`(
        COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') LIKE ? OR
        t.template LIKE ? OR
        EXISTS (SELECT 1 FROM tx_notes n WHERE n.tx_id = t.id AND n.text LIKE ?) OR
        EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND l.name LIKE ?) OR
        EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.name LIKE ?)
      )`);
      params.push(q, q, q, q, q);
    }
  }
  const sql = `SELECT t.id, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind, t.provider,
                      t.status, t.scope,
                      COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName,
                      (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
                        WHERE tl.tx_id = t.id ORDER BY (tl.confirmed_at IS NOT NULL) DESC, tl.confidence DESC LIMIT 1) AS label,
                      (SELECT GROUP_CONCAT(tg.name, ', ') FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id) AS tags,
                      (SELECT n.text FROM tx_notes n WHERE n.tx_id = t.id AND n.text IS NOT NULL
                        ORDER BY (n.kind = 'note') DESC, n.created_at DESC LIMIT 1) AS note,
                      (SELECT COUNT(*) FROM attachments a WHERE a.tx_id = t.id) AS attachments,
                      (SELECT a.uri FROM attachments a WHERE a.tx_id = t.id
                        ORDER BY CASE a.kind WHEN 'photo' THEN 0 WHEN 'video' THEN 1 ELSE 2 END, a.created_at LIMIT 1) AS thumbUri,
                      (SELECT a.kind FROM attachments a WHERE a.tx_id = t.id
                        ORDER BY CASE a.kind WHEN 'photo' THEN 0 WHEN 'video' THEN 1 ELSE 2 END, a.created_at LIMIT 1) AS thumbKind,
                      t.bundle_id AS bundleId, b.kind AS bundleKind, b.paid_cents AS bundlePaidCents,
                      b.received_cents AS bundleReceivedCents, b.hidden_fee_cents AS bundleHiddenFeeCents,
                      (SELECT COUNT(*) FROM tx_events x WHERE x.counterparty_id = t.counterparty_id) AS cpCount
                 FROM tx_events t
                 LEFT JOIN counterparties c ON c.id = t.counterparty_id
                 LEFT JOIN tx_bundles b ON b.id = t.bundle_id
                ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY t.occurred_at DESC LIMIT ?`;
  const rows = db.all(sql, [...params, limit]) as SearchHit[];
  return rows.map((r) => ({
    ...r, direction: r.direction as SearchHit["direction"], attachments: Number(r.attachments ?? 0),
    cpCount: Number(r.cpCount ?? 0),
    bundleId: r.bundleId == null ? null : Number(r.bundleId),
    bundlePaidCents: r.bundlePaidCents == null ? null : Number(r.bundlePaidCents),
    bundleReceivedCents: r.bundleReceivedCents == null ? null : Number(r.bundleReceivedCents),
    bundleHiddenFeeCents: r.bundleHiddenFeeCents == null ? null : Number(r.bundleHiddenFeeCents),
  }));
}

/** Save a note/media caption and keep the index in sync. */
export function addNote(db: DbAdapter, txId: number, kind: string, text: string | null, uri: string | null, now = Date.now()): number {
  const r = db.run(`INSERT INTO tx_notes (tx_id, kind, text, uri, created_at) VALUES (?, ?, ?, ?, ?)`, [txId, kind, text, uri, now]);
  reindexTx(db, txId);
  return lastInsertId(r);
}
