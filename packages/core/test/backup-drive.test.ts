import test from "node:test";
import assert from "node:assert/strict";
import { DriveError, deleteBackup, downloadBackup, listBackups, pruneBackups, uploadBackup } from "../src/backup/drive.js";

type Call = { url: string; init: RequestInit & { token?: string } };
function fake(routes: Array<{ match: RegExp; status?: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: (init ?? {}) as Call["init"] });
    const r = routes.find((x) => x.match.test(url));
    if (!r) return new Response("no route", { status: 404 });
    if (r.bytes) return new Response(r.bytes, { status: r.status ?? 200, headers: r.headers });
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("upload writes appDataFolder metadata and the exact bytes, pinned to https", async () => {
  const { fn, calls } = fake([{ match: /upload\/drive\/v3\/files/, json: { id: "f1", name: "b.pesabak", size: "3" } }]);
  const out = await uploadBackup(fn, "tok", "b.pesabak", new Uint8Array([1, 2, 3]));
  assert.equal(out.id, "f1");
  assert.equal(calls[0]!.url.startsWith("https://"), true);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  assert.equal(calls[0]!.init.redirect, "manual");
  const body = calls[0]!.init.body as Uint8Array;
  const text = new TextDecoder().decode(body.subarray(0, 300));
  assert.ok(text.includes("appDataFolder"));
});

test("redirects are refused, as are non-2xx and oversized downloads", async () => {
  const r1 = fake([{ match: /files/, status: 307, headers: { location: "https://evil.example" } }]);
  await assert.rejects(uploadBackup(r1.fn, "t", "a.pesabak", new Uint8Array([1])), (e: DriveError) => e.code === "redirect_blocked");
  const r2 = fake([{ match: /alt=media/, bytes: new Uint8Array(10), headers: { "content-length": "999999999" } }]);
  await assert.rejects(downloadBackup(r2.fn, "t", "id", 1000), (e: DriveError) => e.code === "too_large");
  const r3 = fake([{ match: /files/, status: 500 }]);
  await assert.rejects(listBackups(r3.fn, "t"), (e: DriveError) => e.code === "http_500");
});

test("list, delete and prune keep the newest five", async () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, name: `b${i}.pesabak` }));
  const { fn, calls } = fake([
    { match: /files\?/, json: { files } },
    { match: /files\/id[0-9]/, status: 204 },
  ]);
  const list = await listBackups(fn, "t");
  assert.equal(list.length, 7);
  assert.equal(await pruneBackups(fn, "t", 5), 2);
  assert.ok(calls.some((c) => c.url.endsWith("/files/id5") && c.init.method === "DELETE"));
  assert.ok(calls.some((c) => c.url.endsWith("/files/id6") && c.init.method === "DELETE"));
  await deleteBackup(fn, "t", "id1");
});
