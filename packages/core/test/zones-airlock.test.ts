import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import { buildAirlock, exportAirlock, getAirlockManifest } from "../src/airlock/build.js";
import { createRegistry, installBuiltins, ZoneViolation } from "../src/zones/registry.js";

test("airlock: only taxonomy labels, k-suppressed, no counterparties", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const cpId = (db.prepare("SELECT id FROM counterparties WHERE key = 'n:naivas'").get() as { id: number }).id;
  const labelId = (db.prepare("SELECT id FROM labels WHERE name = 'Groceries'").get() as { id: number }).id;
  for (let i = 0; i < 4; i++) {
    const id = 101 + i;
    db.prepare(`INSERT INTO transactions
      (id, provider, kind, direction, amount, fee, counterparty_id, occurred_at, template, parser_version, chain_status, status, role)
      VALUES (?, 'mpesa', 'till', 'out', 120000, 0, ?, ?, 'mpesa.till', '1', 'ok', 'confirmed', 'transaction')`)
      .run(id, cpId, NOW - i * 86_400_000);
    db.prepare("INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at) VALUES (?, ?, 'user', 1, ?, ?)")
      .run(id, labelId, NOW, NOW);
  }
  const manifest = buildAirlock(a, { k: 2, timeGranularity: "month", amountMode: "band" }, NOW);
  assert.ok(manifest.tables.length === 2);
  assert.ok(manifest.suppressedCells >= 1);
  const cells = db.prepare("SELECT tx_count AS n FROM airlock_monthly").all() as { n: number }[];
  assert.ok(cells.length > 0);
  assert.ok(cells.every((c) => c.n >= 2));
  const labels = db.prepare("SELECT DISTINCT label FROM airlock_monthly").all() as { label: string }[];
  assert.ok(labels.every((l) => !/KPLC|SHELL|EMPLOYER|NAIVAS/.test(l.label)));
  assert.ok(labels.some((l) => l.label === "Other"));
  const json = exportAirlock(a);
  assert.doesNotMatch(json, /NAIVAS|KPLC|SHELL|kale|tomatoes/i);
  assert.ok(getAirlockManifest(a));
  db.close();
});

test("airlock: a lone payment never leaks as a released cell", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const manifest = buildAirlock(a, { k: 5, timeGranularity: "month", amountMode: "band" }, NOW);
  const monthly = db.prepare("SELECT tx_count AS n FROM airlock_monthly").all() as { n: number }[];
  const categories = db.prepare("SELECT tx_count AS n FROM airlock_categories").all() as { n: number }[];
  assert.equal(monthly.length, 0);
  assert.equal(categories.length, 0);
  assert.ok(manifest.suppressedCells >= 1);
  db.close();
});

test("airlock: custom labels are folded into Other", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const id = (db.prepare("SELECT id FROM labels WHERE name='Groceries'").get() as { id: number }).id;
  db.prepare("INSERT INTO labels (name, is_custom, created_at) VALUES ('Divorce lawyer', 1, 1)").run();
  const custom = (db.prepare("SELECT id FROM labels WHERE name='Divorce lawyer'").get() as { id: number }).id;
  db.prepare("DELETE FROM tx_labels WHERE tx_id = 1").run();
  db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (1,?,'user',1,1,1)").run(custom);
  buildAirlock(a, { k: 1, timeGranularity: "month", amountMode: "band" }, NOW);
  const json = exportAirlock(a);
  assert.doesNotMatch(json, /Divorce|lawyer/i);
  assert.match(json, /Other/);
  void id;
  db.close();
});

test("zones: private tools cannot be exposed to Z2; egress must be tapped and Z2-only", () => {
  const db = fixtureDb();
  const reg = createRegistry({ db: adapter(db), now: () => NOW });
  assert.throws(() => reg.registerTool({
    name: "leak", description: "", parameters: {}, returns: {}, allowedZones: ["Z0", "Z2"],
    capability: "read_private", confirm: "none", rowPolicy: { maxRows: 1, allowedColumns: {} },
  }), /read_private may not be callable from Z2/);
  const r2 = createRegistry({ db: adapter(db), now: () => NOW });
  assert.throws(() => r2.registerTool({
    name: "leak2", description: "", parameters: {}, returns: {}, allowedZones: ["Z2"],
    capability: "send_out", confirm: "none", rowPolicy: { maxRows: 1, allowedColumns: {} },
  }), /confirm=user_tap/);
  const r3 = createRegistry({ db: adapter(db), now: () => NOW });
  assert.throws(() => r3.registerTool({
    name: "leak3", description: "", parameters: {}, returns: {}, allowedZones: ["Z0", "Z2"],
    capability: "send_out", confirm: "user_tap", rowPolicy: { maxRows: 1, allowedColumns: {} },
  }), /Z2 only/);
  db.close();
});

test("zones: Z2 cannot call private tools and egress needs a tap", () => {
  const db = fixtureDb();
  const reg = installBuiltins(createRegistry({ db: adapter(db), now: () => NOW }));
  assert.throws(() => reg.invokeTool("Z2", "ledger_summary", {}), /not available in Z2/);
  assert.ok(reg.toolsForZone("Z2").every((t) => t.name.startsWith("airlock_")));
  assert.throws(() => reg.invokeTool("Z2", "airlock_release", {}), /user tap/);
  db.close();
});

test("zones: Z0 summary works, audit is written, no SMS body leaks", () => {
  const db = fixtureDb();
  const reg = installBuiltins(createRegistry({ db: adapter(db), now: () => NOW }));
  const s = reg.invokeTool("Z0", "ledger_summary", { fromMs: 0, toMs: NOW }) as { rows: unknown[] };
  assert.equal(s.rows.length, 1);
  const audit = db.prepare("SELECT zone, tool, ok FROM tool_audit ORDER BY id DESC LIMIT 1").get() as { zone: string; tool: string; ok: number };
  assert.deepEqual({ ...audit }, { zone: "Z0", tool: "ledger_summary", ok: 1 });
  const listed = reg.invokeTool("Z0", "ledger_list", { fromMs: 0, toMs: NOW, limit: 10 }) as { rows: Array<Record<string, unknown>> };
  const json = JSON.stringify(listed);
  assert.doesNotMatch(json, /kale|tomatoes|body/i);
  db.close();
});

test("zones: Z1 can run a plan but cannot list raw rows", () => {
  const db = fixtureDb();
  const reg = installBuiltins(createRegistry({ db: adapter(db), now: () => NOW }));
  const out = reg.invokeTool("Z1", "plan_query", { plan: { version: 1, measure: "spend", groupBy: ["label"], filters: { time: { kind: "named", name: "this_month" } } } });
  assert.ok((out as { rows: unknown[] }).rows.length > 0);
  assert.throws(() => reg.invokeTool("Z1", "ledger_list", {}), /not available in Z1/);
  db.close();
});
