import type { SQLiteDatabase } from "expo-sqlite";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { SearchHit } from "@yako/core";

/**
 * Backup facade (D91). Plaintext JSON backups no longer exist: every file is a .pesabak container.
 * Logic lives in ./backup/*. CSV export below is an explicit user action on the cache directory only.
 */
export { createBackupBytes, restoreFromBytes, serializeLedger, BACKUP_TABLES } from "./backup/ledger";
export type { CreatedBackup, RestoreResult, RestoreSecret } from "./backup/ledger";
export { takeSafetySnapshot, latestSnapshot, listSnapshots, eraseSnapshots } from "./backup/snapshots";
export { shareBackupBytes, pickBackupBytes, resetEverything, deleteLegacyPlaintext, hasLegacyPlaintext, wipeSideData, backupFileName } from "./backup/files";
export { getBackupKdf } from "./backup/crypto";

export function exportCsv(rows: SearchHit[], db: SQLiteDatabase): File {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["date", "time", "counterparty", "label", "direction", "amount_kes", "fee_kes", "kind", "status", "tags", "note"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const d = new Date(r.occurredAt + 3 * 3_600_000);
    lines.push([
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
      r.cpName ?? "", r.label ?? "", r.direction, (r.amount / 100).toFixed(2), ((r.fee ?? 0) / 100).toFixed(2),
      r.kind, r.status, r.tags ?? "", r.note ?? "",
    ].map(esc).join(","));
  }
  const dir = new Directory(Paths.cache, "exports");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `pesanalysis-export-${Date.now()}.csv`);
  file.writeSync(lines.join("\n"));
  return file;
}

export async function shareFile(file: File, mime: string, title: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing is not available");
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: title });
}
