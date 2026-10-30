import type { DbAdapter } from "../db/migrate.js";
import { canLinkMaskedToFull, normalizePhone } from "./normalize.js";

export interface LocalContact {
  contactId: string;
  name: string | null;
  phones: string[];
}

/**
 * On-device contact unmasking for masked M-PESA names. We never dial or upload:
 * prefix+suffix+name must match, then the display name/contact id are attached to
 * the existing masked counterparty and the link is recorded in entity_links.
 */
export function linkMaskedContacts(db: DbAdapter, contacts: LocalContact[], now = Date.now()): { linked: number } {
  return linkContacts(db, contacts, now);
}

/** Match both full-phone and masked counterparties against the local phonebook. */
export function linkContacts(db: DbAdapter, contacts: LocalContact[], now = Date.now()): { linked: number } {
  const rows = db.all(
    `SELECT id, key, display_name AS displayName FROM counterparties WHERE merged_into IS NULL`,
  ) as Array<{ id: number; key: string; displayName: string | null }>;
  if (!rows.length || !contacts.length) return { linked: 0 };
  const byPhone = new Map<string, LocalContact>();
  for (const c of contacts) {
    for (const raw of c.phones) {
      const p = normalizePhone(raw);
      if (p && !byPhone.has(p)) byPhone.set(p, c);
    }
  }
  let linked = 0;
  for (const cp of rows) {
    let match: LocalContact | null = null;
    let fullKey: string | null = null;
    if (cp.key.startsWith("p:")) {
      const phone = cp.key.slice(2);
      match = byPhone.get(phone) ?? null;
      if (match) fullKey = cp.key;
    } else if (cp.key.startsWith("m:")) {
      for (const c of contacts) {
        for (const raw of c.phones) {
          const phone = normalizePhone(raw);
          if (phone && canLinkMaskedToFull(cp.key, phone, c.name, { minNameSimilarity: 0.45 })) {
            match = c; fullKey = `p:${phone}`; break;
          }
        }
        if (match) break;
      }
    }
    if (!match || !fullKey) continue;
    db.run(
      `INSERT INTO entity_links (masked_key, full_key, contact_id, confidence, linked_at)
       VALUES (?, ?, ?, 1, ?) ON CONFLICT(masked_key, full_key) DO UPDATE SET contact_id = excluded.contact_id, linked_at = excluded.linked_at`,
      [cp.key, fullKey, match.contactId, now],
    );
    db.run(
      `UPDATE counterparties SET display_name = COALESCE(NULLIF(?, ''), display_name), contact_id = ? WHERE id = ?`,
      [match.name, match.contactId, cp.id],
    );
    linked++;
  }
  return { linked };
}
