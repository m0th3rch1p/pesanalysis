/**
 * Google Drive backup upload (F-BACKUP). Deliberately token-in, no OAuth: obtaining a token needs a
 * Google Cloud project, an OAuth client for the app's signing SHA-1, and a consent screen. Until the
 * founder configures those, the app ships encrypted file export/import only and this module is a clean
 * seam. The file is uploaded to the app's private `appDataFolder` (hidden from the user's Drive UI).
 *
 * Scope required: https://www.googleapis.com/auth/drive.appdata
 * Endpoints: upload (multipart), list, download, delete. No redirects; https only; size caps.
 */
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface DriveFile { id: string; name: string; size?: number; modifiedTime?: string }
export class DriveError extends Error { constructor(public code: string) { super(code); } }

async function call(fetchFn: typeof fetch, url: string, init: RequestInit & { token: string }): Promise<Response> {
  const res = await fetchFn(url, {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${init.token}` },
  });
  if (res.status >= 300 && res.status < 400) throw new DriveError("redirect_blocked");
  if (!res.ok) throw new DriveError(`http_${res.status}`);
  return res;
}

export async function uploadBackup(fetchFn: typeof fetch, token: string, name: string, bytes: Uint8Array, appProperties: Record<string, string> = {}): Promise<DriveFile> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw new DriveError("bad_name");
  const meta = JSON.stringify({ name, parents: ["appDataFolder"], appProperties });
  const boundary = `pesabak${Math.random().toString(36).slice(2)}`;
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const res = await call(fetchFn, `${UPLOAD}/files?uploadType=multipart&fields=id,name,size,modifiedTime`, {
    method: "POST", token, body,
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
  });
  const j = await res.json() as { id: string; name: string; size?: string; modifiedTime?: string };
  if (!j?.id) throw new DriveError("bad_response");
  return { id: j.id, name: j.name, size: j.size ? Number(j.size) : undefined, modifiedTime: j.modifiedTime };
}

export async function listBackups(fetchFn: typeof fetch, token: string, pageSize = 20): Promise<DriveFile[]> {
  const q = encodeURIComponent("'appDataFolder' in parents and trashed = false");
  const res = await call(fetchFn, `${API}/files?spaces=appDataFolder&q=${q}&orderBy=modifiedTime desc&pageSize=${Math.min(100, Math.max(1, pageSize))}&fields=files(id,name,size,modifiedTime)`, { method: "GET", token });
  const j = await res.json() as { files?: Array<{ id: string; name: string; size?: string; modifiedTime?: string }> };
  return (j.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size ? Number(f.size) : undefined, modifiedTime: f.modifiedTime }));
}

export async function downloadBackup(fetchFn: typeof fetch, token: string, id: string, maxBytes = 200 * 1024 * 1024): Promise<Uint8Array> {
  const res = await call(fetchFn, `${API}/files/${encodeURIComponent(id)}?alt=media`, { method: "GET", token });
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) throw new DriveError("too_large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new DriveError("too_large");
  return buf;
}

export async function deleteBackup(fetchFn: typeof fetch, token: string, id: string): Promise<void> {
  await call(fetchFn, `${API}/files/${encodeURIComponent(id)}`, { method: "DELETE", token });
}

/** Keeps the newest `keep` files, deletes older ones. Returns how many were removed. */
export async function pruneBackups(fetchFn: typeof fetch, token: string, keep = 5): Promise<number> {
  const files = await listBackups(fetchFn, token, 100);
  let removed = 0;
  for (const f of files.slice(Math.max(0, keep))) { await deleteBackup(fetchFn, token, f.id); removed++; }
  return removed;
}
