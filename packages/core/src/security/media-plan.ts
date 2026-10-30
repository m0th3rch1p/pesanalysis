/**
 * Media migration planning (C4). Pure: given attachment rows and what is on disk, decide what to encrypt.
 * Encrypted files keep their original name plus ".enc" (so the extension survives for decrypt-to-cache).
 */
export const ENC_SUFFIX = ".enc";

export interface MediaRow { id: number; uri: string; kind: string }
export type FileProbe = { exists: boolean; size?: number };

export type MediaAction =
  | { op: "encrypt"; id: number; from: string; to: string }
  | { op: "skip"; id: number; reason: "already_encrypted" }
  | { op: "orphan"; id: number; reason: "missing_file" }
  | { op: "finalize"; id: number; from: string; to: string }; // encrypted copy exists but row/plaintext not yet switched (crash recovery)

export const isEncryptedUri = (uri: string) => uri.endsWith(ENC_SUFFIX);
export const encryptedUri = (uri: string) => (isEncryptedUri(uri) ? uri : uri + ENC_SUFFIX);
/** "…/12-1700000000.jpg.enc" -> "jpg". */
export function mediaExt(uri: string): string {
  const base = (isEncryptedUri(uri) ? uri.slice(0, -ENC_SUFFIX.length) : uri).split("/").pop() ?? "";
  const m = /\.([a-z0-9]{1,8})$/i.exec(base);
  return m ? m[1]!.toLowerCase() : "bin";
}

/**
 * Crash-safe order for each file: (1) write `<uri>.enc` fully, (2) update the row to the .enc uri, (3) delete the
 * plaintext. If we die between 1 and 2 the next run sees a plaintext row whose .enc exists and only finalizes it
 * (after re-checking the .enc authenticates, which the app does before switching). Never deletes before the row switches.
 */
export function planMediaMigration(rows: MediaRow[], probe: (uri: string) => FileProbe): MediaAction[] {
  const out: MediaAction[] = [];
  for (const r of rows) {
    if (isEncryptedUri(r.uri)) {
      out.push(probe(r.uri).exists ? { op: "skip", id: r.id, reason: "already_encrypted" } : { op: "orphan", id: r.id, reason: "missing_file" });
      continue;
    }
    const plain = probe(r.uri);
    const enc = probe(encryptedUri(r.uri));
    if (!plain.exists && !enc.exists) { out.push({ op: "orphan", id: r.id, reason: "missing_file" }); continue; }
    if (!plain.exists && enc.exists) { out.push({ op: "finalize", id: r.id, from: r.uri, to: encryptedUri(r.uri) }); continue; }
    out.push({ op: "encrypt", id: r.id, from: r.uri, to: encryptedUri(r.uri) });
  }
  return out;
}

export function summarizeMigration(actions: MediaAction[]): { encrypt: number; skip: number; orphan: number; finalize: number } {
  const s = { encrypt: 0, skip: 0, orphan: 0, finalize: 0 };
  for (const a of actions) s[a.op]++;
  return s;
}
