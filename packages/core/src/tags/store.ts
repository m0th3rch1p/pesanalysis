/**
 * Tags and ventures. A venture IS a tag with a P&L identity, so one mechanism serves
 * "tag this payment" and "track this business/project" without a second taxonomy.
 * Tags are never deleted: merge/archive keep history and idempotence.
 */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";
import { formatKes } from "../sms/money.js";
import { reindexTx } from "../search/service.js";
import type { TagProposal, VenturePnL } from "./types.js";

export interface TagRow {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  parentId: number | null;
  status: string;
  mergedInto: number | null;
  txCount: number;
  totalCents: number;
  ventureKind: string | null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

export function findTag(db: DbAdapter, name: string): TagRow | null {
  const row = db.get(
    `SELECT id, name, kind, color, parent_id AS parentId, status, merged_into AS mergedInto,
            (SELECT COUNT(*) FROM tx_tags tt WHERE tt.tag_id = tags.id) AS txCount,
            (SELECT COALESCE(SUM(t.amount), 0) FROM tx_tags tt JOIN tx_events t ON t.id = tt.tx_id WHERE tt.tag_id = tags.id) AS totalCents,
            (SELECT v.kind FROM ventures v WHERE v.tag_id = tags.id) AS ventureKind
       FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`,
    [norm(name)],
  );
  if (!row) return null;
  if (row.status === "merged" && row.mergedInto) return findTagById(db, Number(row.mergedInto));
  return row;
}

export function findTagById(db: DbAdapter, id: number): TagRow | null {
  const row = db.get(
    `SELECT id, name, kind, color, parent_id AS parentId, status, merged_into AS mergedInto,
            (SELECT COUNT(*) FROM tx_tags tt WHERE tt.tag_id = tags.id) AS txCount,
            (SELECT COALESCE(SUM(t.amount), 0) FROM tx_tags tt JOIN tx_events t ON t.id = tt.tx_id WHERE tt.tag_id = tags.id) AS totalCents,
            (SELECT v.kind FROM ventures v WHERE v.tag_id = tags.id) AS ventureKind
       FROM tags WHERE id = ?`,
    [id],
  );
  return row ?? null;
}

export function createTag(db: DbAdapter, name: string, kind: "user" | "suggested" | "auto" | "venture" = "user", color?: string): number {
  const clean = norm(name);
  if (!clean) throw new Error("tag name is empty");
  const existing = findTag(db, clean);
  if (existing && existing.status === "active") return existing.id;
  const r = db.run(`INSERT INTO tags (name, kind, color, created_at) VALUES (?, ?, ?, ?)`, [clean, kind, color ?? null, Date.now()]);
  const id = lastInsertId(r);
  if (id) return id;
  // Some adapters do not expose an insert id; read back by the natural key.
  return Number(db.get(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1`, [clean])?.id ?? 0);
}

export function renameTag(db: DbAdapter, tagId: number, name: string): void {
  db.run(`UPDATE tags SET name = ? WHERE id = ?`, [norm(name), tagId]);
}

export function archiveTag(db: DbAdapter, tagId: number): void {
  db.run(`UPDATE tags SET status = 'archived' WHERE id = ?`, [tagId]);
}

/** Merge keeps the source row as a tombstone and re-points every reference. */
export function mergeTags(db: DbAdapter, fromId: number, intoId: number): void {
  if (fromId === intoId) return;
  const target = db.get(`SELECT id FROM tags WHERE id = ? AND status = 'active'`, [intoId]);
  if (!target) throw new Error("merge target is not an active tag");
  const links = db.all(`SELECT tx_id, source, confidence, created_at FROM tx_tags WHERE tag_id = ?`, [fromId]);
  for (const l of links) {
    db.run(
      `INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, ?, ?, ?)`,
      [l.tx_id, intoId, l.source, l.confidence, l.created_at],
    );
  }
  db.run(`DELETE FROM tx_tags WHERE tag_id = ?`, [fromId]);
  db.run(`UPDATE tag_rules SET tag_id = ? WHERE tag_id = ?`, [intoId, fromId]);
  db.run(`UPDATE tags SET status = 'merged', merged_into = ? WHERE id = ?`, [intoId, fromId]);
  for (const l of links) reindexTx(db, Number(l.tx_id));
}

export function createVenture(db: DbAdapter, name: string, kind = "project", notes?: string): { tagId: number; ventureId: number } {
  const clean = norm(name);
  const existing = findTag(db, clean);
  const tagId = existing?.status === "active" ? existing.id : createTag(db, clean, "venture");
  db.run(`UPDATE tags SET kind = 'venture' WHERE id = ?`, [tagId]);
  const v = db.get(`SELECT id FROM ventures WHERE tag_id = ?`, [tagId]);
  if (v) return { tagId, ventureId: Number(v.id) };
  const r = db.run(
    `INSERT INTO ventures (name, kind, tag_id, status, opened_at, notes) VALUES (?, ?, ?, 'active', ?, ?)`,
    [clean, kind, tagId, Date.now(), notes ?? null],
  );
  const id = lastInsertId(r);
  const ventureId = id || Number(db.get(`SELECT id FROM ventures WHERE tag_id = ?`, [tagId])?.id ?? 0);
  return { tagId, ventureId };
}

export function tagTx(db: DbAdapter, txId: number, tagName: string, source: "user" | "rule" | "cluster" | "llm" = "user", confidence?: number): number {
  const tagId = createTag(db, tagName, source === "user" ? "user" : "suggested");
  db.run(
    `INSERT INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tx_id, tag_id) DO UPDATE SET source = excluded.source, confidence = excluded.confidence`,
    [txId, tagId, source, confidence ?? (source === "user" ? 1 : null), Date.now()],
  );
  reindexTx(db, txId);
  return tagId;
}

export function untagTx(db: DbAdapter, txId: number, tagId: number): void {
  db.run(`DELETE FROM tx_tags WHERE tx_id = ? AND tag_id = ?`, [txId, tagId]);
  reindexTx(db, txId);
}

export function tagsForTx(db: DbAdapter, txId: number): Array<{ id: number; name: string; kind: string }> {
  return db.all(
    `SELECT tg.id, tg.name, tg.kind FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id
      WHERE tt.tx_id = ? AND tg.status = 'active' ORDER BY tg.name`,
    [txId],
  );
}

export function listTags(db: DbAdapter, includeArchived = false): TagRow[] {
  return db.all(
    `SELECT id, name, kind, color, parent_id AS parentId, status, merged_into AS mergedInto,
            (SELECT COUNT(*) FROM tx_tags tt WHERE tt.tag_id = tags.id) AS txCount,
            (SELECT COALESCE(SUM(t.amount), 0) FROM tx_tags tt JOIN tx_events t ON t.id = tt.tx_id WHERE tt.tag_id = tags.id) AS totalCents,
            (SELECT v.kind FROM ventures v WHERE v.tag_id = tags.id) AS ventureKind
       FROM tags ${includeArchived ? "" : "WHERE status = 'active'"} ORDER BY kind = 'venture' DESC, txCount DESC, name`,
  ) as TagRow[];
}

export function addTagRule(db: DbAdapter, tagId: number, matchOn: "counterparty" | "text" | "template" | "kind", pattern: string, priority = 0): number {
  const r = db.run(
    `INSERT INTO tag_rules (tag_id, match_on, pattern, priority, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
    [tagId, matchOn, pattern, priority, Date.now()],
  );
  return lastInsertId(r);
}

/**
 * Retroactive rules. Substring matching (SQLite has no regex); applied with INSERT OR IGNORE
 * so a manual tag/source is never overwritten.
 */
export function applyTagRules(db: DbAdapter): number {
  const rules = db.all(
    `SELECT id, tag_id AS tagId, match_on AS matchOn, pattern FROM tag_rules WHERE enabled = 1 ORDER BY priority DESC, id`,
  );
  let tagged = 0;
  for (const r of rules) {
    let ids: Array<{ id: number }> = [];
    const like = `%${r.pattern}%`;
    if (r.matchOn === "counterparty") {
      ids = db.all(
        `SELECT t.id FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
          WHERE COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') LIKE ?`,
        [like],
      );
    } else if (r.matchOn === "template") {
      ids = db.all(`SELECT id FROM tx_events WHERE template LIKE ?`, [like]);
    } else if (r.matchOn === "kind") {
      ids = db.all(`SELECT id FROM tx_events WHERE kind = ?`, [r.pattern]);
    } else if (r.matchOn === "text") {
      ids = db.all(
        `SELECT DISTINCT t.id FROM tx_events t
          WHERE EXISTS (SELECT 1 FROM tx_notes n WHERE n.tx_id = t.id AND n.text LIKE ?)
             OR EXISTS (SELECT 1 FROM attachments a WHERE a.tx_id = t.id AND a.caption LIKE ?)`,
        [like, like],
      );
    }
    for (const row of ids) {
      const before = db.get(`SELECT 1 FROM tx_tags WHERE tx_id = ? AND tag_id = ?`, [row.id, r.tagId]);
      db.run(
        `INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, 'rule', 0.8, ?)`,
        [row.id, r.tagId, Date.now()],
      );
      if (!before) { tagged++; reindexTx(db, Number(row.id)); }
    }
  }
  return tagged;
}

export interface ProposedTag extends TagProposal {
  totalCents: number;
  count: number;
}

/**
 * Deterministic cluster suggestions: a counterparty with >= 3 outflows and no tag looks like
 * a venture/supplier the user may want to track. No model, no guessing at names beyond the
 * counterparty label the phone already shows.
 */
export function suggestTags(db: DbAdapter, now = Date.now(), minCount = 3, max = 8): ProposedTag[] {
  const rows = db.all(
    `SELECT t.counterparty_id AS cpId, c.key AS cpKey,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS name,
            COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS total
       FROM tx_events t
       JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = 'out' AND t.occurred_at >= ?
        AND NOT EXISTS (SELECT 1 FROM tx_tags tt WHERE tt.tx_id = t.id)
        AND (c.display_name IS NOT NULL OR c.raw_names <> '[]')
      GROUP BY t.counterparty_id HAVING n >= ? ORDER BY total DESC LIMIT ?`,
    [now - 180 * 86_400_000, minCount, max],
  );
  const out: ProposedTag[] = [];
  for (const r of rows) {
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    const ids = db.all(
      `SELECT t.id FROM tx_events t WHERE t.counterparty_id = ? AND t.direction = 'out'
        AND NOT EXISTS (SELECT 1 FROM tx_tags tt WHERE tt.tx_id = t.id) ORDER BY t.occurred_at`,
      [r.cpId],
    ).map((x: { id: number }) => Number(x.id));
    out.push({
      tag: name, kind: "venture", candidateTxIds: ids,
      why: `${ids.length} payments to ${name} totalling ${formatKes(Number(r.total))} are untagged.`,
      source: "cluster", evidence: { counterpartyId: r.cpId, cpKey: r.cpKey, count: ids.length }, confidence: 0.6,
      totalCents: Number(r.total), count: ids.length,
    });
  }
  return out;
}

export function acceptProposal(db: DbAdapter, p: ProposedTag, kind = "venture"): number {
  const tagId = kind === "venture" ? createVenture(db, p.tag, "business").tagId : createTag(db, p.tag, "user");
  for (const txId of p.candidateTxIds) {
    db.run(`INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, 'cluster', ?, ?)`, [txId, tagId, p.confidence, Date.now()]);
    reindexTx(db, txId);
  }
  return tagId;
}

export function venturePnl(db: DbAdapter, tagId: number, from = 0, to = Date.now()): VenturePnL {
  const row = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'in' AND COALESCE(t.flow_class,'') <> 'debt_draw' THEN t.amount ELSE 0 END), 0) AS incomeCents,
       COALESCE(SUM(CASE WHEN direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' THEN t.amount ELSE 0 END), 0) AS expenseCents,
       COALESCE(SUM(CASE WHEN direction = 'out' AND COALESCE(t.flow_class,'') <> 'debt_repay' THEN COALESCE(t.fee, 0) ELSE 0 END), 0) AS feeCents,
       COUNT(*) AS txCount
     FROM tx_tags tt JOIN tx_events t ON t.id = tt.tx_id
     WHERE tt.tag_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?`,
    [tagId, from, to],
  );
  const income = Number(row?.incomeCents ?? 0);
  const expense = Number(row?.expenseCents ?? 0);
  const fee = Number(row?.feeCents ?? 0);
  return { tagId, incomeCents: income, expenseCents: expense, feeCents: fee, netCents: income - expense - fee, txCount: Number(row?.txCount ?? 0), from, to };
}

export function venturePnlAll(db: DbAdapter, from = 0, to = Date.now()): Array<VenturePnL & { name: string }> {
  const ventures = db.all(`SELECT tag_id AS tagId, name FROM ventures WHERE status = 'active' ORDER BY name`);
  return ventures.map((v: { tagId: number; name: string }) => ({ ...venturePnl(db, v.tagId, from, to), name: v.name }));
}
