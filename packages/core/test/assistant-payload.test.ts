import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { adapter, NOW } from "./fixtures.js";
import { migrate, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";
import {
  CATEGORY_VOCAB, ConsentRequiredError, K_MIN, MAX_CATEGORIES, MAX_PAYLOAD_BYTES, PACK_SECTIONS, amountBand, buildZ2Payload, canonicalJson,
  countBand, findLeaks, isIssuedPayload, makeRng, ratioBand, seedCanaryLedger, serialiseZ2Payload, topCategory, z2FieldList, type Z2Payload,
} from "../src/assistant/index.js";

const consent = { granted: true, sessionId: "s1" };
const EAT = 3 * 3_600_000;
const at = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h) - EAT;

function emptyLedger(): { db: DatabaseSync; a: DbAdapter; add: (label: string | null, dir: "in" | "out", kes: number, when: number) => void } {
  const db = new DatabaseSync(":memory:");
  const a = adapter(db);
  migrate(a);
  seedTaxonomy(a, 1);
  const cp = Number((db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES ('k:x','X','[]',1)").run() as { lastInsertRowid: number }).lastInsertRowid);
  const label = (n: string) => (db.prepare("SELECT id FROM labels WHERE name = ?").get(n) as { id: number } | undefined)?.id;
  const add = (name: string | null, dir: "in" | "out", kes: number, when: number) => {
    const id = Number((db.prepare(`INSERT INTO transactions (provider, kind, direction, amount, fee, counterparty_id, occurred_at, template, parser_version, chain_status, status, role)
      VALUES ('mpesa','till',?,?,0,?,?,'mpesa.till','1','ok','confirmed','transaction')`).run(dir, Math.round(kes * 100), cp, when) as { lastInsertRowid: number }).lastInsertRowid);
    if (name) {
      let l = label(name);
      if (!l) l = Number((db.prepare("INSERT INTO labels (name, is_custom, created_at) VALUES (?,1,1)").run(name) as { lastInsertRowid: number }).lastInsertRowid);
      db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,1,1)").run(id, l);
    }
  };
  return { db, a, add };
}

/** Structural whitelist: every leaf of a payload is from a closed vocabulary or a band pattern (I-3). */
export function assertClosedShape(p: Z2Payload, allowGoals = false): void {
  const BAND = /^(?:<100|(?:100|200|500|1000|2000|5000|10000|20000|50000|100000|200000|500000)-\d+|1000000\+)$/;
  assert.deepEqual(Object.keys(p).sort(), ["cadence", "capabilities", "cells", "goals", "k", "ratios", "schema", "window"]);
  assert.equal(p.schema, "yako-z2/1");
  assert.ok(p.k >= K_MIN);
  assert.match(p.window.from, /^\d{4}-\d{2}$/);
  for (const c of p.cells) {
    assert.deepEqual(Object.keys(c).sort(), ["category", "count", "direction", "median", "month", "total"]);
    assert.match(c.month, /^\d{4}-\d{2}$/);
    assert.ok(CATEGORY_VOCAB.has(c.category), c.category);
    assert.ok(c.direction === "in" || c.direction === "out");
    assert.match(c.count, /^(?:5-9|10-19|20-49|50-99|100\+)$/);
    assert.match(c.total, BAND);
    assert.match(c.median, BAND);
  }
  for (const c of p.cadence) { assert.ok(CATEGORY_VOCAB.has(c.category)); assert.match(c.cls, /^(?:daily|weekly|monthly|sparse|irregular)$/); }
  for (const r of p.ratios) { assert.match(r.month, /^\d{4}-\d{2}$/); assert.match(r.outToIn, /^(?:<0\.5|0\.5-0\.9|0\.9-1\.1|1\.1-1\.5|>1\.5)$/); }
  for (const c of p.capabilities) assert.ok((PACK_SECTIONS as readonly string[]).includes(c));
  if (!allowGoals) assert.equal(p.goals.length, 0);
}

test("I-1: consent is mandatory; no grant, no session id, no payload", () => {
  const { a } = emptyLedger();
  for (const c of [undefined, null, { granted: false, sessionId: "s" }, { granted: true, sessionId: "" }, { granted: "yes", sessionId: "s" }, { sessionId: "s" }]) {
    assert.throws(() => buildZ2Payload(a, c as never, { now: NOW }), ConsentRequiredError, JSON.stringify(c));
  }
});

test("I-1: payload is frozen, branded, and forgeries are not sendable", () => {
  const { a } = emptyLedger();
  const p = buildZ2Payload(a, consent, { now: NOW });
  assert.equal(isIssuedPayload(p), true);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.cells) && Object.isFrozen(p.window));
  assert.throws(() => { (p as { k: number }).k = 1; });
  const forged = { ...p };
  assert.equal(isIssuedPayload(forged), false);
  assert.throws(() => serialiseZ2Payload(forged as never), /not_an_issued/);
  assert.equal(isIssuedPayload({ rows: [{ amount: 1 }] }), false);
  assert.equal(isIssuedPayload(null), false);
  assert.equal(serialiseZ2Payload(p), canonicalJson(p));
});

test("I-2: bands are 1-2-5 log scale; boundaries", () => {
  assert.equal(amountBand(0), "<100");
  assert.equal(amountBand(9_999), "<100");
  assert.equal(amountBand(10_000), "100-199");
  assert.equal(amountBand(19_999), "100-199");
  assert.equal(amountBand(20_000), "200-499");
  assert.equal(amountBand(50_000), "500-999");
  assert.equal(amountBand(100_000), "1000-1999");
  assert.equal(amountBand(99_999_999), "500000-999999");
  assert.equal(amountBand(100_000_000), "1000000+");
  assert.equal(amountBand(-5), "<100");
  assert.deepEqual([5, 9, 10, 19, 20, 49, 50, 99, 100, 5000].map(countBand), ["5-9", "5-9", "10-19", "10-19", "20-49", "20-49", "50-99", "50-99", "100+", "100+"]);
  assert.deepEqual([0.1, 0.5, 0.95, 1.1, 2, -1, NaN].map(ratioBand), ["<0.5", "0.5-0.9", "0.9-1.1", "1.1-1.5", ">1.5", "n/a", "n/a"]);
});

test("I-2: k-suppression boundary, and suppressed cells are not folded into anything released", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 4; i++) add("Groceries", "out", 500, at(2026, 10, 1 + i)); // 4 in Oct => suppressed
  for (let i = 0; i < 5; i++) add("Groceries", "out", 500, at(2026, 9, 1 + i)); // exactly k in Sep => released
  for (let i = 0; i < 20; i++) add("Groceries", "out", 500, at(2026, 8, 1 + i)); // keep category alive
  const p = buildZ2Payload(a, consent, { now: NOW });
  const g = p.cells.filter((c) => c.category === "Groceries");
  assert.deepEqual(g.map((c) => c.month), ["2026-08", "2026-09"]);
  assert.equal(g.find((c) => c.month === "2026-09")!.count, "5-9");
  assert.ok(!p.cells.some((c) => c.month === "2026-10"), "no Oct cell, and nothing like an 'Other' absorbing the 4");
  assertClosedShape(p);
});

test("I-2: callers can raise k but never lower it below 5", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 6; i++) add("Fuel", "out", 700, at(2026, 10, 1 + i));
  assert.equal(buildZ2Payload(a, consent, { now: NOW, k: 1 }).cells.length, 1);
  assert.equal(buildZ2Payload(a, consent, { now: NOW, k: 1 }).k, 5);
  assert.equal(buildZ2Payload(a, consent, { now: NOW, k: 7 }).cells.length, 0);
});

test("I-2: no exact extremes or exact amounts: a distinctive value never appears, only bands", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 6; i++) add("Rent", "out", 100 + i, at(2026, 10, 1 + i));
  add("Rent", "out", 98_765.43, at(2026, 10, 20));
  const json = serialiseZ2Payload(buildZ2Payload(a, consent, { now: NOW }));
  assert.doesNotMatch(json, /98765|9876543|987654|765\.43/);
  const p = JSON.parse(json) as Z2Payload;
  assert.equal(typeof p.cells[0]!.total, "string");
  assert.ok(!("max" in p.cells[0]!) && !("min" in p.cells[0]!) && !("largest" in p.cells[0]!) && !("last" in p.cells[0]!));
});

test("I-2: amounts of exactly the same cell cannot be recovered; no window totals are released (anti-differencing)", () => {
  const { a, add } = emptyLedger();
  for (let m = 5; m <= 10; m++) for (let i = 0; i < 5; i++) add("Utilities", "out", 1_000, at(2026, m, 1 + i));
  const p = buildZ2Payload(a, consent, { now: NOW });
  const keys = new Set(p.cells.flatMap((c) => Object.keys(c)));
  assert.deepEqual([...keys].sort(), ["category", "count", "direction", "median", "month", "total"]);
  assert.ok(!("totals" in p) && !("categories" in p));
});

test("I-2/I-3: custom label names fold into Other; roll-ups; unlabelled; vocabulary is closed", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 6; i++) add("Divorce lawyer", "out", 5_000, at(2026, 10, 1 + i));
  for (let i = 0; i < 6; i++) add("Fuel", "out", 700, at(2026, 10, 1 + i));
  for (let i = 0; i < 6; i++) add("Transport", "out", 100, at(2026, 10, 1 + i));
  for (let i = 0; i < 6; i++) add(null, "in", 100, at(2026, 10, 1 + i));
  const p = buildZ2Payload(a, consent, { now: NOW });
  const cats = p.cells.map((c) => c.category);
  assert.ok(cats.includes("Other") && cats.includes("Transport") && cats.includes("Unlabelled"));
  assert.ok(!cats.includes("Fuel"), "Fuel rolls up to Transport");
  assert.equal(p.cells.find((c) => c.category === "Transport")!.count, "10-19");
  assert.doesNotMatch(serialiseZ2Payload(p), /Divorce|lawyer/i);
  assert.equal(topCategory("Fuel"), "Transport");
  assert.equal(topCategory("Groceries"), "Groceries");
  assert.equal(topCategory("Nonsense custom"), "Other");
  assert.equal(topCategory(null), "Unlabelled");
  assertClosedShape(p);
});

test("I-2: at most MAX_CATEGORIES distinct categories; the rest fold into Other", () => {
  const { a, add } = emptyLedger();
  const names = ["Groceries", "Eating out", "Transport", "Rent", "Utilities", "Airtime & data", "Fees & charges", "Health", "School fees", "Entertainment",
    "Shopping", "Subscriptions", "Pets", "Debt repayment", "Cash withdrawal", "Transfer out", "Salary", "Business stock", "Family support", "Savings & investment"];
  names.forEach((n, i) => { for (let j = 0; j < 6 + i; j++) add(n, i === 16 ? "in" : "out", 300, at(2026, 10, 1 + (j % 25))); });
  const p = buildZ2Payload(a, consent, { now: NOW });
  const distinct = new Set(p.cells.map((c) => c.category));
  assert.ok(distinct.size <= MAX_CATEGORIES, String(distinct.size));
  assert.ok(distinct.has("Other"));
  assertClosedShape(p);
});

test("I-2: month granularity in EAT (a late-evening UTC event belongs to the next EAT month)", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 5; i++) add("Groceries", "out", 100, Date.UTC(2026, 8, 30, 22, i)); // 1 Oct 01:0x EAT
  const p = buildZ2Payload(a, consent, { now: NOW });
  assert.deepEqual(p.cells.map((c) => c.month), ["2026-10"]);
  assert.deepEqual([p.window.from, p.window.to], ["2026-05", "2026-10"]);
});

test("I-2: cadence classes and out/in ratio bands appear only with >= k support", () => {
  const { a, add } = emptyLedger();
  for (let i = 0; i < 8; i++) add("Salary", "in", 50_000, at(2026, 10, 1 + i * 3));
  for (let i = 0; i < 8; i++) add("Rent", "out", 45_000, at(2026, 10, 1 + i * 3));
  for (let i = 0; i < 4; i++) add("Pets", "out", 100, at(2026, 10, 1 + i));
  const p = buildZ2Payload(a, consent, { now: NOW });
  assert.ok(p.cadence.some((c) => c.category === "Salary" && c.direction === "in"));
  assert.ok(!p.cadence.some((c) => c.category === "Pets"));
  assert.equal(p.ratios.length, 1);
  assert.deepEqual(p.ratios[0], { month: "2026-10", outToIn: "0.9-1.1" });
});

test("I-2: payload size is capped even for a huge, wide ledger", () => {
  const { a, add } = emptyLedger();
  const names = ["Groceries", "Eating out", "Transport", "Rent", "Utilities", "Health", "Shopping", "Pets", "Salary", "Business stock"];
  for (let m = 1; m <= 10; m++) for (const n of names) for (let i = 0; i < 6; i++) add(n, n === "Salary" ? "in" : "out", 200 + i, at(2026, m, 1 + i));
  const json = serialiseZ2Payload(buildZ2Payload(a, consent, { now: NOW, months: 12 }));
  assert.ok(new TextEncoder().encode(json).length <= MAX_PAYLOAD_BYTES);
});

test("I-3: user goals are the only free text; sanitised, bounded and previewed (field list)", () => {
  const { a } = emptyLedger();
  const long = "x".repeat(500);
  const p = buildZ2Payload(a, { granted: true, sessionId: "s", goals: [
    { id: "Main Goal!", text: "Save for school fees\u202e\u0000 by June" }, { id: "b", text: long }, { id: "", text: "dropped" }, { id: "c", text: "" },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `g${i}`, text: "ok" })),
  ] }, { now: NOW });
  assert.equal(p.goals.length, 10);
  assert.deepEqual(p.goals[0], { id: "maingoal", text: "Save for school fees by June" });
  assert.equal(p.goals[1]!.text.length, 200);
  assert.ok(z2FieldList(p).includes("goals[].text"));
  assertClosedShape(p, true);
});

test("I-3: capabilities advertise only the closed pack section list", () => {
  const { a } = emptyLedger();
  assert.deepEqual(buildZ2Payload(a, consent, { now: NOW }).capabilities, [...PACK_SECTIONS].sort());
  assert.deepEqual(buildZ2Payload(a, { ...consent, capabilities: ["budgets", "zones", "connectors"] }, { now: NOW }).capabilities, ["budgets"]);
});

test("I-1/I-3: SQL reads only direction, amount, time and label name (no other column is reachable)", () => {
  const { a } = emptyLedger();
  const seen: string[] = [];
  const spy: DbAdapter = { ...a, all: (sql, p) => { seen.push(sql); return a.all(sql, p); }, get: a.get, run: a.run, exec: a.exec };
  buildZ2Payload(spy, consent, { now: NOW });
  assert.equal(seen.length, 1);
  const select = /SELECT([\s\S]*?)FROM/.exec(seen[0]!)![1]!;
  assert.doesNotMatch(select, /display_name|raw_names|ref|body|text|uri|account|notes|sender|calendar|place|key|event_ref|episode/i);
  assert.match(select, /t\.direction/);
});

// ---- canary leak harness (test plan 1, 2, 5) -----------------------------------------------------
test("CANARY: planted canaries in every free-text field never appear in any payload (60 random ledgers)", () => {
  let totalCanaries = 0, nonEmpty = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = makeRng(seed * 7919);
    const db = new DatabaseSync(":memory:");
    const a = adapter(db);
    migrate(a);
    seedTaxonomy(a, 1);
    const { canaries } = seedCanaryLedger(a, rng, { txCount: 40 + Math.floor(rng() * 160), now: NOW, tag: `S${seed}` });
    totalCanaries += canaries.length;
    const p = buildZ2Payload(a, { granted: true, sessionId: `s${seed}`, goals: [{ id: "g", text: "Save for a bike" }] }, { now: NOW });
    const json = serialiseZ2Payload(p);
    assert.deepEqual(findLeaks(json, canaries), [], `seed ${seed}`);
    assert.deepEqual(findLeaks(JSON.stringify(z2FieldList(p)), canaries), []);
    assert.ok(new TextEncoder().encode(json).length <= MAX_PAYLOAD_BYTES);
    assertClosedShape(p, true);
    if (p.cells.length) nonEmpty++;
    db.close();
  }
  assert.ok(totalCanaries > 5_000, `harness planted only ${totalCanaries}`);
  assert.ok(nonEmpty >= 20, `only ${nonEmpty} ledgers produced cells; the property would be vacuous`);
});

test("CANARY harness self-test: it really does detect a leak, and it plants injection strings everywhere", () => {
  const db = new DatabaseSync(":memory:");
  const a = adapter(db);
  migrate(a); seedTaxonomy(a, 1);
  const { canaries } = seedCanaryLedger(a, makeRng(5), { txCount: 30, now: NOW, tag: "SELF" });
  assert.deepEqual(findLeaks("prefix " + canaries[3]!.toUpperCase() + " suffix", canaries), [canaries[3]]);
  const tables = [["sms_raw", "body"], ["sms_raw", "sender"], ["counterparties", "display_name"], ["counterparties", "raw_names"], ["tx_notes", "text"], ["tx_notes", "uri"],
    ["tx_context", "calendar_title"], ["places", "name"], ["labels", "name"], ["tags", "name"], ["episodes", "name"], ["transactions", "ref"], ["transactions", "account"], ["transactions", "event_ref"]];
  for (const [t, c] of tables) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} LIKE '%CNRYSELF%'`).get() as { n: number }).n;
    assert.ok(n > 0, `${t}.${c} not planted`);
  }
  assert.ok((db.prepare(`SELECT COUNT(*) AS n FROM sms_raw WHERE body LIKE '%IGNORE ALL PREVIOUS%'`).get() as { n: number }).n > 0);
  db.close();
});

test("PROPERTY (I-2): random ledgers - no released cell has fewer than k real events, no exact amounts, bounded size", () => {
  for (let seed = 100; seed < 130; seed++) {
    const rng = makeRng(seed);
    const { db, a, add } = emptyLedger();
    const names = ["Groceries", "Fuel", "Rent", "Salary", "Pets", "Health", "Weird custom", null];
    const n = 20 + Math.floor(rng() * 400);
    const amounts: number[] = [];
    for (let i = 0; i < n; i++) {
      const kes = Math.max(1, Math.round(Math.exp(rng() * 9) * 100) / 100);
      amounts.push(kes);
      add(names[Math.floor(rng() * names.length)]!, rng() < 0.3 ? "in" : "out", kes, NOW - Math.floor(rng() * 150 * 86_400_000));
    }
    const p = buildZ2Payload(a, consent, { now: NOW });
    const json = serialiseZ2Payload(p);
    assertClosedShape(p);
    // independent recount from the DB for every released non-Other cell
    for (const c of p.cells.filter((x) => x.category !== "Other")) {
      const rows = db.prepare(
        `SELECT t.occurred_at AS at, l.name AS label FROM tx_events t LEFT JOIN tx_labels tl ON tl.tx_id = t.id LEFT JOIN labels l ON l.id = tl.label_id WHERE t.direction = ?`,
      ).all(c.direction) as Array<{ at: number; label: string | null }>;
      const real = rows.filter((r) => {
        const d = new Date(r.at + EAT);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` === c.month && topCategory(r.label) === c.category;
      }).length;
      assert.ok(real >= K_MIN, `seed ${seed}: ${c.month} ${c.category} has ${real}`);
      const lo = Number(/^\d+/.exec(c.count)![0]);
      assert.ok(real >= lo, `band ${c.count} but ${real}`);
    }
    // the exact largest amount (as KES text with decimals) is absent
    const max = Math.max(...amounts);
    if (max >= 1000) assert.ok(!json.includes(String(max)) || /^\d{3,4}$/.test(String(max)), `exact max ${max} leaked`);
    assert.ok(new TextEncoder().encode(json).length <= MAX_PAYLOAD_BYTES);
    db.close();
  }
});
