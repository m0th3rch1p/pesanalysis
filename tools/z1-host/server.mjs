#!/usr/bin/env node
/**
 * Minimal live Z1 host for the Pesanalysis device test.
 * It holds one allowlisted snapshot in memory and exposes four MCP tools.
 * Run: PESANALYSIS_TOKEN=demo-token node tools/z1-host/server.mjs
 */
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PESANALYSIS_TOKEN || "demo-token";
let snapshot = null;

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const auth = (req) => (req.headers.authorization || "") === `Bearer ${TOKEN}`;
const tools = [
  { name: "summary", description: "Money in, money out, fees and net from the last snapshot.", inputSchema: { type: "object", properties: {} } },
  { name: "top_categories", description: "Top spending categories by amount.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "income_vs_spend", description: "Monthly income and spending.", inputSchema: { type: "object", properties: {} } },
  { name: "privacy", description: "What this host received and what it never receives.", inputSchema: { type: "object", properties: {} } },
];

function summary() {
  const t = snapshot?.tables?.transactions ?? [];
  const income = t.filter((r) => r.direction === "in").reduce((s, r) => s + Number(r.amount || 0), 0);
  const spend = t.filter((r) => r.direction === "out").reduce((s, r) => s + Number(r.amount || 0), 0);
  const fees = t.reduce((s, r) => s + Number(r.fee || 0), 0);
  return { transactions: t.length, incomeCents: income, spendCents: spend, feeCents: fees, netCents: income - spend - fees };
}
function topCategories(limit = 6) {
  const map = new Map();
  for (const r of snapshot?.tables?.transactions ?? []) {
    if (r.direction !== "out") continue;
    const k = r.label || "No label";
    map.set(k, (map.get(k) || 0) + Number(r.amount || 0));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, cents]) => ({ label, cents }));
}
function incomeVsSpend() {
  const map = new Map();
  for (const r of snapshot?.tables?.transactions ?? []) {
    const month = new Date(Number(r.occurredAt) + 3 * 3600000).toISOString().slice(0, 7);
    const cur = map.get(month) || { month, incomeCents: 0, spendCents: 0 };
    if (r.direction === "in") cur.incomeCents += Number(r.amount || 0);
    else cur.spendCents += Number(r.amount || 0);
    map.set(month, cur);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function callTool(name, args) {
  if (!snapshot) return { error: "no snapshot has been pushed yet" };
  if (name === "summary") return summary();
  if (name === "top_categories") return topCategories(Number(args?.limit) || 6);
  if (name === "income_vs_spend") return incomeVsSpend();
  if (name === "privacy") return {
    received: ["allowlisted transaction rows", "labels", "counterparties", "accounts", "tags"],
    neverReceived: ["SMS bodies", "notes text", "locations", "media"],
    mode: "Z1 Mode A snapshot; live MCP calls over the same authenticated channel",
  };
  return { error: `unknown tool ${name}` };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  console.log(`${new Date().toISOString()} ${req.method} ${u.pathname} ${req.headers.authorization ? "auth" : "no-auth"}`);
  if (u.pathname === "/health") return send(res, 200, { ok: true, name: "pesanalysis-z1-host", version: "0.1.0" });
  if (!auth(req)) return send(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u.pathname === "/snapshot") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return send(res, 200, { ok: true, rows: snapshot?.tables?.transactions?.length ?? 0 });
    } catch { return send(res, 400, { ok: false, error: "invalid JSON" }); }
  }
  if (req.method === "POST" && u.pathname === "/mcp") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const id = body.id ?? null;
    if (body.method === "initialize") return send(res, 200, { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "pesanalysis-z1-host", version: "0.1.0" }, capabilities: { tools: {} } } });
    if (body.method === "tools/list") return send(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    if (body.method === "tools/call") {
      const result = callTool(String(body.params?.name || ""), body.params?.arguments || {});
      return send(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } });
    }
    return send(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${body.method}` } });
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pesanalysis Z1 host on http://0.0.0.0:${PORT} · token ${TOKEN === "demo-token" ? "demo-token (dev only)" : "set"}`);
});
