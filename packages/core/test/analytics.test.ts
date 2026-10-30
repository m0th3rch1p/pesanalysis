import test from "node:test";
import assert from "node:assert/strict";
import { adapter, at, fixtureDb, NOW } from "./fixtures.js";
import {
  anomalies, balanceTrend, categoryTrend, feesDrag, incomeMix, loadAnalyses, monthFlow,
  recurring, runAllAnalyses, spendHeatmap, topCounterparties, venturesAnalysis,
} from "../src/analytics/service.js";

test("analytics: month flow compares this month with last month", () => {
  const db = fixtureDb();
  const r = monthFlow(adapter(db), NOW);
  assert.equal(r.chart!.kind, "line");
  assert.ok(r.chart!.series.find((s) => s.key === "spend")!.points.length >= 2);
  assert.match(r.findings[0]!.text, /Ksh3,500/);
  assert.match(r.findings[0]!.text, /17%/);
  db.close();
});

test("analytics: top counterparties and categories", () => {
  const db = fixtureDb();
  const top = topCounterparties(adapter(db), NOW);
  assert.deepEqual(top.chart!.series[0]!.points.map((p) => p.x), ["NAIVAS", "KPLC"]);
  assert.equal(top.chart!.series[0]!.points[0]!.y, 300_000);
  const cats = categoryTrend(adapter(db), NOW);
  assert.ok(cats.chart!.series.some((s) => s.key === "Groceries"));
  db.close();
});

test("analytics: fees, income mix and heatmap", () => {
  const db = fixtureDb();
  const f = feesDrag(adapter(db), NOW);
  assert.match(f.findings[0]!.text, /Ksh35/);
  const inc = incomeMix(adapter(db), NOW);
  assert.deepEqual(inc.chart!.series[0]!.points.map((p) => p.x), ["Salary"]);
  const heat = spendHeatmap(adapter(db), NOW);
  assert.ok((heat.chart!.cells ?? []).length > 0);
  db.close();
});

test("analytics: venture P&L from tags", () => {
  const db = fixtureDb();
  const r = venturesAnalysis(adapter(db), NOW);
  assert.ok(r.chart!.series[0]!.points.some((p) => p.x === "Mama mboga" && p.y === -300_000));
  assert.match(r.findings[0]!.text, /net -Ksh3,000/);
  db.close();
});

test("analytics: recurring monthly commitment is detected", () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO transactions (provider, kind, direction, amount, fee, counterparty_id, occurred_at, template, parser_version, chain_status, status, role)
    SELECT 'mpesa','till','out',100000,0,counterparty_id, occurred_at, 'mpesa.till','1','ok','confirmed','transaction'
      FROM tx_events WHERE id = 1;
  `);
  // add 3 earlier monthly Naivas payments
  const cp = (db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number }).id;
  for (const [m, d] of [[7, 5], [8, 5], [9, 5]] as const) {
    db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,fee,counterparty_id,occurred_at,template,parser_version,chain_status,status,role)
      VALUES ('mpesa','till','out',100000,0,?,?,'mpesa.till','1','ok','confirmed','transaction')`).run(cp, at(2026, m, d));
  }
  const r = recurring(adapter(db), NOW);
  assert.ok(r.findings.some((f) => f.text.includes("NAIVAS") && /monthly|weekly|fortnightly/.test(f.text)));
  db.close();
});

test("analytics: anomalies requires a real outlier and enough history", () => {
  const db = fixtureDb();
  const cp = (db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number }).id;
  const label = (db.prepare("SELECT id FROM labels WHERE name='Groceries'").get() as { id: number }).id;
  let id = 100;
  for (let i = 0; i < 12; i++) {
    const amount = i === 11 ? 2_000_000 : 10_000;
    db.prepare(`INSERT INTO transactions (id, provider,kind,direction,amount,fee,counterparty_id,occurred_at,template,parser_version,chain_status,status,role)
      VALUES (?, 'mpesa','till','out',?,0,?,?,'mpesa.till','1','ok','confirmed','transaction')`).run(++id, amount, cp, at(2026, 10, 1 + i));
    db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)").run(id, label, at(2026, 10, 1 + i), at(2026, 10, 1 + i));
  }
  const r = anomalies(adapter(db), NOW);
  assert.ok(r.findings.length >= 1);
  assert.match(r.findings[0]!.text, /Ksh20,000/);
  db.close();
});

test("analytics: balance analysis is empty-safe and chain breaks are counted", () => {
  const db = fixtureDb();
  const empty = balanceTrend(adapter(db), NOW);
  assert.equal(empty.chart!.series[0]!.points.length, 0);
  assert.match(empty.findings[0]!.text, /reconcile/);
  db.exec("UPDATE transactions SET balance_after = 100000, chain_status='break' WHERE id = 1");
  const r = balanceTrend(adapter(db), NOW);
  assert.match(r.findings[0]!.text, /1 balance-chain break/);
  db.close();
});

test("analytics: runAllAnalyses persists one row per analysis", () => {
  const db = fixtureDb();
  const results = runAllAnalyses(adapter(db), NOW);
  assert.equal(results.length, 11);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM analyses").get() as { n: number }).n;
  assert.equal(n, 11);
  assert.equal(loadAnalyses(adapter(db)).length, 11);
  db.close();
});
