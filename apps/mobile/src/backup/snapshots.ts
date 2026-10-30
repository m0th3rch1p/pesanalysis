import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";
import { newestSnapshot, snapshotName, snapshotsToPrune } from "@yako/core";
import { randomHex } from "../../modules/yako-sms";
import { createBackupBytesRaw } from "./ledger";

/**
 * Local safety snapshots: same .pesabak container, keyed by a random 256-bit secret in SecureStore
 * (no prompt, no recovery code). The secret is high-entropy, so the Argon2id slot uses minimal cost.
 */
const SECRET_KEY = "yako.backup.snapkey";
const KEEP = 3;
export const SNAPSHOT_KDF = { t: 1, m: 64, p: 1 };

function dir(): Directory {
  const d = new Directory(Paths.document, "snapshots");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}
const nameOf = (f: File) => decodeURIComponent(f.uri.split("/").pop() ?? "");

export async function snapshotSecret(create = true): Promise<string | null> {
  const s = await SecureStore.getItemAsync(SECRET_KEY);
  if (s || !create) return s;
  const fresh = randomHex(32);
  await SecureStore.setItemAsync(SECRET_KEY, fresh);
  return fresh;
}

function files(): File[] {
  try { return dir().list().filter((f): f is File => f instanceof File); } catch { return []; }
}

export interface SnapshotInfo { name: string; createdAt: number; reason: string; bytes: number }

export function listSnapshots(): SnapshotInfo[] {
  return files().map((f) => {
    const m = /^snap-(\d{13})-([a-z0-9-]+)\.pesabak$/.exec(nameOf(f));
    return m ? { name: nameOf(f), createdAt: Number(m[1]), reason: m[2]!, bytes: f.size ?? 0 } : null;
  }).filter((x): x is SnapshotInfo => !!x).sort((a, b) => b.createdAt - a.createdAt);
}

/** Writes an encrypted snapshot of the current ledger and prunes to the newest 3. Throws on failure. */
export async function takeSafetySnapshot(db: SQLiteDatabase, reason: string): Promise<SnapshotInfo> {
  const secret = (await snapshotSecret(true))!;
  const bytes = await createBackupBytesRaw(db, { passphrase: secret, kdf: SNAPSHOT_KDF, recovery: false });
  const name = snapshotName(Date.now(), reason);
  const file = new File(dir(), name);
  file.writeSync(bytes);
  if ((file.size ?? 0) !== bytes.length) { try { file.delete(); } catch { /* ignore */ } throw new Error("snapshot write verification failed"); }
  const names = files().map(nameOf);
  for (const n of snapshotsToPrune(names, KEEP)) { try { new File(dir(), n).delete(); } catch { /* ignore */ } }
  return { name, createdAt: Date.now(), reason, bytes: bytes.length };
}

/** Bytes + secret of the newest snapshot, or null when none exists. */
export async function latestSnapshot(): Promise<{ info: SnapshotInfo; bytes: Uint8Array; secret: string } | null> {
  const name = newestSnapshot(files().map(nameOf));
  const secret = await snapshotSecret(false);
  if (!name || !secret) return null;
  const info = listSnapshots().find((s) => s.name === name);
  if (!info) return null;
  return { info, bytes: await new File(dir(), name).bytes(), secret };
}

export async function eraseSnapshots(): Promise<void> {
  for (const f of files()) { try { f.delete(); } catch { /* ignore */ } }
  await SecureStore.deleteItemAsync(SECRET_KEY).catch(() => undefined);
}
