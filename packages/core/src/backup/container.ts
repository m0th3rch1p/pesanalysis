/**
 * .pesabak container (D91). Encrypted-or-absent backups.
 *
 *   header (JSON, authenticated) | chunks
 *   - A random 256-bit data key (DEK) encrypts the payload in 64 KiB XChaCha20-Poly1305 chunks.
 *   - The DEK is wrapped twice: by a passphrase slot (Argon2id) and by a recovery-code slot (HKDF; the code
 *     is 160 random bits so it needs no slow KDF). Either opens the backup; neither is stored anywhere.
 *   - Every chunk is bound to the header hash, its index and a "final" flag: reordering, truncation,
 *     splicing from another backup and header tampering all fail authentication.
 * Randomness and KDF cost are injectable so the app can use the native CSPRNG (Hermes has no crypto global)
 * and tune Argon2id on the real device. Pure TypeScript; no native code.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const MAGIC = "PESABAK";
export const VERSION = 1;
export const CHUNK = 64 * 1024;
const TE = new TextEncoder();
const TD = new TextDecoder();

export type Rng = (n: number) => Uint8Array;

export interface KdfParams { t: number; m: number; p: number }
/** OWASP-class minimum for Argon2id (19 MiB, t=2, p=1). Raise on devices that can afford it. */
export const DEFAULT_KDF: KdfParams = { t: 2, m: 19456, p: 1 };
/** Upper bound accepted on restore, so a hostile file cannot demand gigabytes. */
const MAX_KDF_M = 256 * 1024;
const MAX_KDF_T = 12;

interface Slot { type: "passphrase" | "recovery"; salt: string; nonce: string; wrapped: string; kdf?: KdfParams }
interface Header {
  magic: typeof MAGIC; version: number; created: number; app: string;
  prefix: string; chunk: number; chunks: number; plainBytes: number; slots: Slot[];
  meta?: Record<string, string | number>;
}

export class BackupError extends Error {
  constructor(public code: "format" | "version" | "auth" | "truncated" | "params", msg: string) { super(msg); }
}

// ---------------------------------------------------------------- encoding helpers
const b64 = (u: Uint8Array) => {
  let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };

// ---------------------------------------------------------------- recovery code
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, no 0/1/8/9 confusion
/** 160 random bits as 8 groups of 4 base32 chars: XXXX-XXXX-... (32 chars). */
export function newRecoveryCode(rng: Rng): string {
  const bytes = rng(20);
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g)!.join("-");
}
export function normaliseRecoveryCode(code: string): string { return code.toUpperCase().replace(/[^A-Z2-7]/g, ""); }
export function isRecoveryCodeShape(code: string): boolean { return normaliseRecoveryCode(code).length === 32; }

// ---------------------------------------------------------------- key derivation
async function kekFromPassphrase(pass: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(TE.encode(pass.normalize("NFKC")), salt, { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: 32, asyncTick: 10 });
}
function kekFromRecovery(code: string, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, TE.encode(normaliseRecoveryCode(code)), salt, TE.encode("pesabak recovery kek v1"), 32);
}

const chunkNonce = (prefix: Uint8Array, i: number) => concat(prefix, u64(i)); // 16 + 8 = 24 bytes
const chunkAad = (headerHash: Uint8Array, i: number, final: boolean) => concat(headerHash, u32(i), Uint8Array.of(final ? 1 : 0));

export interface EncryptOpts {
  passphrase: string;
  rng: Rng;
  kdf?: KdfParams;
  now?: number;
  app?: string;
  meta?: Record<string, string | number>;
  /** Generate a recovery code slot (default true). The code is returned once and never stored. */
  recovery?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface Encrypted { bytes: Uint8Array; recoveryCode: string | null }

export async function encryptBackup(plain: Uint8Array, o: EncryptOpts): Promise<Encrypted> {
  if (o.passphrase.length < 8) throw new BackupError("params", "passphrase must be at least 8 characters");
  const kdf = o.kdf ?? DEFAULT_KDF;
  const dek = o.rng(32);
  const slots: Slot[] = [];
  const wrap = (type: Slot["type"], kek: Uint8Array, salt: Uint8Array, k?: KdfParams) => {
    const nonce = o.rng(24);
    const wrapped = xchacha20poly1305(kek, nonce, TE.encode(`slot:${type}`)).encrypt(dek);
    slots.push({ type, salt: b64(salt), nonce: b64(nonce), wrapped: b64(wrapped), ...(k ? { kdf: k } : {}) });
  };
  const pSalt = o.rng(16);
  wrap("passphrase", await kekFromPassphrase(o.passphrase, pSalt, kdf), pSalt, kdf);
  let recoveryCode: string | null = null;
  if (o.recovery !== false) {
    recoveryCode = newRecoveryCode(o.rng);
    const rSalt = o.rng(16);
    wrap("recovery", kekFromRecovery(recoveryCode, rSalt), rSalt);
  }
  const chunks = Math.max(1, Math.ceil(plain.length / CHUNK));
  const header: Header = {
    magic: MAGIC, version: VERSION, created: o.now ?? Date.now(), app: o.app ?? "pesanalysis",
    prefix: b64(o.rng(16)), chunk: CHUNK, chunks, plainBytes: plain.length, slots, ...(o.meta ? { meta: o.meta } : {}),
  };
  const hjson = TE.encode(JSON.stringify(header));
  const hhash = sha256(hjson);
  const parts: Uint8Array[] = [TE.encode(MAGIC), Uint8Array.of(VERSION), u32(hjson.length), hjson];
  const prefix = unb64(header.prefix);
  for (let i = 0; i < chunks; i++) {
    const slice = plain.subarray(i * CHUNK, Math.min(plain.length, (i + 1) * CHUNK));
    const ct = xchacha20poly1305(dek, chunkNonce(prefix, i), chunkAad(hhash, i, i === chunks - 1)).encrypt(slice);
    parts.push(u32(ct.length), ct);
    o.onProgress?.(i + 1, chunks);
  }
  dek.fill(0);
  return { bytes: concat(...parts), recoveryCode };
}

/** Reads the authenticated-in-use header without any secret (for UI: date, size, needs-passphrase). */
export function peekHeader(bytes: Uint8Array): Header {
  const m = TE.encode(MAGIC);
  if (bytes.length < m.length + 5 || !m.every((c, i) => bytes[i] === c)) throw new BackupError("format", "not a .pesabak file");
  if (bytes[m.length] !== VERSION) throw new BackupError("version", `unsupported backup version ${bytes[m.length]}`);
  const hl = new DataView(bytes.buffer, bytes.byteOffset + m.length + 1, 4).getUint32(0);
  if (hl > 64 * 1024 || m.length + 5 + hl > bytes.length) throw new BackupError("format", "bad header");
  try { return JSON.parse(TD.decode(bytes.subarray(m.length + 5, m.length + 5 + hl))) as Header; }
  catch { throw new BackupError("format", "bad header"); }
}

export interface DecryptOpts { passphrase?: string; recoveryCode?: string; onProgress?: (done: number, total: number) => void }

export async function decryptBackup(bytes: Uint8Array, o: DecryptOpts): Promise<Uint8Array> {
  const header = peekHeader(bytes);
  const m = MAGIC.length;
  const hl = new DataView(bytes.buffer, bytes.byteOffset + m + 1, 4).getUint32(0);
  const hjson = bytes.subarray(m + 5, m + 5 + hl);
  const hhash = sha256(hjson);
  if (header.chunk !== CHUNK || !Number.isInteger(header.chunks) || header.chunks < 1) throw new BackupError("format", "bad chunking");

  let dek: Uint8Array | null = null;
  for (const slot of header.slots) {
    try {
      let kek: Uint8Array | null = null;
      if (slot.type === "passphrase" && o.passphrase != null) {
        const k = slot.kdf!;
        if (!(k.m <= MAX_KDF_M && k.t <= MAX_KDF_T && k.p >= 1 && k.p <= 4 && k.t >= 1 && k.m >= 8)) throw new BackupError("params", "KDF parameters out of range");
        kek = await kekFromPassphrase(o.passphrase, unb64(slot.salt), k);
      } else if (slot.type === "recovery" && o.recoveryCode != null) {
        kek = kekFromRecovery(o.recoveryCode, unb64(slot.salt));
      }
      if (!kek) continue;
      dek = xchacha20poly1305(kek, unb64(slot.nonce), TE.encode(`slot:${slot.type}`)).decrypt(unb64(slot.wrapped));
      break;
    } catch (e) { if (e instanceof BackupError) throw e; /* wrong secret for this slot */ }
  }
  if (!dek) throw new BackupError("auth", "wrong passphrase or recovery code");

  const prefix = unb64(header.prefix);
  const out = new Uint8Array(header.plainBytes);
  let pos = m + 5 + hl, written = 0;
  for (let i = 0; i < header.chunks; i++) {
    if (pos + 4 > bytes.length) throw new BackupError("truncated", "backup is truncated");
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    pos += 4;
    if (len > CHUNK + 16 || pos + len > bytes.length) throw new BackupError("truncated", "backup is truncated or corrupt");
    let pt: Uint8Array;
    try { pt = xchacha20poly1305(dek, chunkNonce(prefix, i), chunkAad(hhash, i, i === header.chunks - 1)).decrypt(bytes.subarray(pos, pos + len)); }
    catch { throw new BackupError("auth", `chunk ${i + 1} failed authentication (corrupt or tampered)`); }
    if (written + pt.length > out.length) throw new BackupError("format", "payload larger than declared");
    out.set(pt, written); written += pt.length; pos += len;
    o.onProgress?.(i + 1, header.chunks);
  }
  dek.fill(0);
  if (written !== header.plainBytes) throw new BackupError("truncated", "payload shorter than declared");
  if (pos !== bytes.length) throw new BackupError("format", "trailing bytes after final chunk");
  return out;
}
