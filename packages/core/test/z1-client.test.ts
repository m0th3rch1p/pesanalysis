import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { z1Call, z1Health, z1Mcp, z1PushSnapshot, z1Test } from "../src/zones/client.js";
import type { Z1Snapshot } from "../src/zones/hosts.js";

test("Z1 client authenticates, pushes a snapshot and calls MCP tools", async () => {
  let seenAuth = "";
  let seen = 0;
  const server = http.createServer(async (req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, name: "test-host" }));
    if (req.url === "/snapshot") { seen = body.tables.transactions.length; return res.end(JSON.stringify({ ok: true, rows: seen })); }
    if (req.url === "/mcp" && body.method === "initialize") return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "test-host" } } }));
    if (req.url === "/mcp" && body.method === "tools/list") return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "summary" }] } }));
    if (req.url === "/mcp" && body.method === "tools/call") return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ep = { baseUrl: `http://127.0.0.1:${port}`, token: "secret" };
  try {
    const h = await z1Health(ep);
    assert.equal(h.ok, true);
    assert.equal(seenAuth, "Bearer secret");
    const snap: Z1Snapshot = { format: "pesanalysis-z1-snapshot-v1", createdAt: 1, hostId: "h1", tables: { transactions: [{ id: 1 }], labels: [], counterparties: [], accounts: [], tags: [] } };
    const pushed = await z1PushSnapshot(ep, snap);
    assert.equal(pushed.rows, 1); assert.equal(seen, 1);
    const t = await z1Test(ep);
    assert.equal(t.server, "test-host"); assert.deepEqual(t.tools, ["summary"]);
    const call = await z1Call(ep, "summary");
    assert.match(call, /ok/);
    const ping = await z1Mcp(ep, { method: "initialize" });
    assert.ok(ping.result);
  } finally { server.close(); }
});
