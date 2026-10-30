/**
 * Media at rest (C4): per-file XChaCha20-Poly1305 chunk stream.
 *
 *   file  = header(52) | sealed chunk 0 | ... | sealed chunk N-1      (each sealed chunk = <=CHUNK bytes + 16 tag)
 *   header= "YMED" | ver(1) | chunk u32 | salt(16) | noncePrefix(16) | plainLen u64
 *
 * A random master key (kept in SecureStore, never in a backup) is mixed with the per-file salt through HKDF, so every
 * file has its own key and nonce space. Each chunk is authenticated against sha256(header), its index and a "final"
 * flag: truncation, reordering, appended data, chunk splicing between files and header tampering all fail.
 * The chunk API is incremental so the app can stream large videos through FileHandle without holding them in memory;
 * the whole-buffer helpers are for photos and tests. Same primitives and layout style as the .pesabak container.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Rng } from "../backup/container.js";

export const MEDIA_MAGIC = "YMED";
export const MEDIA_VERSION = 1;
export const MEDIA_CHUNK = 64 * 1024;
export const MEDIA_HEADER_BYTES = 4 + 1 + 4 + 16 + 16 + 8; // 49
export const TAG = 16;
const TE = new TextEncoder();

export class MediaCryptoError extends Error {
  constructor(public code: "format" | "version" | "auth" | "truncated", msg: string) { super(msg); }
}

const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };

export function chunkCount(plainLen: number, chunk = MEDIA_CHUNK): number { return Math.max(1, Math.ceil(plainLen / chunk)); }
/** Exact ciphertext file size for a plaintext of `plainLen` bytes. */
export function sealedLength(plainLen: number, chunk = MEDIA_CHUNK): number { return MEDIA_HEADER_BYTES + plainLen + chunkCount(plainLen, chunk) * TAG; }

export function isEncryptedMedia(head: Uint8Array): boolean {
  if (head.length < 5) return false;
  for (let i = 0; i < 4; i++) if (head[i] !== MEDIA_MAGIC.charCodeAt(i)) return false;
  return head[4] === MEDIA_VERSION;
}

function fileKey(master: Uint8Array, salt: Uint8Array): Uint8Array {
  if (master.length !== 32) throw new MediaCryptoError("format", "media master key must be 32 bytes");
  return hkdf(sha256, master, salt, TE.encode("yako media file key v1"), 32);
}
const nonce = (prefix: Uint8Array, i: number) => concat(prefix, u64(i));
const aad = (headerHash: Uint8Array, i: number, final: boolean) => concat(headerHash, u32(i), Uint8Array.of(final ? 1 : 0));

export class MediaEncryptor {
  readonly header: Uint8Array;
  private readonly key: Uint8Array;
  private readonly prefix: Uint8Array;
  private readonly hash: Uint8Array;
  private index = 0;
  private readonly count: number;
  constructor(master: Uint8Array, readonly plainLen: number, rng: Rng, readonly chunk = MEDIA_CHUNK) {
    const salt = rng(16);
    this.prefix = rng(16);
    this.key = fileKey(master, salt);
    this.header = concat(TE.encode(MEDIA_MAGIC), Uint8Array.of(MEDIA_VERSION), u32(chunk), salt, this.prefix, u64(plainLen));
    this.hash = sha256(this.header);
    this.count = chunkCount(plainLen, chunk);
  }
  /** Seal the next plaintext chunk. Chunks must be exactly `chunk` bytes except the last. */
  seal(plain: Uint8Array): Uint8Array {
    if (this.index >= this.count) throw new MediaCryptoError("format", "more chunks than declared");
    const final = this.index === this.count - 1;
    const expect = final ? this.plainLen - this.index * this.chunk : this.chunk;
    if (plain.length !== expect) throw new MediaCryptoError("format", `chunk ${this.index} is ${plain.length} bytes, expected ${expect}`);
    const out = xchacha20poly1305(this.key, nonce(this.prefix, this.index), aad(this.hash, this.index, final)).encrypt(plain);
    this.index++;
    return out;
  }
  get done(): boolean { return this.index === this.count; }
}

export function parseMediaHeader(head: Uint8Array): { chunk: number; salt: Uint8Array; prefix: Uint8Array; plainLen: number; raw: Uint8Array } {
  if (head.length < MEDIA_HEADER_BYTES || !isEncryptedMedia(head)) throw new MediaCryptoError("format", "not an encrypted media file");
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const chunk = dv.getUint32(5);
  const plainLenBig = dv.getBigUint64(4 + 1 + 4 + 16 + 16);
  if (chunk < 1024 || chunk > 16 * 1024 * 1024) throw new MediaCryptoError("format", "bad chunk size");
  if (plainLenBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaCryptoError("format", "bad length");
  return { chunk, salt: head.slice(9, 25), prefix: head.slice(25, 41), plainLen: Number(plainLenBig), raw: head.slice(0, MEDIA_HEADER_BYTES) };
}

export class MediaDecryptor {
  readonly plainLen: number;
  readonly chunk: number;
  private readonly key: Uint8Array;
  private readonly prefix: Uint8Array;
  private readonly hash: Uint8Array;
  private index = 0;
  private readonly count: number;
  constructor(master: Uint8Array, head: Uint8Array) {
    const h = parseMediaHeader(head);
    this.plainLen = h.plainLen; this.chunk = h.chunk; this.prefix = h.prefix;
    this.key = fileKey(master, h.salt);
    this.hash = sha256(h.raw);
    this.count = chunkCount(h.plainLen, h.chunk);
  }
  /** Size in bytes of the next sealed chunk to read from the file (0 when finished). */
  nextSealedSize(): number {
    if (this.index >= this.count) return 0;
    const final = this.index === this.count - 1;
    return (final ? this.plainLen - this.index * this.chunk : this.chunk) + TAG;
  }
  open(sealed: Uint8Array): Uint8Array {
    const want = this.nextSealedSize();
    if (!want) throw new MediaCryptoError("format", "trailing data");
    if (sealed.length !== want) throw new MediaCryptoError("truncated", "chunk is shorter than declared");
    const final = this.index === this.count - 1;
    try {
      const out = xchacha20poly1305(this.key, nonce(this.prefix, this.index), aad(this.hash, this.index, final)).decrypt(sealed);
      this.index++;
      return out;
    } catch { throw new MediaCryptoError("auth", "media chunk failed authentication"); }
  }
  get done(): boolean { return this.index === this.count; }
}

export function encryptMedia(plain: Uint8Array, master: Uint8Array, rng: Rng, chunk = MEDIA_CHUNK): Uint8Array {
  const enc = new MediaEncryptor(master, plain.length, rng, chunk);
  const parts: Uint8Array[] = [enc.header];
  const n = chunkCount(plain.length, chunk);
  for (let i = 0; i < n; i++) parts.push(enc.seal(plain.subarray(i * chunk, Math.min(plain.length, (i + 1) * chunk))));
  return concat(...parts);
}

export function decryptMedia(bytes: Uint8Array, master: Uint8Array): Uint8Array {
  const dec = new MediaDecryptor(master, bytes.subarray(0, MEDIA_HEADER_BYTES));
  if (bytes.length !== sealedLength(dec.plainLen, dec.chunk)) {
    throw new MediaCryptoError(bytes.length < sealedLength(dec.plainLen, dec.chunk) ? "truncated" : "format", "file length does not match header");
  }
  const parts: Uint8Array[] = [];
  let at = MEDIA_HEADER_BYTES;
  while (!dec.done) {
    const n = dec.nextSealedSize();
    parts.push(dec.open(bytes.subarray(at, at + n)));
    at += n;
  }
  return concat(...parts);
}
