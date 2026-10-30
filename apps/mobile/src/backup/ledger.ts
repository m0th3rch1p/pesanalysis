import type { SQLiteDatabase } from "expo-sqlite";
import { Directory, File, Paths } from "expo-file-system";
import {
  PAYLOAD_FORMAT, RESET_TABLES, SCHEMA_VERSION, BackupError, clearUserTables, decryptBackup, encryptBackup, ensureFts, migrate,
  peekHeader, rebuildSearchIndex, seedTaxonomy, validatePayload, type BackupPayload, type KdfParams, type Row,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { runNightlyOnDevice } from "../nightly";
import { getBackupKdf, rng } from "./crypto";
import { resetCapture } from "../../modules/yako-sms";
import { takeSafetySnapshot } from "./snapshots";

const SKIP = new Set(["meta", "tx_fts"]);
const DEVICE_LOCAL_META = new Set([
  "schema_version", "fts5", "onboarded", "lock_enabled", "inbox_catchup_last", "capture_pause_until", "digest_plan_v1",
]);
const isDeviceLocalMeta = (key: string) => DEVICE_LOCAL_META.has(key) || key.startsWith("model_ready_") || key.startsWith("demo_");
/** The only tables a backup may carry (user data; never meta/FTS, never SecureStore keys). */
export const BACKUP_TABLES: readonly string[] = RESET_TABLES.filter((t) => !SKIP.has(t));
const RESTORE_ORDER = [...BACKUP_TABLES].reverse();
const MAX_PLAIN_BYTES = 256 * 1024 * 1024;

export interface LedgerStats { tables: number; rows: number; counts: Record<string, number>; media: number; mediaSkipped: number; mediaError?: string }

/** Logical serialization of every user table plus settings. Media files and secrets are not included. */
export async function serializeLedger(db: SQLiteDatabase): Promise<{ payload: BackupPayload; stats: LedgerStats }> {
  const tables: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  let rows = 0;
  let settings: Array<{ key: string; value: string }> = [];
  try {
    settings = db.getAllSync<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key NOT IN ('schema_version','fts5')`)
      .filter((s) => !isDeviceLocalMeta(s.key));
    rows += settings.length;
  } catch { /* meta optional */ }
  for (const t of BACKUP_TABLES) {
    try {
      const r = db.getAllSync(`SELECT * FROM ${t}`) as Row[];
      tables[t] = r; counts[t] = r.length; rows += r.length;
    } catch { tables[t] = []; counts[t] = 0; } // table absent on an old DB
  }
  // Media files are small enough to carry in the encrypted container. A backup without them would
  // restore attachment rows pointing at missing files, so include every readable attachment.
  const media: Array<{ name: string; data: string }> = [];
  let mediaSkipped = 0;
  let mediaError: string | undefined;
  const seen = new Set<string>();
  // Manual base64: Hermes' argument limit makes String.fromCharCode(...bigChunk) unsafe for photos.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const toB64 = (u: Uint8Array) => {
    let out = "";
    for (let i = 0; i < u.length; i += 3) {
      const a = u[i] ?? 0, b = u[i + 1], c = u[i + 2];
      out += ALPHABET[a >> 2]!;
      out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
      out += b === undefined ? "=" : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
      out += c === undefined ? "=" : ALPHABET[c & 63]!;
    }
    return out;
  };
  try {
    for (const row of tables.attachments ?? []) {
      const raw = String(row.uri ?? "");
      if (!raw) continue;
      const name = decodeURIComponent(raw.split("/").pop() ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || seen.has(name)) continue;
      try {
        const f = new File(/^file:\/\//.test(raw) ? raw : `file://${raw}`);
        if (!f.exists) { mediaSkipped++; mediaError ??= `attachment file missing (${name})`; continue; }
        const bytes = await f.bytes();
        if (bytes.length > 32 * 1024 * 1024) { mediaSkipped++; mediaError ??= `attachment too large (${name})`; continue; }
        media.push({ name, data: toB64(bytes) });
        seen.add(name);
      } catch (e) { mediaSkipped++; mediaError ??= `attachment unreadable (${name}): ${String(e).slice(0, 80)}`; }
    }
  } catch { /* attachments table on an old DB */ }
  return {
    payload: { format: PAYLOAD_FORMAT, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION, tables, settings, ...(media.length ? { media } : {}) },
    stats: { tables: BACKUP_TABLES.length, rows, counts, media: media.length, mediaSkipped, ...(mediaError ? { mediaError } : {}) },
  };
}

export async function createBackupBytesRaw(
  db: SQLiteDatabase, o: { passphrase: string; kdf: KdfParams; recovery: boolean; onProgress?: (d: number, t: number) => void },
): Promise<Uint8Array> {
  const { bytes } = await encryptWithMeta(db, o);
  return bytes;
}

async function encryptWithMeta(
  db: SQLiteDatabase, o: { passphrase: string; kdf: KdfParams; recovery: boolean; onProgress?: (d: number, t: number) => void },
) {
  const { payload, stats } = await serializeLedger(db);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const enc = await encryptBackup(plain, {
    passphrase: o.passphrase, rng, kdf: o.kdf, recovery: o.recovery, onProgress: o.onProgress,
    meta: { schema: SCHEMA_VERSION, rows: stats.rows },
  });
  return { ...enc, stats };
}

export interface CreatedBackup { bytes: Uint8Array; recoveryCode: string | null; stats: LedgerStats }

/**
 * Encrypts the current ledger into a .pesabak. Pass the user's passphrase; the recovery code (shown once by
 * the caller) is returned and never stored. Cloud uploaders can take `bytes` as is.
 */
export async function createBackupBytes(
  db: SQLiteDatabase, secret: { passphrase: string; kdf?: KdfParams }, onProgress?: (d: number, t: number) => void,
): Promise<CreatedBackup> {
  const kdf = secret.kdf ?? (await getBackupKdf());
  return encryptWithMeta(db, { passphrase: secret.passphrase, kdf, recovery: true, onProgress });
}

export interface RestoreSecret { passphrase?: string; recoveryCode?: string }
export interface RestoreResult { rows: number; tables: number; schemaVersion: number; contexts: number; snapshot: string; media: number }

interface PreservedContext {
  sender: string; hash: string; lat: number | null; lng: number | null; accuracy_m: number | null;
  motion: string | null; steps_last_10m: number | null; calendar_event_id: string | null; calendar_title: string | null;
  source: string | null; captured_at: number | null; age_ms: number | null; battery_pct: number | null;
  is_charging: number | null; step_delta: number | null; circadian_phase: string | null;
  place_id: number | null; fix_kind: string | null; fix_latency_ms: number | null; provider: string | null;
}

/** Native passive fixes are not in a logical backup; keep them keyed by raw body hash and reattach. */
function snapshotContexts(db: SQLiteDatabase): PreservedContext[] {
  try {
    return db.getAllSync<PreservedContext>(
      `SELECT s.sender, s.body_sha256 AS hash, ctx.lat, ctx.lng, ctx.accuracy_m, ctx.motion, ctx.steps_last_10m,
              ctx.calendar_event_id, ctx.calendar_title, ctx.source, ctx.captured_at, ctx.age_ms, ctx.battery_pct,
              ctx.is_charging, ctx.step_delta, ctx.circadian_phase, ctx.place_id, ctx.fix_kind, ctx.fix_latency_ms, ctx.provider
         FROM tx_context ctx JOIN transactions t ON t.id = ctx.tx_id JOIN sms_raw s ON s.id = t.sms_id
        WHERE s.body_sha256 IS NOT NULL`,
    );
  } catch { return []; }
}

function reattachContexts(db: SQLiteDatabase, rows: PreservedContext[]): number {
  if (!rows.length) return 0;
  const byKey = new Map(rows.map((r) => [`${r.sender}\u0000${r.hash}`, r]));
  let attached = 0;
  try {
    const targets = db.getAllSync<{ id: number; sender: string; hash: string }>(
      `SELECT t.id, s.sender, s.body_sha256 AS hash FROM transactions t JOIN sms_raw s ON s.id = t.sms_id`);
    for (const t of targets) {
      const r = byKey.get(`${t.sender}\u0000${t.hash}`);
      if (!r) continue;
      db.runSync(
        `INSERT OR REPLACE INTO tx_context (tx_id, lat, lng, accuracy_m, motion, steps_last_10m, calendar_event_id, calendar_title,
           source, captured_at, age_ms, battery_pct, is_charging, step_delta, circadian_phase, place_id, fix_kind, fix_latency_ms, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, r.lat, r.lng, r.accuracy_m, r.motion, r.steps_last_10m, r.calendar_event_id, r.calendar_title,
          r.source ?? "backfill", r.captured_at, r.age_ms, r.battery_pct, r.is_charging, r.step_delta, r.circadian_phase,
          r.place_id, r.fix_kind, r.fix_latency_ms, r.provider]);
      attached++;
    }
  } catch { /* optional */ }
  return attached;
}

/**
 * Staged, atomic restore. Nothing touches the ledger until the file is fully decrypted, authenticated,
 * parsed and validated and a safety snapshot of the current ledger exists. Then ONE transaction does
 * clear + insert + settings + per-table count verification; any throw rolls the whole thing back.
 * Older schema versions restore into the current schema (unknown columns skipped, missing ones default),
 * then migrate() runs its idempotent column/table upgrades.
 */
export async function restoreFromBytes(
  db: SQLiteDatabase, bytes: Uint8Array, secret: RestoreSecret,
  o: { onStage?: (s: "decrypting" | "validating" | "snapshot" | "applying" | "finalizing") => void; snapshotReason?: string } = {},
): Promise<RestoreResult> {
  const stage = o.onStage ?? (() => undefined);
  const header = peekHeader(bytes);
  const hs = Number(header.meta?.schema ?? 0);
  if (hs > SCHEMA_VERSION) throw new BackupError("version", `backup is from a newer app (schema ${hs}, this app supports ${SCHEMA_VERSION}). Update the app first.`);
  stage("decrypting");
  const plain = await decryptBackup(bytes, secret);
  if (plain.length > MAX_PLAIN_BYTES) throw new BackupError("format", "backup is too large");
  stage("validating");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new BackupError("format", "backup payload is not valid JSON"); }
  const payload = validatePayload(parsed, { allowedTables: BACKUP_TABLES, appSchemaVersion: SCHEMA_VERSION });

  stage("snapshot");
  const snap = await takeSafetySnapshot(db, o.snapshotReason ?? "pre-restore"); // throws => ledger untouched

  const a = asDbAdapter(db);
  const liveContexts = payload.tables.tx_context?.length ? [] : snapshotContexts(db);
  const localMeta = db.getAllSync<{ key: string; value: string }>(`SELECT key, value FROM meta`)
    .filter((r) => isDeviceLocalMeta(r.key));

  // Decode media into a staging directory before touching the ledger. If the container is corrupt or
  // a file cannot be written, the current ledger stays exactly as it was.
  const mediaEntries = payload.media ?? [];
  const mediaNames = new Set(mediaEntries.map((m) => m.name));
  const staged = new Directory(Paths.cache, "restore-media");
  if (staged.exists) staged.delete();
  staged.create({ intermediates: true, idempotent: true });
  const decodeB64 = (s: string) => {
    const clean = s.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    const val = (ch: string) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(ch);
    for (let i = 0; i < clean.length; i += 4) {
      const a = val(clean[i]!), b = val(clean[i + 1]!), c = val(clean[i + 2]!), d = val(clean[i + 3]!);
      out[o++] = (a << 2) | (b >> 4);
      if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0) out[o++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, o);
  };
  for (const m of mediaEntries) {
    const f = new File(staged, m.name);
    f.writeSync(decodeB64(m.data));
    if ((f.size ?? 0) === 0 && m.data.length > 0) throw new BackupError("format", "a media file could not be restored");
  }
  const finalMediaDir = new Directory(Paths.document, "attachments");
  if (!finalMediaDir.exists) finalMediaDir.create({ intermediates: true, idempotent: true });
  const mediaBase = finalMediaDir.uri.replace(/^file:\/\//, "");
  const colsOf = new Map<string, Set<string>>();
  const cols = (t: string) => {
    let c = colsOf.get(t);
    if (!c) { c = new Set((db.getAllSync(`PRAGMA table_info(${t})`) as Array<{ name: string }>).map((x) => x.name)); colsOf.set(t, c); }
    return c;
  };

  stage("applying");
  const expected: Record<string, number> = {};
  let rows = 0;
  db.execSync("PRAGMA foreign_keys = OFF;"); // no-op inside a transaction, so set it outside
  try {
    db.withTransactionSync(() => { // throws => automatic ROLLBACK
      clearUserTables(a);
      for (const t of RESTORE_ORDER) {
        const data = payload.tables[t];
        if (!data?.length) continue;
        const known = cols(t);
        if (!known.size) throw new Error(`table ${t} does not exist in this app version`);
        let n = 0;
        for (const source of data) {
          let row = source;
          if (t === "attachments") {
            const name = decodeURIComponent(String(row.uri ?? "").split("/").pop() ?? "");
            if (payload.media !== undefined) {
              if (!mediaNames.has(name)) continue; // no bytes in this backup: do not restore a dangling row
              row = { ...row, uri: `${mediaBase}/${name}` };
            } else {
              const uri = String(row.uri ?? "");
              const f = new File(/^file:\/\//.test(uri) ? uri : `file://${uri}`);
              if (!uri || !f.exists) continue;
            }
          }
          const use = Object.keys(row).filter((c) => known.has(c));
          if (!use.length) continue;
          db.runSync(`INSERT INTO ${t} (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`, use.map((c) => row[c] as never));
          n++;
        }
        expected[t] = n; rows += n;
      }
      for (const s of payload.settings) {
        if (isDeviceLocalMeta(s.key)) continue;
        db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [s.key, s.value]);
      }
      // Device-local settings belong to this install, not to the backup's phone.
      for (const s of localMeta) {
        db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [s.key, s.value]);
      }
      db.runSync(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(SCHEMA_VERSION)]);
      for (const [t, n] of Object.entries(expected)) {
        const actual = Number((db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t}`) as { n: number }).n);
        if (actual !== n) throw new Error(`verification failed: ${t} has ${actual} rows, expected ${n}`);
      }
    });
  } finally {
    try { db.execSync("PRAGMA foreign_keys = ON;"); } catch { /* best effort */ }
  }

  stage("finalizing");
  // Move verified media into place. The attachment rows already point at these final paths.
  let media = 0;
  for (const m of mediaEntries) {
    try {
      const src = new File(staged, m.name);
      const dest = new File(finalMediaDir, m.name);
      if (dest.exists) dest.delete();
      src.moveSync(dest);
      media++;
    } catch { /* keep the row; the UI will show a missing-media state */ }
  }
  try { if (staged.exists) staged.delete(); } catch { /* cache cleanup */ }
  // The native inbox floor must not re-import messages older than this snapshot after a reset.
  try { await resetCapture(payload.createdAt || Date.now()); } catch { /* native module unavailable */ }
  // Post-commit steps are derived/idempotent; failures here never undo a verified restore.
  try { seedTaxonomy(a); } catch { /* backup already carried taxonomy */ }
  try { migrate(a); } catch { /* columns are already current; analyses recompute */ }
  const contexts = reattachContexts(db, liveContexts);
  try { ensureFts(a); rebuildSearchIndex(a); } catch { /* LIKE fallback */ }
  try { runNightlyOnDevice(db); } catch { /* recomputed on next nightly */ }
  return { rows, tables: Object.keys(expected).length, schemaVersion: hs || payload.schemaVersion, contexts, snapshot: snap.name, media };
}
