import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BackupError, CHUNK, decryptBackup, encryptBackup, isRecoveryCodeShape, newRecoveryCode, peekHeader } from "../src/backup/container.js";

const rng = (n: number) => new Uint8Array(randomBytes(n));
const FAST = { t: 1, m: 64, p: 1 }; // tests only; production uses DEFAULT_KDF
const PASS = "correct horse battery";
const data = (n: number) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + 7) & 255; return u; };

test("round trip across chunk boundaries (0, 1, CHUNK-1, CHUNK, CHUNK+1, 3 chunks)", async () => {
  for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3 + 17]) {
    const p = data(n);
    const { bytes } = await encryptBackup(p, { passphrase: PASS, rng, kdf: FAST });
    assert.deepEqual(await decryptBackup(bytes, { passphrase: PASS }), p, `n=${n}`);
  }
});

test("recovery code opens the backup; shape helper works; wrong secrets fail with auth", async () => {
  const p = data(1000);
  const { bytes, recoveryCode } = await encryptBackup(p, { passphrase: PASS, rng, kdf: FAST });
  assert.ok(recoveryCode && isRecoveryCodeShape(recoveryCode));
  assert.deepEqual(await decryptBackup(bytes, { recoveryCode: recoveryCode!.toLowerCase().replaceAll("-", " ") }), p);
  await assert.rejects(decryptBackup(bytes, { passphrase: "wrong passphrase" }), (e: BackupError) => e.code === "auth");
  await assert.rejects(decryptBackup(bytes, { recoveryCode: newRecoveryCode(rng) }), (e: BackupError) => e.code === "auth");
  await assert.rejects(decryptBackup(bytes, {}), (e: BackupError) => e.code === "auth");
});

test("no recovery slot when disabled", async () => {
  const { bytes, recoveryCode } = await encryptBackup(data(10), { passphrase: PASS, rng, kdf: FAST, recovery: false });
  assert.equal(recoveryCode, null);
  assert.equal(peekHeader(bytes).slots.length, 1);
});

test("tampering is detected: any flipped byte, truncation, trailing bytes, chunk reorder", async () => {
  const p = data(CHUNK * 2 + 5);
  const { bytes } = await encryptBackup(p, { passphrase: PASS, rng, kdf: FAST });
  for (const pos of [bytes.length - 1, bytes.length - 40, Math.floor(bytes.length / 2), 30, 12]) {
    const b = bytes.slice(); b[pos] = (b[pos] ?? 0) ^ 1;
    await assert.rejects(decryptBackup(b, { passphrase: PASS }), BackupError, `flip@${pos}`);
  }
  await assert.rejects(decryptBackup(bytes.slice(0, bytes.length - 10), { passphrase: PASS }), BackupError);
  const extra = new Uint8Array(bytes.length + 1); extra.set(bytes);
  await assert.rejects(decryptBackup(extra, { passphrase: PASS }), (e: BackupError) => e.code === "format");
  // swap the first two chunks
  const hl = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0);
  const start = 12 + hl;
  const l0 = new DataView(bytes.buffer, bytes.byteOffset + start, 4).getUint32(0);
  const l1 = new DataView(bytes.buffer, bytes.byteOffset + start + 4 + l0, 4).getUint32(0);
  const c0 = bytes.slice(start, start + 4 + l0), c1 = bytes.slice(start + 4 + l0, start + 8 + l0 + l1);
  const swapped = bytes.slice(); swapped.set(c1, start); swapped.set(c0, start + c1.length);
  await assert.rejects(decryptBackup(swapped, { passphrase: PASS }), BackupError);
});

test("chunks cannot be spliced between two backups", async () => {
  const a = await encryptBackup(data(CHUNK * 2), { passphrase: PASS, rng, kdf: FAST, recovery: false });
  const b = await encryptBackup(data(CHUNK * 2), { passphrase: PASS, rng, kdf: FAST, recovery: false });
  const hl = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset + 8, 4).getUint32(0);
  const spliced = a.bytes.slice(0, 12 + hl(a.bytes) + 4 + 1); // keep header of a ...
  const tail = b.bytes.slice(12 + hl(b.bytes));                 // ... chunks of b
  const mix = new Uint8Array(12 + hl(a.bytes) + tail.length); mix.set(a.bytes.slice(0, 12 + hl(a.bytes))); mix.set(tail, 12 + hl(a.bytes));
  await assert.rejects(decryptBackup(mix, { passphrase: PASS }), BackupError);
  void spliced;
});

test("format guards and KDF parameter ceiling", async () => {
  await assert.rejects(decryptBackup(new Uint8Array(5), { passphrase: PASS }), (e: BackupError) => e.code === "format");
  await assert.rejects(encryptBackup(data(1), { passphrase: "short", rng, kdf: FAST }), (e: BackupError) => e.code === "params");
  const { bytes } = await encryptBackup(data(10), { passphrase: PASS, rng, kdf: FAST, recovery: false });
  // forge a hostile KDF cost in the header (and fix up the length): rejected before any KDF work
  const hl = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0);
  const hjson = new TextDecoder().decode(bytes.slice(12, 12 + hl)).replace('"m":64', '"m":9999999');
  const hb = new TextEncoder().encode(hjson);
  const out = new Uint8Array(12 + hb.length + (bytes.length - 12 - hl));
  out.set(bytes.slice(0, 8)); new DataView(out.buffer).setUint32(8, hb.length); out.set(hb, 12); out.set(bytes.slice(12 + hl), 12 + hb.length);
  await assert.rejects(decryptBackup(out, { passphrase: PASS }), (e: BackupError) => e.code === "params");
});

test("two encryptions of the same data differ (fresh keys, salts, nonces)", async () => {
  const p = data(100);
  const a = await encryptBackup(p, { passphrase: PASS, rng, kdf: FAST });
  const b = await encryptBackup(p, { passphrase: PASS, rng, kdf: FAST });
  assert.notDeepEqual(a.bytes, b.bytes);
});
