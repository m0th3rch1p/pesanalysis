/**
 * Pure logic around the backup payload (no I/O): format, validation of untrusted restored data,
 * Argon2id parameter calibration and snapshot retention. Used by apps/mobile/src/backup/*.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { BackupError, type KdfParams } from "./container.js";

export const PAYLOAD_FORMAT = "pesanalysis-backup-v2";
/** v1 was the legacy plaintext JSON shape (same layout, no schemaVersion). Still readable inside a container. */
export const LEGACY_PAYLOAD_FORMAT = "pesanalysis-backup-v1";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export interface BackupMedia { name: string; data: string }
export interface BackupPayload {
  format: string;
  createdAt: number;
  /** Schema version of the database the rows came from; 0 when unknown (legacy v1). */
  schemaVersion: number;
  tables: Record<string, Row[]>;
  settings: Array<{ key: string; value: string }>;
  /** App-private media (photos, video, voice) encoded as base64, keyed by safe basename. */
  media?: BackupMedia[];
}

export interface ValidateOpts {
  /** Tables a backup may contain. Anything else is rejected, never inserted. */
  allowedTables: readonly string[];
  /** The running app's schema version; newer backups are refused. */
  appSchemaVersion: number;
  maxRows?: number;
  maxRowsPerTable?: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_ROWS = 2_000_000;

const bad = (m: string) => new BackupError("format", m);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates an untrusted parsed payload and returns a normalised copy. Throws BackupError. */
export function validatePayload(input: unknown, o: ValidateOpts): BackupPayload {
  if (!isObj(input)) throw bad("payload is not an object");
  const format = input.format;
  if (format !== PAYLOAD_FORMAT && format !== LEGACY_PAYLOAD_FORMAT) throw bad("not a Pesanalysis backup");
  const sv = format === PAYLOAD_FORMAT ? input.schemaVersion : 0;
  if (typeof sv !== "number" || !Number.isInteger(sv) || sv < 0) throw bad("bad schema version");
  if (sv > o.appSchemaVersion) {
    throw new BackupError("version", `backup is from a newer app (schema ${sv}, this app supports ${o.appSchemaVersion}). Update the app first.`);
  }
  const createdAt = typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : 0;
  if (!isObj(input.tables)) throw bad("missing tables");
  const allowed = new Set(o.allowedTables);
  const maxRows = o.maxRows ?? MAX_ROWS;
  const maxPer = o.maxRowsPerTable ?? maxRows;
  let total = 0;
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(input.tables)) {
    if (!IDENT.test(name) || !allowed.has(name)) throw bad(`unknown table "${name.slice(0, 40)}"`);
    if (!Array.isArray(rows)) throw bad(`table ${name} is not a list`);
    if (rows.length > maxPer) throw bad(`table ${name} is too large`);
    total += rows.length;
    if (total > maxRows) throw bad("backup has too many rows");
    const out: Row[] = [];
    for (const r of rows) {
      if (!isObj(r)) throw bad(`bad row in ${name}`);
      const row: Row = {};
      for (const [k, v] of Object.entries(r)) {
        if (!IDENT.test(k)) throw bad(`bad column "${k.slice(0, 40)}" in ${name}`);
        if (v === null || typeof v === "string") row[k] = v;
        else if (typeof v === "number" && Number.isFinite(v)) row[k] = v;
        else if (typeof v === "boolean") row[k] = v ? 1 : 0;
        else throw bad(`bad value in ${name}.${k}`);
      }
      out.push(row);
    }
    tables[name] = out;
  }
  let media: BackupMedia[] | undefined;
  if (input.media !== undefined) {
    if (!Array.isArray(input.media) || input.media.length > 5000) throw bad("bad media");
    media = [];
    let mediaBytes = 0;
    for (const m of input.media) {
      if (!isObj(m) || typeof m.name !== "string" || typeof m.data !== "string") throw bad("bad media entry");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(m.name)) throw bad("bad media name");
      if (m.data.length > 96 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) throw bad("bad media data");
      mediaBytes += Math.floor(m.data.length * 0.75);
      if (mediaBytes > 192 * 1024 * 1024) throw bad("backup media is too large");
      media.push({ name: m.name, data: m.data });
    }
  }
  const settings: Array<{ key: string; value: string }> = [];
  if (input.settings !== undefined) {
    if (!Array.isArray(input.settings)) throw bad("bad settings");
    for (const s of input.settings) {
      if (!isObj(s) || typeof s.key !== "string" || typeof s.value !== "string" || !s.key || s.key.length > 128) throw bad("bad setting");
      if (s.key === "schema_version" || s.key === "fts5") continue; // owned by the app, never by a backup
      settings.push({ key: s.key, value: s.value });
    }
  }
  return { format, createdAt, schemaVersion: sv, tables, settings, ...(media ? { media } : {}) };
}

// ---------------------------------------------------------------- KDF calibration
/** Candidate Argon2id parameters, strongest first. Floor is m=8192,t=3 (never below). */
export const KDF_LADDER: readonly KdfParams[] = [
  { m: 19456, t: 2, p: 1 },
  { m: 16384, t: 3, p: 1 },
  { m: 12288, t: 3, p: 1 },
  { m: 8192, t: 3, p: 1 },
];
export const KDF_BUDGET_MS = 6000;

/** One real Argon2id derivation with throwaway inputs; returns wall-clock ms on this JS engine. */
export async function timeKdf(k: KdfParams, now: () => number = Date.now): Promise<number> {
  const t0 = now();
  await argon2idAsync(new Uint8Array(16).fill(7), new Uint8Array(16).fill(9), { t: k.t, m: k.m, p: k.p, dkLen: 32, asyncTick: 10 });
  return now() - t0;
}

/**
 * Measures the first rung once, then walks the ladder using cost ~ m*t. Returns the strongest rung
 * predicted within budget, or the floor. `measure` runs one real Argon2id derivation and returns ms.
 */
export async function calibrateKdf(
  measure: (k: KdfParams) => Promise<number>,
  budgetMs = KDF_BUDGET_MS,
): Promise<{ kdf: KdfParams; measuredMs: number }> {
  const first = KDF_LADDER[0]!;
  const ms = await measure(first);
  if (ms <= budgetMs) return { kdf: first, measuredMs: ms };
  const unit = ms / (first.m * first.t);
  for (const k of KDF_LADDER.slice(1)) if (unit * k.m * k.t <= budgetMs) return { kdf: k, measuredMs: ms };
  return { kdf: KDF_LADDER[KDF_LADDER.length - 1]!, measuredMs: ms };
}

// ---------------------------------------------------------------- snapshot retention
export const SNAPSHOT_RE = /^snap-(\d{13})-([a-z0-9-]+)\.pesabak$/;
export const snapshotName = (ts: number, reason: string) => `snap-${String(ts).padStart(13, "0")}-${reason.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "x"}.pesabak`;

/** Names to delete so only the newest `keep` snapshots remain. Unrecognised names are never selected. */
export function snapshotsToPrune(names: readonly string[], keep = 3): string[] {
  const snaps = names.filter((n) => SNAPSHOT_RE.test(n)).sort((a, b) => b.localeCompare(a));
  return snaps.slice(Math.max(0, keep));
}
/** Newest snapshot name, or null. */
export function newestSnapshot(names: readonly string[]): string | null {
  return names.filter((n) => SNAPSHOT_RE.test(n)).sort((a, b) => b.localeCompare(a))[0] ?? null;
}

// ---------------------------------------------------------------- passphrase hint
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (p.length < 8) return { score: 0, label: "Too short (minimum 8 characters)" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const uniq = new Set(p).size;
  if (p.length >= 16 || (p.length >= 12 && classes >= 3 && uniq >= 8)) return { score: 3, label: "Strong" };
  if (p.length >= 12 || (classes >= 3 && uniq >= 6)) return { score: 2, label: "Fair" };
  return { score: 1, label: "Weak: use a longer phrase of several words" };
}
