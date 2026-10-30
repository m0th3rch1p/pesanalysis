import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import * as SecureStore from "expo-secure-store";
import type { SQLiteDatabase } from "expo-sqlite";
import { resetAllData, seedTaxonomy } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { resetCapture } from "../../modules/yako-sms";
import { runNightlyOnDevice } from "../nightly";
import { takeSafetySnapshot } from "./snapshots";

/** Exports are written to the cache (never document storage) and handed to the share sheet. The
 * file is kept briefly because the receiving app may still be reading the content URI when the
 * share dialog returns. The whole cache export directory is wiped by reset/wipeSideData. */
function exportDir(): Directory {
  const d = new Directory(Paths.cache, "backup-export");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function backupFileName(now = Date.now()): string {
  return `pesanalysis-${new Date(now).toISOString().replace(/[:.]/g, "-")}.pesabak`;
}

/** Share sheet export (Files, Drive, email, nearby share...). Works without Google. */
export async function shareBackupBytes(bytes: Uint8Array, name = backupFileName()): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing is not available on this device");
  const dir = exportDir();
  // Keep only a handful of recent exports; never delete the file the share sheet is currently using.
  try {
    const old = dir.list().filter((f): f is File => f instanceof File).sort((a, b) => (a.creationTime ?? 0) - (b.creationTime ?? 0));
    for (const f of old.slice(0, Math.max(0, old.length - 4))) { try { f.delete(); } catch { /* in use */ } }
  } catch { /* cache listing is optional */ }
  const f = new File(dir, name);
  f.writeSync(bytes);
  if ((f.size ?? 0) !== bytes.length) throw new Error("could not write the backup file");
  await Sharing.shareAsync(f.uri, { mimeType: "application/octet-stream", dialogTitle: "Save encrypted Pesanalysis backup" });
}

/** Document picker for a .pesabak. Returns the bytes (read fully into memory) or null when cancelled. */
export async function pickBackupBytes(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
  if (r.canceled || !r.assets[0]) return null;
  const f = new File(r.assets[0].uri);
  try {
    if ((f.size ?? 0) > 256 * 1024 * 1024) throw new Error("file is too large to be a Pesanalysis backup");
    return { bytes: await f.bytes(), name: r.assets[0].name };
  } finally {
    try { f.delete(); } catch { /* picker cache copy */ }
  }
}

function rmDir(d: Directory): number {
  let n = 0;
  try {
    if (!d.exists) return 0;
    n = d.list().length;
    d.delete();
  } catch { /* best effort */ }
  return n;
}

/** True when old plaintext JSON/CSV backups from earlier builds are still on disk. */
export function hasLegacyPlaintext(): boolean {
  try {
    const d = new Directory(Paths.document, "backups");
    return d.exists && d.list().some((f) => f instanceof File && /\.(json|csv)$/i.test(f.uri));
  } catch { return false; }
}

/** Deletes legacy plaintext backups/exports. Safe to call on every start. */
export function deleteLegacyPlaintext(): number {
  let n = 0;
  try {
    const d = new Directory(Paths.document, "backups");
    if (d.exists) {
      for (const f of d.list()) {
        if (f instanceof File && /\.(json|csv)$/i.test(f.uri)) { try { f.delete(); n++; } catch { /* ignore */ } }
      }
    }
    for (const f of Paths.document.list()) {
      if (f instanceof File && /^pesanalysis-z1-.*\.json$/.test(decodeURIComponent(f.uri.split("/").pop() ?? ""))) { try { f.delete(); n++; } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  n += rmDir(new Directory(Paths.cache, "exports"));
  return n;
}

const SECRET_KEYS = ["z1.host.url", "z1.host.token"];

/** Everything outside the database that reset must remove. Snapshots are kept so reset can be undone. */
export async function wipeSideData(): Promise<void> {
  rmDir(new Directory(Paths.document, "attachments"));
  rmDir(new Directory(Paths.document, "backups"));
  rmDir(new Directory(Paths.document, "maps"));
  rmDir(new Directory(Paths.document, "lab"));
  rmDir(new Directory(Paths.cache, "exports"));
  rmDir(new Directory(Paths.cache, "backup-export"));
  rmDir(new Directory(Paths.cache, "restore-media"));
  deleteLegacyPlaintext();
  for (const k of SECRET_KEYS) await SecureStore.deleteItemAsync(k).catch(() => undefined);
}

/** Snapshot first (abort if it fails), then wipe database, native capture queue, media, tokens and packs. */
export async function resetEverything(db: SQLiteDatabase): Promise<{ snapshot: string }> {
  const snap = await takeSafetySnapshot(db, "pre-reset");
  const a = asDbAdapter(db);
  resetAllData(a);
  try { await resetCapture(Date.now()); } catch { /* DB is already empty; native queue drain is best-effort */ }
  seedTaxonomy(a);
  // Resetting data is not a fresh install: keep the user inside the app with the default taxonomy.
  a.run(`INSERT INTO meta (key, value) VALUES ('onboarded', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  await wipeSideData();
  try { runNightlyOnDevice(db); } catch { /* empty ledger */ }
  return { snapshot: snap.name };
}
