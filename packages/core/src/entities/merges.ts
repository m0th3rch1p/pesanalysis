/**
 * Entity resolution for counterparties. SMS masks digits and banks spell names
 * differently, so the same person can appear as a full phone, a masked phone,
 * or a name-only row. We never auto-merge: candidates are scored, shown in the
 * Hub, and only the user accepts or dismisses them.
 */
import type { DbAdapter } from "../db/migrate.js";
import { canLinkMaskedToFull, normalizeName, parseMaskedPhone } from "./normalize.js";
import { reindexTx } from "../search/service.js";

export interface CounterpartyMergeCandidate {
  id: number;
  leftId: number;
  rightId: number;
  leftName: string;
  rightName: string;
  leftKey: string;
  rightKey: string;
  leftCount: number;
  rightCount: number;
  score: number;
  reason: string;
  status: string;
}

interface CpRow {
  id: number; key: string; displayName: string | null; rawNames: string | null;
  roleId: number | null; contactId: string | null; txCount: number; defaultLabelId: number | null;
}

function nameOf(c: CpRow): string {
  if (c.displayName?.trim()) return c.displayName.trim();
  try {
    const raw = JSON.parse(c.rawNames ?? "[]") as string[];
    return raw.find((x) => x && x.trim())?.trim() ?? "";
  } catch { return ""; }
}

function maskedParts(key: string): { prefix: string; suffix: string; name: string | null } | null {
  const m = /^m:(254\d{3}\*{2,5}\d{3})(?::(.+))?$/.exec(key);
  if (!m) return null;
  const p = /^254(\d{3})\*{2,5}(\d{3})$/.exec(m[1]!);
  return p ? { prefix: p[1]!, suffix: p[2]!, name: m[2]?.replace(/_/g, " ") ?? null } : null;
}

function pairScore(a: CpRow, b: CpRow): { score: number; reason: string } {
  if (a.contactId && b.contactId && a.contactId === b.contactId) {
    return { score: 0.99, reason: "Both rows point to the same phone contact." };
  }
  const ap = a.key.startsWith("p:"), bp = b.key.startsWith("p:");
  const am = maskedParts(a.key), bm = maskedParts(b.key);
  if (ap && bm) {
    if (canLinkMaskedToFull(b.key, a.key.slice(2), nameOf(a), { minNameSimilarity: 0.8 })) {
      return { score: 0.95, reason: "The masked number's visible digits match the full phone." };
    }
    return { score: 0.55, reason: "Same name, but the masked digits point to a different phone." };
  }
  if (bp && am) {
    if (canLinkMaskedToFull(a.key, b.key.slice(2), nameOf(b), { minNameSimilarity: 0.8 })) {
      return { score: 0.95, reason: "The masked number's visible digits match the full phone." };
    }
    return { score: 0.55, reason: "Same name, but the masked digits point to a different phone." };
  }
  if (am && bm) {
    if (am.prefix === bm.prefix && am.suffix === bm.suffix) {
      return { score: 0.9, reason: "Both masked numbers show the same visible digits." };
    }
    return { score: 0.5, reason: "Same name; the two masked numbers differ." };
  }
  if (ap && bp) return { score: 0.45, reason: "Same name, but two different full phone numbers." };
  if (parseMaskedPhone(a.key) || parseMaskedPhone(b.key)) {
    return { score: 0.55, reason: "Same name; one number is only partly visible." };
  }
  return { score: 0.5, reason: "Same name appears in separate SMS spellings." };
}

/** Build/refresh pending merge candidates. Safe to call on every Hub visit. */
export function suggestCounterpartyMerges(db: DbAdapter, now = Date.now(), max = 8): CounterpartyMergeCandidate[] {
  const rows = db.all(
    `SELECT c.id, c.key, c.display_name AS displayName, c.raw_names AS rawNames,
            c.role_id AS roleId, c.contact_id AS contactId, c.default_label_id AS defaultLabelId,
            (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_id = c.id) AS txCount
       FROM counterparties c
      WHERE c.merged_into IS NULL
      ORDER BY txCount DESC, c.id`,
  ) as CpRow[];
  const groups = new Map<string, CpRow[]>();
  for (const r of rows) {
    const name = normalizeName(nameOf(r));
    if (!name || name === "okoa" || /fuliza|unknown/.test(name)) continue;
    const list = groups.get(name) ?? [];
    list.push(r);
    groups.set(name, list);
  }
  let created = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        const left = Math.min(a.id, b.id), right = Math.max(a.id, b.id);
        const { score, reason } = pairScore(a, b);
        if (score < 0.45) continue;
        const existing = db.get(
          `SELECT id, status FROM entity_merge_candidates WHERE kind = 'counterparty' AND left_id = ? AND right_id = ?`,
          [left, right],
        ) as { id: number; status: string } | undefined;
        if (existing?.status === "dismissed" || existing?.status === "accepted") continue;
        const evidence = JSON.stringify({
          leftKey: a.key, rightKey: b.key, leftName: nameOf(a), rightName: nameOf(b),
          leftCount: Number(a.txCount), rightCount: Number(b.txCount),
        });
        if (existing) {
          db.run(
            `UPDATE entity_merge_candidates SET score = ?, reason = ?, evidence_json = ? WHERE id = ?`,
            [score, reason, evidence, existing.id],
          );
        } else {
          db.run(
            `INSERT INTO entity_merge_candidates (kind, left_id, right_id, score, reason, evidence_json, status, created_at)
             VALUES ('counterparty', ?, ?, ?, ?, ?, 'pending', ?)`,
            [left, right, score, reason, evidence, now],
          );
          created++;
        }
      }
    }
  }
  return listMergeCandidates(db, max);
}

export function listMergeCandidates(db: DbAdapter, limit = 8): CounterpartyMergeCandidate[] {
  return (db.all(
    `SELECT e.id, e.left_id AS leftId, e.right_id AS rightId, e.score, e.reason, e.status,
            COALESCE(l.display_name, json_extract(l.raw_names, '$[0]'), 'Unknown') AS leftName,
            COALESCE(r.display_name, json_extract(r.raw_names, '$[0]'), 'Unknown') AS rightName,
            l.key AS leftKey, r.key AS rightKey,
            (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_id = l.id) AS leftCount,
            (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_id = r.id) AS rightCount
       FROM entity_merge_candidates e
       JOIN counterparties l ON l.id = e.left_id
       JOIN counterparties r ON r.id = e.right_id
      WHERE e.kind = 'counterparty' AND e.status = 'pending'
        AND l.merged_into IS NULL AND r.merged_into IS NULL
      ORDER BY e.score DESC, e.id DESC LIMIT ?`,
    [limit],
  ) as CounterpartyMergeCandidate[]).map((r) => ({
    ...r, score: Number(r.score), leftCount: Number(r.leftCount), rightCount: Number(r.rightCount),
  }));
}

function mergeRawNames(a: string | null, b: string | null): string {
  const names = new Set<string>();
  for (const raw of [a, b]) {
    try {
      for (const n of JSON.parse(raw ?? "[]") as string[]) if (n?.trim()) names.add(n.trim());
    } catch { /* ignore malformed history */ }
  }
  return JSON.stringify([...names]);
}

/** User accepted a merge. Re-point every transaction; keep a tombstone on the loser. */
export function mergeCounterparties(db: DbAdapter, leftId: number, rightId: number, now = Date.now()): number {
  if (leftId === rightId) return leftId;
  const a = db.get(`SELECT * FROM counterparties WHERE id = ? AND merged_into IS NULL`, [leftId]);
  const b = db.get(`SELECT * FROM counterparties WHERE id = ? AND merged_into IS NULL`, [rightId]);
  if (!a || !b) throw new Error("merge target is missing or already merged");
  const count = (id: number) => Number((db.get(`SELECT COUNT(*) AS n FROM transactions WHERE counterparty_id = ?`, [id]) as { n?: number } | undefined)?.n ?? 0);
  const survivor = count(leftId) >= count(rightId) ? a : b;
  const loser = survivor.id === a.id ? b : a;
  const survivorId = Number(survivor.id), loserId = Number(loser.id);
  const mergedNames = mergeRawNames(survivor.raw_names, loser.raw_names);
  const displayName = (String(survivor.display_name ?? "").length >= String(loser.display_name ?? "").length)
    ? survivor.display_name ?? loser.display_name
    : loser.display_name ?? survivor.display_name;
  db.run(`UPDATE transactions SET counterparty_id = ? WHERE counterparty_id = ?`, [survivorId, loserId]);
  db.run(
    `UPDATE counterparties SET display_name = ?, raw_names = ?, role_id = COALESCE(role_id, ?),
            contact_id = COALESCE(contact_id, ?), default_label_id = COALESCE(default_label_id, ?),
            first_seen = MIN(first_seen, ?)
      WHERE id = ?`,
    [displayName ?? null, mergedNames, loser.role_id ?? null, loser.contact_id ?? null,
      loser.default_label_id ?? null, Number(loser.first_seen ?? now), survivorId],
  );
  db.run(`UPDATE counterparties SET merged_into = ? WHERE id = ?`, [survivorId, loserId]);
  db.run(
    `UPDATE entity_merge_candidates SET status = 'accepted', resolved_at = ?
      WHERE kind = 'counterparty'
        AND ((left_id = ? AND right_id = ?) OR (left_id = ? AND right_id = ?))`,
    [now, survivorId, loserId, loserId, survivorId],
  );
  for (const row of db.all(`SELECT id FROM transactions WHERE counterparty_id = ?`, [survivorId]) as Array<{ id: number }>) {
    reindexTx(db, Number(row.id));
  }
  return survivorId;
}

export function dismissMergeCandidate(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE entity_merge_candidates SET status = 'dismissed', resolved_at = ? WHERE id = ?`, [now, id]);
}


/**
 * Name-only rows whose spellings collapse to one NFKC/case-folded name are the same
 * entity and carry no conflicting identifier: merge them without asking. Rows with a
 * phone/till identifier are never auto-merged (they still go through the candidate card).
 * Idempotent; safe to run at every startup. WS0.4.
 */
export function autoMergeNameOnlyVariants(db: DbAdapter, now = Date.now()): number {
  const rows = db.all(
    `SELECT c.id, c.key, c.display_name AS displayName, c.raw_names AS rawNames,
            (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_id = c.id) AS txCount
       FROM counterparties c
      WHERE c.merged_into IS NULL AND c.key LIKE 'n:%'`,
  ) as CpRow[];
  const groups = new Map<string, CpRow[]>();
  for (const r of rows) {
    const name = normalizeName(nameOf(r));
    if (!name) continue;
    const list = groups.get(name) ?? [];
    list.push(r);
    groups.set(name, list);
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => Number(b.txCount) - Number(a.txCount) || a.id - b.id);
    const survivor = list[0]!;
    for (const other of list.slice(1)) {
      try { mergeCounterparties(db, survivor.id, other.id, now); merged++; } catch { /* already merged or raced */ }
    }
  }
  return merged;
}
