import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, schemaVersion, seedTaxonomy } from "../src/db/migrate.js";
import { RESET_TABLES, resetAllData } from "../src/db/maintenance.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import {
  adjustGoal, adjustLocation, budgetPace, budgetSpendEvents, clearTransactionOverride, createBudget, createFlow, createSavingsGoal,
  createSavingsLocation, deleteFlow, floatSnapshot, flowStats, getFlow, ingestDueNotice, listBudgets, listFlows, listOccurrences,
  listSavingsGoals, listSavingsLocations, pinTransaction, refreshOccurrences, rejectTransaction, setFlowStatus, syncFulizaObligation,
  unwaiveOccurrence, updateBudget, updateFlow, virtualPotsTotal, waiveOccurrence, setLocationBalance, closeSavingsLocation, deleteBudget, goalProgressFor,
} from "../src/expect/store.js";
import { adapter, at } from "./fixtures.js";

function mk() {
  const db = new DatabaseSync(":memory:");
  const a = adapter(db);
  migrate(a); seedTaxonomy(a, 1);
  let id = 0;
  const cp = (name: string) => {
    db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)").run(`n:${name}`, name, "[]", 1);
    return (db.prepare("SELECT id FROM counterparties WHERE key = ?").get(`n:${name}`) as { id: number }).id;
  };
  const tx = (o: { cp?: number | null; amount: number; dir: "in" | "out"; when: number; kind?: string; template?: string; cls?: string; fee?: number }) => {
    db.prepare(`INSERT INTO transactions (id, provider, kind, direction, amount, fee, counterparty_id, occurred_at, template, parser_version, chain_status, status, role, flow_class)
      VALUES (?, 'mpesa', ?, ?, ?, ?, ?, ?, ?, '1', 'ok', 'confirmed', 'transaction', ?)`)
      .run(++id, o.kind ?? (o.dir === "in" ? "receive" : "till"), o.dir, o.amount, o.fee ?? 0, o.cp ?? null, o.when, o.template ?? "mpesa.x", o.cls ?? (o.dir === "in" ? "income" : "spend"));
    return id;
  };
  return { db, a, cp, tx };
}

const salaryFlow = { direction: "in" as const, name: "Salary", counterpartyHint: "employer", amountMinCents: 4_800_000, amountTypCents: 5_000_000, amountMaxCents: 5_200_000, cadence: "monthly" as const, dayOfMonth: 28, holidayPolicy: "before" as const };

test("schema v8-v10: fresh create, v7 upgrade, idempotent re-run, reset coverage", () => {
  assert.equal(SCHEMA_VERSION, 10);
  const { db, a } = mk();
  const names = ["expected_flows", "expected_occurrences", "savings_locations", "savings_goals", "budgets",
    "goal_plans", "habits", "item_groups", "items", "tx_items", "item_prices", "ask_suppress"];
  for (const n of names) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n), n);
  for (const n of names) assert.ok((RESET_TABLES as readonly string[]).includes(n), `${n} in RESET_TABLES`);
  assert.ok(RESET_TABLES.indexOf("expected_occurrences") < RESET_TABLES.indexOf("expected_flows"));
  assert.equal(schemaVersion(a), SCHEMA_VERSION);
  // simulate a v7 database, then a v9 database without v10 tables/columns
  db.exec("DROP TABLE ask_suppress; DROP TABLE item_prices; DROP TABLE tx_items; DROP TABLE items; DROP TABLE item_groups; DROP TABLE habits; DROP TABLE goal_plans; DROP TABLE expected_occurrences; DROP TABLE expected_flows; DROP TABLE savings_goals; DROP TABLE savings_locations; DROP TABLE budgets;");
  db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
  migrate(a);
  assert.equal(schemaVersion(a), SCHEMA_VERSION);
  for (const n of names) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n), `${n} recreated`);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(cols("findings").includes("q_value"));
  assert.ok(cols("findings").includes("gate"));
  assert.ok(cols("security_alerts").includes("visibility"));
  assert.ok(cols("experiments").includes("mode"));
  assert.ok(cols("tx_context").includes("fix_kind"));
  db.exec("DROP TABLE tx_items; DROP TABLE items; DROP TABLE item_groups; DROP TABLE habits; DROP TABLE goal_plans; DROP TABLE item_prices; DROP TABLE ask_suppress;");
  db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run();
  migrate(a);
  assert.equal(schemaVersion(a), SCHEMA_VERSION);
  for (const n of names.slice(5)) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n), `${n} recreated from v9`);
  migrate(a); migrate(a);
  assert.equal(schemaVersion(a), SCHEMA_VERSION);
  createFlow(a, salaryFlow, 1);
  resetAllData(a);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM expected_flows").get() as { n: number }).n, 0);
});

test("schema constraints reject invalid enum values", () => {
  const { db } = mk();
  assert.throws(() => db.prepare("INSERT INTO expected_flows (direction, name, cadence, created_at, updated_at) VALUES ('sideways','x','once',1,1)").run());
  assert.throws(() => db.prepare("INSERT INTO expected_flows (direction, name, cadence, created_at, updated_at) VALUES ('in','x','yearly',1,1)").run());
  assert.throws(() => db.prepare("INSERT INTO savings_locations (name, rail, created_at, updated_at) VALUES ('x','crypto',1,1)").run());
  assert.throws(() => db.prepare("INSERT INTO budgets (name, period, limit_cents, created_at, updated_at) VALUES ('x','daily',1,1,1)").run());
});

test("createFlow validates, normalises amounts, dedupes by (source, sourceRef)", () => {
  const { a } = mk();
  assert.throws(() => createFlow(a, { ...salaryFlow, dayOfMonth: null }), /dayOfMonth/);
  assert.throws(() => createFlow(a, { ...salaryFlow, name: " " }), /name/);
  assert.throws(() => createFlow(a, { ...salaryFlow, amountMinCents: 10, amountMaxCents: 5, amountTypCents: null }), /amountMin/);
  assert.throws(() => createFlow(a, { ...salaryFlow, amountMinCents: 1.5 }), /integer/);
  assert.throws(() => createFlow(a, { ...salaryFlow, graceDays: 5, missedAfterDays: 2 }), /graceDays/);
  const single = createFlow(a, { direction: "out", name: "Rent", cadence: "monthly", dayOfMonth: 1, amountTypCents: 3_000_000 });
  const f = getFlow(a, single)!;
  assert.deepEqual([f.amountMinCents, f.amountTypCents, f.amountMaxCents], [3_000_000, 3_000_000, 3_000_000]);
  const range = getFlow(a, createFlow(a, { direction: "out", name: "KPLC", cadence: "monthly", dayOfMonth: 5, amountMinCents: 200_000, amountMaxCents: 400_000 }))!;
  assert.equal(range.amountTypCents, 300_000);
  const s1 = createFlow(a, { ...salaryFlow, source: "detected", sourceRef: "periodic:abc" });
  const s2 = createFlow(a, { ...salaryFlow, source: "detected", sourceRef: "periodic:abc" });
  assert.equal(s1, s2);
  assert.equal(listFlows(a).length, 3);
  assert.equal(listFlows(a, { direction: "out" }).length, 2);
  const u = updateFlow(a, single, { dayOfMonth: 2, amountTypCents: 3_100_000, amountMinCents: 3_100_000, amountMaxCents: 3_100_000 });
  assert.equal(u.dayOfMonth, 2); assert.equal(u.amountTypCents, 3_100_000);
  assert.throws(() => updateFlow(a, single, { cadence: "weekly" }), /weekday/);
  assert.throws(() => updateFlow(a, 999, {}), /no flow/);
});

test("refreshOccurrences: generates a rolling window, idempotent, shifts for holidays", () => {
  const { a } = mk();
  const NOW = at(2026, 10, 29, 12);
  const fid = createFlow(a, salaryFlow, NOW);
  const r1 = refreshOccurrences(a, NOW);
  assert.ok(r1.created > 0);
  const occ = listOccurrences(a, { flowId: fid });
  assert.deepEqual(occ.map((o) => o.dueOn).slice(0, 3), ["2026-07-28", "2026-08-28", "2026-09-28"]);
  assert.equal(occ.find((o) => o.nominalOn === "2026-11-28")!.dueOn, "2026-11-27"); // Saturday -> Friday
  assert.equal(occ.find((o) => o.nominalOn === "2026-11-28")!.state, "upcoming");
  const r2 = refreshOccurrences(a, NOW);
  assert.deepEqual([r2.created, r2.updated, r2.removed], [0, 0, 0]);
  assert.equal(listOccurrences(a, { flowId: fid }).length, occ.length);
  // horizon is 90 days ahead
  assert.ok(occ.every((o) => o.dueOn <= "2027-01-27"));
});

test("salary end-to-end: upcoming -> late -> missed -> late arrival matches; delay stats", () => {
  const { a, cp, tx } = mk();
  const emp = cp("EMPLOYER LTD");
  const fid = createFlow(a, { ...salaryFlow, holidayPolicy: "none" }, at(2026, 6, 1));
  // history: Jul on time, Aug 2 days late, Sep early; Oct not yet
  tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 7, 28) });
  tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 8, 30) });
  tx({ cp: emp, amount: 5_100_000, dir: "in", when: at(2026, 9, 26) });
  const state = (now: number) => { refreshOccurrences(a, now); return listOccurrences(a, { flowId: fid }).find((o) => o.nominalOn === "2026-10-28")!; };
  assert.equal(state(at(2026, 10, 28, 12)).state, "upcoming");
  assert.equal(state(at(2026, 10, 29, 12)).state, "upcoming");
  assert.equal(state(at(2026, 10, 30, 12)).state, "late");
  assert.equal(state(at(2026, 11, 5, 12)).state, "missed");
  tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 11, 6) });
  const o = state(at(2026, 11, 7, 12));
  assert.equal(o.state, "matched"); assert.equal(o.delayDays, 9); assert.equal(o.receivedCents, 5_000_000);
  const jul = listOccurrences(a, { flowId: fid }).find((x) => x.nominalOn === "2026-07-28")!;
  assert.equal(jul.state, "matched"); assert.equal(jul.delayDays, 0);
  const st = flowStats(a, fid);
  assert.equal(st.counts.matched >= 4, true);
  assert.equal(st.medianDelayDays, 1); // [0, 2, -2, 9] -> sorted [-2,0,2,9]
  assert.equal(st.onTimeRate! > 0 && st.onTimeRate! < 1, true);
  // idempotent
  const again = refreshOccurrences(a, at(2026, 11, 7, 12));
  assert.deepEqual([again.created, again.updated], [0, 0]);
});

test("flows do not steal each other's transactions", () => {
  const { a, cp, tx } = mk();
  const emp = cp("EMPLOYER");
  const f1 = createFlow(a, { ...salaryFlow, name: "Salary A", holidayPolicy: "none" }, 1);
  const f2 = createFlow(a, { ...salaryFlow, name: "Salary B", holidayPolicy: "none" }, 1);
  const t = tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 10, 28) });
  refreshOccurrences(a, at(2026, 10, 29, 12));
  const get = (f: number) => listOccurrences(a, { flowId: f }).find((o) => o.nominalOn === "2026-10-28")!;
  const claimed = [get(f1), get(f2)].filter((o) => o.matchedTxIds.includes(t));
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.flowId, f1); // lowest id wins deterministically
});

test("obligation partials accumulate, and ledger classes gate what can match", () => {
  const { a, cp, tx } = mk();
  const ll = cp("LANDLORD KAMAU");
  const fid = createFlow(a, { direction: "out", name: "Rent", counterpartyHint: "landlord", amountTypCents: 3_000_000, cadence: "monthly", dayOfMonth: 1, graceDays: 2, missedAfterDays: 10 }, 1);
  tx({ cp: ll, amount: 1_000_000, dir: "out", when: at(2026, 11, 1) });
  tx({ cp: ll, amount: 700_000, dir: "out", when: at(2026, 11, 2), cls: "reversal" });  // reversal never matches
  tx({ cp: ll, amount: 2_000_000, dir: "out", when: at(2026, 11, 2), cls: "cash_out" }); // cash is not a payment to the landlord
  const now = at(2026, 11, 3, 12);
  refreshOccurrences(a, now);
  const nov = () => listOccurrences(a, { flowId: fid }).find((o) => o.nominalOn === "2026-11-01")!;
  assert.equal(nov().state, "partial"); assert.equal(nov().receivedCents, 1_000_000);
  tx({ cp: ll, amount: 2_000_000, dir: "out", when: at(2026, 11, 4) });
  refreshOccurrences(a, at(2026, 11, 5, 12));
  assert.equal(nov().state, "matched"); assert.equal(nov().delayDays, 3);
});

test("Fuliza obligation: auto-created from the account, deduped, updated, superseded, closed; repayment matches", () => {
  const { a, db, tx } = mk();
  db.prepare(`INSERT INTO accounts (provider, kind, name, account_mask, outstanding_cents, due_at, created_at, updated_at) VALUES ('mpesa','credit','Fuliza M-PESA','FULIZA',50000,?,1,1)`).run(at(2026, 11, 20, 12));
  const NOW = at(2026, 11, 1, 12);
  const id = syncFulizaObligation(a, NOW)!;
  assert.ok(id);
  assert.equal(syncFulizaObligation(a, NOW), id);
  const f = getFlow(a, id)!;
  assert.deepEqual([f.status, f.source, f.direction, f.anchorOn, f.amountTypCents], ["suggested", "sms", "out", "2026-11-20", 50_000]);
  assert.equal(listFlows(a).length, 1);
  // outstanding changes under the same due date: amount follows
  db.prepare("UPDATE accounts SET outstanding_cents = 80000").run();
  assert.equal(syncFulizaObligation(a, NOW), id);
  assert.equal(getFlow(a, id)!.amountMinCents, 80_000);
  refreshOccurrences(a, NOW);
  const occ = () => listOccurrences(a, { flowId: id });
  assert.equal(occ().length, 1); assert.equal(occ()[0]!.dueOn, "2026-11-20");
  // partial then full repayment (loan_repay rows match via template text)
  tx({ amount: 30_000, dir: "out", when: at(2026, 11, 10), kind: "loan_repay", template: "mpesa.fuliza_repay", cls: "debt_repay" });
  refreshOccurrences(a, at(2026, 11, 11, 12));
  assert.equal(occ()[0]!.state, "partial");
  tx({ amount: 50_000, dir: "out", when: at(2026, 11, 12), kind: "loan_repay", template: "mpesa.fuliza_repay_full", cls: "debt_repay" });
  refreshOccurrences(a, at(2026, 11, 13, 12));
  assert.equal(occ()[0]!.state, "matched"); assert.equal(occ()[0]!.receivedCents, 80_000); assert.equal(occ()[0]!.delayDays, -8);
  // a new draw moves the due date: old, fully-paid flow is kept (it has history), new one is added
  db.prepare("UPDATE accounts SET outstanding_cents = 20000, due_at = ?").run(at(2026, 12, 5, 12));
  const id2 = syncFulizaObligation(a, at(2026, 11, 14))!;
  assert.notEqual(id2, id);
  assert.equal(getFlow(a, id)!.status, "ended");
  // unpaid older flows are replaced outright
  db.prepare("UPDATE accounts SET due_at = ?").run(at(2026, 12, 9, 12));
  const id3 = syncFulizaObligation(a, at(2026, 11, 15))!;
  assert.ok(!listFlows(a).some((x) => x.sourceRef === "fuliza::2026-12-05"), "older unpaid flow replaced");
  assert.equal(getFlow(a, id3)!.anchorOn, "2026-12-09");
  // cleared: unpaid auto flow disappears
  db.prepare("UPDATE accounts SET outstanding_cents = 0").run();
  assert.equal(syncFulizaObligation(a, at(2026, 11, 16)), null);
  assert.equal(listFlows(a).filter((x) => x.status !== "ended").length, 0);
  // dismissed flows are not resurrected or modified
  db.prepare("UPDATE accounts SET outstanding_cents = 9000, due_at = ?").run(at(2026, 12, 30, 12));
  const id4 = syncFulizaObligation(a, at(2026, 11, 17))!;
  setFlowStatus(a, id4, "dismissed", 5);
  db.prepare("UPDATE accounts SET outstanding_cents = 9500").run();
  assert.equal(syncFulizaObligation(a, at(2026, 11, 18)), id4);
  assert.equal(getFlow(a, id4)!.amountTypCents, 9_000);
  refreshOccurrences(a, at(2026, 11, 18));
  assert.equal(listOccurrences(a, { flowId: id4 }).length, 0);
});

test("Okoa notice -> obligation; telco okoa repay rows (hidden from tx_events) still match", () => {
  const { a, tx } = mk();
  const id = ingestDueNotice(a, { kind: "okoa", dueOn: "2026-10-30", outstandingCents: 2_250 }, at(2026, 10, 26))!;
  assert.equal(ingestDueNotice(a, { kind: "okoa", dueOn: "2026-10-30", outstandingCents: 2_250 }, at(2026, 10, 26)), id);
  assert.equal(ingestDueNotice(a, { kind: "okoa", outstandingCents: 1 }), null);
  tx({ amount: 2_250, dir: "out", when: at(2026, 10, 28), kind: "loan_repay", template: "telco.okoa_repay", cls: "debt_repay" });
  refreshOccurrences(a, at(2026, 10, 29, 12));
  assert.equal(listOccurrences(a, { flowId: id })[0]!.state, "matched");
});

test("manual overrides: pin, reject, waive, unwaive survive refreshes", () => {
  const { a, cp, tx } = mk();
  const emp = cp("EMPLOYER");
  const fid = createFlow(a, { ...salaryFlow, holidayPolicy: "none" }, 1);
  const good = tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 10, 28) });
  const odd = tx({ cp: null, amount: 123_000, dir: "in", when: at(2026, 10, 20) });
  const now = at(2026, 10, 29, 12);
  refreshOccurrences(a, now);
  const o = () => listOccurrences(a, { flowId: fid }).find((x) => x.nominalOn === "2026-10-28")!;
  assert.deepEqual(o().matchedTxIds, [good]);
  rejectTransaction(a, o().id, good);
  refreshOccurrences(a, now);
  assert.deepEqual(o().matchedTxIds, []);
  pinTransaction(a, o().id, odd);
  refreshOccurrences(a, now);
  assert.ok(o().matchedTxIds.includes(odd)); assert.equal(o().state, "partial");
  clearTransactionOverride(a, o().id, good);
  refreshOccurrences(a, now);
  assert.deepEqual(o().matchedTxIds.sort(), [good, odd].sort()); assert.equal(o().state, "matched");
  waiveOccurrence(a, o().id, now);
  refreshOccurrences(a, now);
  assert.equal(o().state, "waived"); assert.deepEqual(o().matchedTxIds, []);
  assert.equal(flowStats(a, fid).counts.waived, 1);
  unwaiveOccurrence(a, o().id, now);
  refreshOccurrences(a, now);
  assert.equal(o().state, "matched");
});

test("pause/delete/edit: inactive flows drop future upcoming rows, cadence edits regenerate", () => {
  const { a } = mk();
  const NOW = at(2026, 10, 29, 12);
  const fid = createFlow(a, { ...salaryFlow, holidayPolicy: "none" }, NOW);
  refreshOccurrences(a, NOW);
  const before = listOccurrences(a, { flowId: fid, fromDay: "2026-11-01" });
  assert.ok(before.length >= 2);
  updateFlow(a, fid, { dayOfMonth: 15 }, NOW);
  refreshOccurrences(a, NOW);
  const after = listOccurrences(a, { flowId: fid, fromDay: "2026-11-01" });
  assert.deepEqual(after.map((o) => o.nominalOn).slice(0, 2), ["2026-11-15", "2026-12-15"]);
  setFlowStatus(a, fid, "paused", NOW);
  refreshOccurrences(a, NOW);
  assert.equal(listOccurrences(a, { flowId: fid, fromDay: "2026-10-30" }).length, 0);
  setFlowStatus(a, fid, "active", NOW);
  refreshOccurrences(a, NOW);
  assert.ok(listOccurrences(a, { flowId: fid, fromDay: "2026-10-30" }).length >= 2);
  deleteFlow(a, fid);
  assert.equal(listOccurrences(a).length, 0);
});

test("performance: 300 flows x 90-day window refresh is fast and stable", () => {
  const { a } = mk();
  const NOW = at(2026, 10, 29, 12);
  for (let i = 0; i < 300; i++) createFlow(a, { direction: i % 2 ? "in" : "out", name: `f${i}`, counterpartyHint: `h${i}`, amountTypCents: 100_000 + i, cadence: i % 3 ? "monthly" : "weekly", dayOfMonth: 1 + (i % 28), weekday: i % 7, holidayPolicy: "after" }, NOW);
  const t0 = Date.now();
  const r = refreshOccurrences(a, NOW);
  const dt = Date.now() - t0;
  assert.ok(r.created > 1000);
  assert.ok(dt < 15_000, `took ${dt}ms`);
  const r2 = refreshOccurrences(a, NOW);
  assert.deepEqual([r2.created, r2.updated, r2.removed], [0, 0, 0]);
});

test("savings locations and goals: pot arithmetic, virtual flag, no negative balances", () => {
  const { a } = mk();
  const pot = createSavingsLocation(a, { name: "Rent pot", rail: "mpesa_pot", balanceCents: 500_000 }, 10);
  const ms = createSavingsLocation(a, { name: "M-Shwari", rail: "mshwari", balanceCents: 900_000 }, 10);
  assert.equal(listSavingsLocations(a).find((l) => l.id === pot)!.isVirtual, true);
  assert.equal(listSavingsLocations(a).find((l) => l.id === ms)!.isVirtual, false);
  assert.equal(virtualPotsTotal(a), 500_000);
  assert.equal(adjustLocation(a, pot, 250_000, 11), 750_000);
  assert.equal(adjustLocation(a, pot, -750_000, 12), 0);
  assert.throws(() => adjustLocation(a, pot, -1), /exceeds/);
  assert.throws(() => adjustLocation(a, pot, 1.5), /integer/);
  assert.throws(() => setLocationBalance(a, pot, -5), /non-negative/);
  setLocationBalance(a, pot, 400_000, 13);
  assert.equal(virtualPotsTotal(a), 400_000);
  closeSavingsLocation(a, pot);
  assert.equal(virtualPotsTotal(a), 0);
  assert.equal(listSavingsLocations(a).length, 1);
  assert.equal(listSavingsLocations(a, true).length, 2);
  const g = createSavingsGoal(a, { name: "Laptop", targetCents: 1_000_000, locationId: ms, targetOn: "2027-03-01" }, 10);
  assert.throws(() => createSavingsGoal(a, { name: "bad", targetCents: 0 }), /positive/);
  assert.equal(adjustGoal(a, g, 400_000).status, "active");
  assert.equal(adjustGoal(a, g, 600_000).status, "achieved");
  assert.equal(adjustGoal(a, g, -100_000).status, "active");
  assert.equal(adjustGoal(a, g, -9_000_000).savedCents, 0);
  assert.equal(listSavingsGoals(a).length, 1);
  assert.equal(goalProgressFor(listSavingsGoals(a)[0]!, at(2026, 10, 29), 100_000).pct, 0);
});

test("budgets: scope by label (incl. children) and tag, fees included, pace via DB, rollover", () => {
  const { db, a, tx } = mk();
  const lab = (n: string) => (db.prepare("SELECT id FROM labels WHERE name = ?").get(n) as { id: number }).id;
  const groceries = lab("Groceries"), utilities = lab("Utilities");
  const parentId = (db.prepare("SELECT parent_id p FROM labels WHERE id = ?").get(groceries) as { p: number | null }).p;
  const label = (txId: number, l: number) => db.prepare("INSERT INTO tx_labels (tx_id, label_id, source, suggested_at, confirmed_at) VALUES (?,?, 'user', 1, 1)").run(txId, l);
  const g1 = tx({ amount: 100_000, dir: "out", when: at(2026, 10, 5), fee: 1_000 }); label(g1, groceries);
  const g2 = tx({ amount: 200_000, dir: "out", when: at(2026, 10, 6) }); label(g2, groceries);
  const u1 = tx({ amount: 50_000, dir: "out", when: at(2026, 10, 7) }); label(u1, utilities);
  const f1 = tx({ amount: 3_000, dir: "out", when: at(2026, 10, 7), kind: "fee", cls: "fee" }); label(f1, groceries);
  const sep = tx({ amount: 400_000, dir: "out", when: at(2026, 9, 15) }); label(sep, groceries);
  tx({ amount: 999_999, dir: "in", when: at(2026, 10, 8) });                                  // income never counts
  tx({ amount: 777_777, dir: "out", when: at(2026, 10, 8), cls: "debt_repay", kind: "loan_repay" }); // debt principal never counts
  const from = at(2026, 10, 1, 0), to = at(2026, 11, 1, 0);
  assert.equal(budgetSpendEvents(a, { labelId: groceries, tagId: null }, from, to).reduce((s, e) => s + e.amountCents, 0), 101_000 + 200_000 + 3_000);
  assert.equal(budgetSpendEvents(a, { labelId: utilities, tagId: null }, from, to).length, 1);
  assert.equal(budgetSpendEvents(a, { labelId: null, tagId: null }, from, to).reduce((s, e) => s + e.amountCents, 0), 101_000 + 200_000 + 50_000 + 3_000);
  if (parentId != null) assert.ok(budgetSpendEvents(a, { labelId: parentId, tagId: null }, from, to).length >= 4, "parent label includes children");
  db.prepare("INSERT INTO tags (name, kind, created_at) VALUES ('shop','user',1)").run();
  db.prepare("INSERT INTO tx_tags (tx_id, tag_id, created_at) VALUES (?,1,1)").run(g2);
  assert.equal(budgetSpendEvents(a, { labelId: null, tagId: 1 }, from, to).length, 1);

  const NOW = at(2026, 10, 16, 12);
  const b = createBudget(a, { name: "Groceries", period: "monthly", limitCents: 1_000_000, labelId: groceries, rollover: true }, NOW);
  const p = budgetPace(a, b, NOW);
  assert.equal(p.spentCents, 304_000);
  assert.equal(p.carryCents, 600_000); // September: 1,000,000 - 400,000
  assert.equal(p.effectiveLimitCents, 1_600_000);
  assert.equal(p.bounds.startDay, "2026-10-01");
  assert.equal(listBudgets(a).length, 1);
  assert.throws(() => createBudget(a, { name: "x", period: "custom", limitCents: 1 }), /custom/);
  assert.throws(() => createBudget(a, { name: "x", period: "monthly", limitCents: 0 }), /positive/);
  const u = updateBudget(a, b, { limitCents: 500_000, rollover: false }, NOW);
  assert.equal(u.rollover, false);
  assert.equal(budgetPace(a, b, NOW).carryCents, 0);
  assert.equal(budgetPace(a, b, NOW).status, "at_risk"); // 304,000 spent at mid-month vs 500,000 limit
  updateBudget(a, b, { status: "paused" }, NOW);
  assert.equal(listBudgets(a).length, 0);
  deleteBudget(a, b);
  assert.equal(listBudgets(a, true).length, 0);
});

test("floatSnapshot wires balance, pots, obligations, income reliability, budgets and Fuliza", () => {
  const { db, a, cp, tx } = mk();
  const NOW = at(2026, 10, 29, 12);
  db.prepare(`INSERT INTO accounts (provider, kind, name, account_mask, last_balance_cents, last_balance_at, created_at, updated_at) VALUES ('mpesa','wallet','M-PESA','WALLET',2000000,?,1,1)`).run(NOW - 3_600_000);
  db.prepare(`INSERT INTO accounts (provider, kind, name, account_mask, outstanding_cents, due_at, created_at, updated_at) VALUES ('mpesa','credit','Fuliza M-PESA','FULIZA',100000,?,1,1)`).run(at(2026, 11, 3, 12));
  createSavingsLocation(a, { name: "Pot", rail: "mpesa_pot", balanceCents: 300_000 }, NOW);
  createSavingsLocation(a, { name: "Bank", rail: "bank", balanceCents: 9_000_000 }, NOW);
  const emp = cp("EMPLOYER");
  createFlow(a, { ...salaryFlow, holidayPolicy: "none", dayOfMonth: 29 }, NOW);   // due today
  createFlow(a, { direction: "out", name: "Rent", amountTypCents: 600_000, cadence: "monthly", dayOfMonth: 1, counterpartyHint: "landlord" }, NOW);
  tx({ cp: emp, amount: 5_000_000, dir: "in", when: at(2026, 9, 29) });
  syncFulizaObligation(a, NOW);
  refreshOccurrences(a, NOW);
  const f = floatSnapshot(a, NOW, { dailySpendP50Cents: 20_000, dailySpendP90Cents: 50_000 });
  assert.equal(f.quality, "ok");
  assert.equal(f.potsCents, 300_000);                       // only the virtual pot
  assert.equal(f.obligationsDueCents, 600_000 + 100_000);   // rent on Nov 1 + Fuliza due Nov 3 (both within 7 days)
  assert.equal(f.freeFloatCents, 2_000_000 - 300_000 - 700_000);
  assert.equal(f.sweep!.outstandingCents, 100_000);
  assert.equal(f.sweep!.severity, "warn");
  assert.ok(f.safeToSpend!.highCents > f.safeToSpend!.lowCents);
  assert.equal(f.inputs.expectedIncome >= 1, true);
  const none = floatSnapshot(mk().a, NOW);
  assert.equal(none.quality, "unknown");
});
