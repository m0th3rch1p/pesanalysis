import type { SQLiteDatabase } from "expo-sqlite";
import { Directory, File, Paths } from "expo-file-system";
import { reindexTx } from "@yako/core";
import { asDbAdapter } from "./db/open";

export interface Attachment {
  id: number;
  txId: number;
  kind: "photo" | "video" | "voice" | "document";
  uri: string;
  mime: string | null;
  bytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  createdAt: number;
}

function attachmentsDir(): Directory {
  const dir = new Directory(Paths.document, "attachments");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Copy picked media into app-private storage (D41). The DB stores only the relative file URI. */
export function copyIntoApp(uri: string, txId: number, ext: string): { uri: string; bytes: number } {
  const dir = attachmentsDir();
  const cleanExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  const dest = new File(dir, `${txId}-${Date.now()}.${cleanExt}`);
  const src = new File(uri);
  src.copySync(dest);
  // Picker/recorder originals often live in the cache. Copying leaves a plaintext duplicate behind;
  // remove only cache-local originals, never a user's gallery/library file.
  try {
    if (src.uri.startsWith(Paths.cache.uri) && src.uri !== dest.uri) src.delete();
  } catch { /* source may be a content URI or already gone */ }
  return { uri: dest.uri.replace(/^file:\/\//, ""), bytes: dest.size ?? 0 };
}

export function addAttachment(db: SQLiteDatabase, a: Omit<Attachment, "id" | "createdAt">): number {
  const r = db.runSync(
    `INSERT INTO attachments (tx_id, kind, uri, mime, bytes, duration_ms, width, height, caption, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.txId, a.kind, a.uri, a.mime, a.bytes, a.durationMs, a.width, a.height, a.caption, Date.now()],
  );
  reindexTx(asDbAdapter(db), a.txId);
  return Number(r.lastInsertRowId);
}

export function attachmentsFor(db: SQLiteDatabase, txId: number): Attachment[] {
  return db.getAllSync(
    `SELECT id, tx_id AS txId, kind, uri, mime, bytes, duration_ms AS durationMs, width, height, caption, created_at AS createdAt
       FROM attachments WHERE tx_id = ? ORDER BY created_at`,
    [txId],
  ) as Attachment[];
}

export function deleteAttachment(db: SQLiteDatabase, id: number): void {
  const row = db.getFirstSync<{ uri: string; tx_id: number }>(`SELECT uri, tx_id FROM attachments WHERE id = ?`, [id]);
  db.runSync(`DELETE FROM attachments WHERE id = ?`, [id]);
  if (row) {
    try { new File(row.uri).delete(); } catch { /* already gone */ }
    reindexTx(asDbAdapter(db), row.tx_id);
  }
}

/** Drop attachment rows whose file no longer exists (for example after an old cache/race bug). */
export function pruneMissingAttachments(db: SQLiteDatabase): number {
  let removed = 0;
  try {
    const rows = db.getAllSync<{ id: number; uri: string; tx_id: number }>(`SELECT id, uri, tx_id FROM attachments`);
    for (const r of rows) {
      try {
        const f = new File(fileUri(r.uri));
        if (f.exists) continue;
        db.runSync(`DELETE FROM attachments WHERE id = ?`, [r.id]);
        reindexTx(asDbAdapter(db), r.tx_id);
        removed++;
      } catch { /* leave an unreadable row for the user to inspect */ }
    }
  } catch { /* attachments table may not exist on an old DB */ }
  return removed;
}

export function fileUri(uri: string): string {
  return /^file:\/\//.test(uri) ? uri : `file://${uri}`;
}
