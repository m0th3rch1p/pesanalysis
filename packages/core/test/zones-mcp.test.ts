import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { buildZ1Snapshot, listHosts, pairHost, revokeHost } from "../src/zones/hosts.js";
import { handleMcpRequest } from "../src/zones/mcp.js";

test("z1: pair, snapshot without SMS bodies/notes, revoke", () => {
  const db = fixtureDb(); const a = adapter(db);
  const h = pairHost(a, { id: "h1", name: "Founder laptop", keyFingerprint: "abc", now: 1 });
  assert.equal(h.zone, "Z1");
  const snap = buildZ1Snapshot(a, h.id, 2);
  assert.ok(snap.tables.transactions.length > 0);
  const json = JSON.stringify(snap);
  assert.doesNotMatch(json, /kale|tomatoes|SMS body/i);
  assert.equal(listHosts(a).length, 1);
  revokeHost(a, h.id, 3);
  assert.ok(listHosts(a)[0]!.revokedAt);
  db.close();
});

test("mcp: tools/list is zone-scoped; Z1 cannot list raw rows", () => {
  const db = fixtureDb(); const a = adapter(db);
  const list = handleMcpRequest(a, "Z1", { id: 1, method: "tools/list" });
  const names = ((list.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
  assert.ok(names.includes("plan_query"));
  assert.ok(!names.includes("ledger_list"));
  const call = handleMcpRequest(a, "Z1", { id: 2, method: "tools/call", params: { name: "ledger_list", arguments: {} } });
  assert.ok(call.error);
  assert.match(call.error!.message, /not available/);
  db.close();
});
