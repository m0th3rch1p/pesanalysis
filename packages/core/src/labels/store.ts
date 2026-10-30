/**
 * Labels and roles are data, not a fixed enum. Users can add or rename either without
 * touching transaction history. Merges keep tombstones; this module only does safe edits.
 */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";

export interface LabelRow {
  id: number; name: string; parentId: number | null; parentName: string | null;
  isCustom: boolean; status: string; txCount: number;
}

export interface RoleRow { id: number; name: string; isCustom: boolean; people: number }

export function listLabelsFull(db: DbAdapter): LabelRow[] {
  return db.all(
    `SELECT l.id, l.name, l.parent_id AS parentId, p.name AS parentName,
            l.is_custom AS isCustom, l.status,
            (SELECT COUNT(DISTINCT tl.tx_id) FROM tx_labels tl WHERE tl.label_id = l.id) AS txCount
       FROM labels l LEFT JOIN labels p ON p.id = l.parent_id
      WHERE l.status = 'active'
      ORDER BY txCount DESC, l.name`,
  ).map((r: Record<string, unknown>) => ({
    id: Number(r.id), name: String(r.name), parentId: r.parentId == null ? null : Number(r.parentId),
    parentName: r.parentName == null ? null : String(r.parentName), isCustom: Number(r.isCustom) === 1,
    status: String(r.status), txCount: Number(r.txCount ?? 0),
  }));
}

export function createLabel(db: DbAdapter, name: string, parentName?: string | null, now = Date.now()): number {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) throw new Error("label name is empty");
  const existing = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND status = 'active' LIMIT 1`, [clean]);
  if (existing) return Number(existing.id);
  const parent = parentName ? db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND status = 'active' LIMIT 1`, [parentName]) : null;
  const r = db.run(`INSERT INTO labels (name, parent_id, is_custom, created_at) VALUES (?, ?, 1, ?)`, [clean, parent?.id ?? null, now]);
  return lastInsertId(r) || Number((db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE LIMIT 1`, [clean]) as { id?: number } | undefined)?.id ?? 0);
}

export function renameLabel(db: DbAdapter, id: number, name: string): number {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) throw new Error("label name is empty");
  const clash = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND id <> ? AND status = 'active' LIMIT 1`, [clean, id]);
  if (clash) return Number(clash.id); // caller can merge later; never duplicate a name
  db.run(`UPDATE labels SET name = ?, is_custom = 1 WHERE id = ?`, [clean, id]);
  return id;
}

export function listRolesFull(db: DbAdapter): RoleRow[] {
  return db.all(
    `SELECT r.id, r.name, r.is_custom AS isCustom,
            (SELECT COUNT(*) FROM counterparties c WHERE c.role_id = r.id) AS people
       FROM roles r WHERE r.merged_into IS NULL
      ORDER BY people DESC, r.name`,
  ).map((r: Record<string, unknown>) => ({ id: Number(r.id), name: String(r.name), isCustom: Number(r.isCustom) === 1, people: Number(r.people ?? 0) }));
}

export function createRole(db: DbAdapter, name: string, now = Date.now()): number {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) throw new Error("role name is empty");
  const existing = db.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND merged_into IS NULL LIMIT 1`, [clean]);
  if (existing) return Number(existing.id);
  const r = db.run(`INSERT INTO roles (name, is_custom, created_at) VALUES (?, 1, ?)`, [clean, now]);
  return lastInsertId(r) || Number((db.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE LIMIT 1`, [clean]) as { id?: number } | undefined)?.id ?? 0);
}

export function renameRole(db: DbAdapter, id: number, name: string): number {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) throw new Error("role name is empty");
  const clash = db.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND id <> ? AND merged_into IS NULL LIMIT 1`, [clean, id]);
  if (clash) return Number(clash.id);
  db.run(`UPDATE roles SET name = ?, is_custom = 1 WHERE id = ?`, [clean, id]);
  return id;
}

export function setCounterpartyRole(db: DbAdapter, counterpartyId: number, roleId: number | null): void {
  db.run(`UPDATE counterparties SET role_id = ? WHERE id = ?`, [roleId, counterpartyId]);
}
