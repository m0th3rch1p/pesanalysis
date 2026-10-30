import type { DbAdapter } from "../db/migrate.js";

export interface HostRecord {
  id: string; name: string; zone: string; keyFingerprint: string | null;
  pairedAt: number; revokedAt: number | null; lastSeenAt: number | null;
}

export class HostRevokedError extends Error {
  constructor(public hostId: string) { super(`host ${hostId} was revoked; pair again under a new id`); }
}

/**
 * Pairs a host. A revoked id is never silently re-activated (C6): pairing it again throws `HostRevokedError`, and the
 * caller must create a new host id (and a new token). Re-pairing an active host only updates its name/fingerprint.
 */
export function pairHost(
  db: DbAdapter,
  input: { id: string; name: string; keyFingerprint?: string | null; now?: number },
): HostRecord {
  const at = input.now ?? Date.now();
  const existing = getHost(db, input.id);
  if (existing?.revokedAt != null) throw new HostRevokedError(input.id);
  db.run(
    `INSERT INTO hosts (id, name, zone, key_fingerprint, paired_at) VALUES (?, ?, 'Z1', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, key_fingerprint = excluded.key_fingerprint`,
    [input.id, input.name, input.keyFingerprint ?? null, at],
  );
  return getHost(db, input.id)!;
}

/** Live audit row for every export or live call that leaves the phone (snapshot push, file export, MCP call). */
export function recordZ1Export(
  db: DbAdapter,
  e: { hostId: string | null; tool: string; rows: number; ok: boolean; detail?: Record<string, unknown>; now?: number },
): void {
  db.run(
    `INSERT INTO tool_audit (zone, host_id, tool, params_json, row_count, ok, at) VALUES ('Z1', ?, ?, ?, ?, ?, ?)`,
    [e.hostId, e.tool, JSON.stringify(e.detail ?? {}).slice(0, 2000), e.rows, e.ok ? 1 : 0, e.now ?? Date.now()],
  );
}

/** A host is usable only if it exists and is not revoked. Live calls must check this before using a stored token. */
export function isHostActive(db: DbAdapter, id: string): boolean {
  const h = getHost(db, id);
  return !!h && h.revokedAt == null;
}

export function listHosts(db: DbAdapter): HostRecord[] {
  return db.all(
    `SELECT id, name, zone, key_fingerprint AS keyFingerprint, paired_at AS pairedAt,
            revoked_at AS revokedAt, last_seen_at AS lastSeenAt
       FROM hosts ORDER BY paired_at DESC`,
  ) as HostRecord[];
}

export function getHost(db: DbAdapter, id: string): HostRecord | null {
  const r = db.get(
    `SELECT id, name, zone, key_fingerprint AS keyFingerprint, paired_at AS pairedAt,
            revoked_at AS revokedAt, last_seen_at AS lastSeenAt FROM hosts WHERE id = ?`, [id],
  );
  return (r as HostRecord | undefined) ?? null;
}

export function revokeHost(db: DbAdapter, id: string, now = Date.now()): void {
  db.run(`UPDATE hosts SET revoked_at = ? WHERE id = ?`, [now, id]);
}

export interface Z1Snapshot {
  format: "pesanalysis-z1-snapshot-v1";
  createdAt: number;
  hostId: string | null;
  tables: {
    transactions: Array<Record<string, unknown>>;
    labels: Array<Record<string, unknown>>;
    counterparties: Array<Record<string, unknown>>;
    accounts: Array<Record<string, unknown>>;
    tags: Array<Record<string, unknown>>;
  };
}

/**
 * Z1 Mode A snapshot: row-level, column-allowlisted, no SMS bodies, no notes text,
 * no locations, no media. The user carries this to their own host; it is never sent
 * to a third party.
 */
export interface Z1SnapshotOptions {
  /** Contact-derived names are excluded unless the user opts in. Masked/raw provider names are not contact data. */
  includeContactNames?: boolean;
}

export function buildZ1Snapshot(db: DbAdapter, hostId: string | null = null, now = Date.now(), opts: Z1SnapshotOptions = {}): Z1Snapshot {
  const withContacts = opts.includeContactNames === true;
  // A counterparty linked to an Android contact carries a contact-derived display_name. Replace it with a stable pseudonym.
  const cpName = withContacts
    ? `COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'))`
    : `CASE WHEN c.id IS NULL THEN NULL WHEN c.contact_id IS NOT NULL THEN 'Contact #' || c.id ELSE COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) END`;
  const transactions = db.all(
    `SELECT t.id, t.provider, t.kind, t.direction, t.amount, t.fee, t.occurred_at AS occurredAt,
            t.account, t.scope, t.status,
            l.name AS label,
            ${cpName} AS counterparty,
            r.name AS role
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (
         SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
          ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN roles r ON r.id = c.role_id
      ORDER BY t.occurred_at DESC LIMIT 10000`,
  ) as Array<Record<string, unknown>>;
  const labels = db.all(`SELECT id, name, parent_id AS parentId FROM labels`) as Array<Record<string, unknown>>;
  const counterparties = db.all(
    `SELECT id, ${withContacts ? "display_name" : "CASE WHEN contact_id IS NOT NULL THEN 'Contact #' || id ELSE display_name END"} AS displayName, role_id AS roleId FROM counterparties ORDER BY id LIMIT 5000`,
  ) as Array<Record<string, unknown>>;
  const accounts = db.all(`SELECT * FROM accounts`) as Array<Record<string, unknown>>;
  const tags = db.all(`SELECT id, name, kind, status FROM tags`) as Array<Record<string, unknown>>;
  return {
    format: "pesanalysis-z1-snapshot-v1", createdAt: now, hostId,
    tables: { transactions, labels, counterparties, accounts, tags },
  };
}
