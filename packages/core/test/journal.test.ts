import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  addManualCheck, auditJournalEntry, auditOutcome, buildDailySeries, createJournalEntry, evaluateJournalRule, evaluationDays, getJournalEntry, journalAdherence,
  journalWilson, listChecks, listJournalEntries, mergeChecks, ruleMetric, runJournalChecks, setJournalStatus, summariseAdherence, tCritical95, validateJournalRule,
  type JournalLedgerTx, type JournalRule,
} from "../src/journal/index.js";
import { dayOf } from "../src/expect/eat.js";
import { migrate } from "../src/db/migrate.js";
import { RESET_TABLES, resetAllData } from "../src/db/maintenance.js";
import { adapter, at } from "./fixtures.js";

const D = 86_400_000;
const NOW = at(2026, 10, 26, 12);
const cov = { fromMs: at(2026, 9, 1, 0), throughMs: NOW };
const win = (startOn: string, o: any = {}) => ({ startOn, endOn: null, coverage: cov, nowMs: NOW, ...o });
let id = 0;
const spend = (day: string, hour: number, cents: number, o: Partial<JournalLedgerTx> = {}): JournalLedgerTx => {
  const [y, m, d] = day.split("-").map(Number);
  return { id: ++id, occurredAt: at(y!, m!, d!, hour), direction: "out", amountCents: cents, feeCents: 0, flowClass: "spend", ...o };
};
const states = (cs: Array<{ onDate: string; state: string }>) => cs.map((c) => `${c.onDate.slice(8)}:${c.state[0]}`).join(" ");

test("validateJournalRule", () => {
  assert.equal(validateJournalRule({ kind: "weekly_spend_max", maxCents: 100 }), true);
  assert.equal(validateJournalRule({ kind: "no_fuliza_draw", days: 14 }), true);
  assert.equal(validateJournalRule({ kind: "no_fuliza_draw", days: 0 }), false);
  assert.equal(validateJournalRule({ kind: "daily_spend_max", maxCents: 1.5 }), false);
  assert.equal(validateJournalRule({ kind: "daily_spend_max", maxCents: -1 }), false);
  assert.equal(validateJournalRule({ kind: "no_txn_after_hour", hour: 24 }), false);
  assert.equal(validateJournalRule({ kind: "nope" }), false);
  assert.equal(validateJournalRule(null), false);
});

test("evaluationDays: stops at yesterday, endOn and rule length; today is never judged", () => {
  assert.equal(evaluationDays(win("2026-10-20")).at(-1), "2026-10-25");
  assert.equal(evaluationDays(win("2026-10-20", { endOn: "2026-10-22" })).length, 3);
  assert.equal(evaluationDays(win("2026-10-20"), 3).length, 3);
  assert.deepEqual(evaluationDays(win("2026-10-26")), []);
  assert.deepEqual(evaluationDays(win("2026-10-30")), []);
});

test("daily_spend_max: boundary, fees count, label scope, non-spend ignored", () => {
  const rule: JournalRule = { kind: "daily_spend_max", maxCents: 50_000 };
  const txs = [
    spend("2026-10-20", 9, 50_000), // exactly at limit -> followed
    spend("2026-10-21", 9, 49_000, { feeCents: 1_001 }), // fee pushes over
    spend("2026-10-22", 23, 30_000), spend("2026-10-22", 9, 20_001), // two payments
    spend("2026-10-23", 9, 900_000, { flowClass: "transfer_own" }), // not spend
    spend("2026-10-24", 9, 100, { flowClass: "fee" }),
    spend("2026-10-25", 9, 900_000, { direction: "in", flowClass: "income" }),
  ];
  const r = evaluateJournalRule(rule, txs, win("2026-10-20"));
  assert.equal(states(r), "20:f 21:s 22:s 23:f 24:f 25:f");
  assert.deepEqual(r[1]!.evidenceTxIds, [txs[1]!.id]);
  assert.equal(r[2]!.evidenceTxIds.length, 2);
  const scoped = evaluateJournalRule({ ...rule, labelId: 7 } as JournalRule, [spend("2026-10-20", 9, 900_000, { labelId: 8 }), spend("2026-10-21", 9, 900_000, { labelId: 7 })], win("2026-10-20", { endOn: "2026-10-21" }));
  assert.equal(states(scoped), "20:f 21:s");
});

test("day boundaries are Africa/Nairobi: 23:30 EAT belongs to that day, 00:10 EAT to the next", () => {
  const rule: JournalRule = { kind: "daily_spend_max", maxCents: 100 };
  const late = { id: 1, occurredAt: Date.UTC(2026, 9, 20, 20, 30), direction: "out" as const, amountCents: 500, flowClass: "spend" }; // 23:30 EAT on the 20th
  const early = { id: 2, occurredAt: Date.UTC(2026, 9, 20, 21, 10), direction: "out" as const, amountCents: 500, flowClass: "spend" }; // 00:10 EAT on the 21st
  assert.equal(states(evaluateJournalRule(rule, [late], win("2026-10-20", { endOn: "2026-10-21" }))), "20:s 21:f");
  assert.equal(states(evaluateJournalRule(rule, [early], win("2026-10-20", { endOn: "2026-10-21" }))), "20:f 21:s");
});

test("weekly_spend_max: rolling 7 days clipped to the start; slips on the crossing day and stays slipped while in window", () => {
  const rule: JournalRule = { kind: "weekly_spend_max", maxCents: 100_000 };
  const txs = [spend("2026-10-19", 9, 60_000), spend("2026-10-21", 9, 50_000)]; // crosses on the 21st; leaves window after the 27th... start 19th
  const r = evaluateJournalRule(rule, txs, win("2026-10-19"));
  assert.equal(states(r), "19:f 20:f 21:s 22:s 23:s 24:s 25:s");
  // prior-to-start spend is not counted
  const r2 = evaluateJournalRule(rule, [spend("2026-10-15", 9, 900_000)], win("2026-10-19", { endOn: "2026-10-20" }));
  assert.equal(states(r2), "19:f 20:f");
  // old spend ages out of the 7-day window
  const r3 = evaluateJournalRule(rule, [spend("2026-10-12", 9, 150_000)], win("2026-10-10", { endOn: "2026-10-19" }));
  assert.equal(states(r3), "10:f 11:f 12:s 13:s 14:s 15:s 16:s 17:s 18:s 19:f");
});

test("no_fuliza_draw: slips on draw days; targetMet only when the window completes clean", () => {
  const rule: JournalRule = { kind: "no_fuliza_draw", days: 14 };
  const draw = (day: string) => spend(day, 10, 100_000, { isFulizaDraw: true, flowClass: null });
  const clean = evaluateJournalRule(rule, [], win("2026-10-01"));
  assert.equal(clean.length, 14);
  assert.equal(clean.every((c) => c.state === "followed"), true);
  const a = summariseAdherence(clean, { targetDays: 14 });
  assert.deepEqual([a.targetMet, a.followed, a.verdict], [true, 14, "mostly_followed"]);
  const slip = evaluateJournalRule(rule, [draw("2026-10-05")], win("2026-10-01"));
  assert.equal(slip[4]!.state, "slipped");
  assert.equal(summariseAdherence(slip, { targetDays: 14 }).targetMet, false);
  // incomplete window: unknown, not met
  const partial = evaluateJournalRule(rule, [], win("2026-10-20"));
  assert.equal(partial.length, 6);
  assert.equal(summariseAdherence(partial, { targetDays: 14 }).targetMet, null);
  // days beyond the target are not judged
  assert.equal(evaluateJournalRule({ kind: "no_fuliza_draw", days: 3 }, [], win("2026-10-01")).length, 3);
});

test("no_send_over and no_txn_after_hour", () => {
  const r = evaluateJournalRule({ kind: "no_send_over", cents: 10_000 }, [spend("2026-10-20", 9, 10_000), spend("2026-10-21", 9, 10_001), spend("2026-10-22", 9, 99_999, { direction: "in" })], win("2026-10-20", { endOn: "2026-10-22" }));
  assert.equal(states(r), "20:f 21:s 22:f");
  const h = evaluateJournalRule({ kind: "no_txn_after_hour", hour: 21 }, [spend("2026-10-20", 20, 100), spend("2026-10-21", 21, 100), spend("2026-10-22", 23, 100, { flowClass: "transfer_own" }), spend("2026-10-23", 22, 100, { isFulizaDraw: true, flowClass: null })], win("2026-10-20", { endOn: "2026-10-23" }));
  assert.equal(states(h), "20:f 21:s 22:f 23:s");
});

test("coverage: days outside the ledger are 'na', never 'followed'", () => {
  const rule: JournalRule = { kind: "daily_spend_max", maxCents: 1 };
  const w = win("2026-08-30", { endOn: "2026-09-02" });
  assert.equal(states(evaluateJournalRule(rule, [], w)), "30:n 31:n 01:f 02:f");
  assert.equal(states(evaluateJournalRule(rule, [], win("2026-10-23", { coverage: { fromMs: cov.fromMs, throughMs: at(2026, 10, 25, 5) } }))), "23:f 24:f 25:n");
  assert.equal(states(evaluateJournalRule(rule, [], win("2026-10-23", { coverage: null }))), "23:n 24:n 25:n");
});

test("adherence summary: counts first, no verdict below the minimum sample, Wilson interval", () => {
  const mk = (f: number, s: number, sk = 0, na = 0) => [...Array(f).fill({ state: "followed" }), ...Array(s).fill({ state: "slipped" }), ...Array(sk).fill({ state: "skipped" }), ...Array(na).fill({ state: "na" })];
  const small = summariseAdherence(mk(5, 0));
  assert.deepEqual([small.evaluated, small.verdict, small.sampleSufficient, small.adherence], [5, "insufficient_data", false, 1]);
  assert.match(small.summary, /5 followed, 0 slipped over 5 judged days\. Fewer than 7 judged days/);
  assert.equal(summariseAdherence(mk(6, 1)).verdict, "mostly_followed");
  assert.equal(summariseAdherence(mk(4, 3)).verdict, "mixed");
  assert.equal(summariseAdherence(mk(2, 5)).verdict, "mostly_slipped");
  assert.equal(summariseAdherence(mk(8, 2), { minSample: 11 }).verdict, "insufficient_data");
  const withGaps = summariseAdherence(mk(6, 2, 3, 4));
  assert.deepEqual([withGaps.evaluated, withGaps.skipped, withGaps.na], [8, 3, 4]); // skipped/na carry no information
  assert.match(withGaps.summary, /3 skipped, 4 without data/);
  const none = summariseAdherence([]);
  assert.deepEqual([none.adherence, none.interval, none.verdict], [null, null, "insufficient_data"]);
  const w = journalWilson(7, 10)!;
  assert.ok(w.low > 0.39 && w.low < 0.40 && w.high > 0.89 && w.high < 0.92, JSON.stringify(w));
  assert.deepEqual(journalWilson(0, 0), null);
  assert.ok(journalWilson(10, 10)!.high === 1 && journalWilson(10, 10)!.low < 0.75);
});

test("mergeChecks: manual overrides auto for the same day", () => {
  const m = mergeChecks([{ onDate: "2026-10-20", state: "slipped", evidenceTxIds: [], detail: "" }, { onDate: "2026-10-21", state: "followed", evidenceTxIds: [], detail: "" }], [{ onDate: "2026-10-20", state: "skipped" }, { onDate: "2026-10-22", state: "followed" }]);
  assert.deepEqual(m.map((x) => `${x.onDate.slice(8)}${x.state[0]}${x.source[0]}`), ["20sm", "21fa", "22fm"]);
});

test("outcome audit: insufficient below the minimum on either side, never a claim", () => {
  const series = (from: number, n: number, v: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ day: dayOf(at(2026, 10, 15, 12) + (from + i) * D), value: v(i) }));
  const start = "2026-10-15";
  const a = auditOutcome([...series(-13, 13, () => 1000), ...series(0, 14, () => 0)], start);
  assert.deepEqual([a.verdict, a.diff, a.interval, a.intervalExcludesZero], ["insufficient_data", null, null, false]); // dramatic drop, but 13 < 14 baseline days
  assert.match(a.summary, /13 days before and 14 days after/);
  const b = auditOutcome([...series(-14, 14, () => 1000), ...series(0, 13, () => 0)], start);
  assert.equal(b.verdict, "insufficient_data");
  assert.deepEqual(auditOutcome([], start).verdict, "insufficient_data");
  assert.match(a.caveat, /Observational/);
});

test("outcome audit: improved / worsened / inconclusive with intervals; higher-is-better flips", () => {
  const start = "2026-10-15";
  const S = (from: number, n: number, v: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ day: dayOf(at(2026, 10, 15, 12) + (from + i) * D), value: v(i) }));
  const noise = (base: number, amp: number) => (i: number) => base + (i % 2 === 0 ? amp : -amp);
  const better = auditOutcome([...S(-20, 20, noise(1000, 50)), ...S(0, 20, noise(600, 50))], start);
  assert.equal(better.verdict, "improved");
  assert.ok(better.diff! < -300 && better.interval!.high < 0 && better.intervalExcludesZero);
  assert.deepEqual([better.before.n, better.after.n, better.before.mean, better.after.mean], [20, 20, 1000, 600]);
  const worse = auditOutcome([...S(-20, 20, noise(600, 50)), ...S(0, 20, noise(1000, 50))], start);
  assert.equal(worse.verdict, "worsened");
  assert.equal(auditOutcome([...S(-20, 20, noise(600, 50)), ...S(0, 20, noise(1000, 50))], start, { betterWhen: "higher" }).verdict, "improved");
  // noisy small shift: interval includes zero -> inconclusive, and says so
  const noisy = auditOutcome([...S(-14, 14, (i) => 1000 + ((i * 7919) % 13) * 80), ...S(0, 14, (i) => 1010 + ((i * 104729) % 11) * 90)], start);
  assert.equal(noisy.verdict, "inconclusive");
  assert.equal(noisy.intervalExcludesZero, false);
  assert.match(noisy.summary, /includes zero/);
  // identical constant series: zero variance, no false claim
  assert.equal(auditOutcome([...S(-14, 14, () => 5), ...S(0, 14, () => 5)], start).verdict, "inconclusive");
  // constant but different: degenerate variance is an exact difference
  assert.equal(auditOutcome([...S(-14, 14, () => 5), ...S(0, 14, () => 0)], start).verdict, "improved");
  // custom minimum honoured, baseline window honoured
  assert.equal(auditOutcome([...S(-20, 20, noise(1000, 50)), ...S(0, 20, noise(600, 50))], start, { minPerSide: 21 }).verdict, "insufficient_data");
  assert.equal(auditOutcome([...S(-20, 20, noise(1000, 50)), ...S(0, 20, noise(600, 50))], start, { baselineDays: 10 }).verdict, "insufficient_data");
  assert.equal(auditOutcome([...S(-20, 20, noise(1000, 50)), ...S(0, 20, noise(600, 50))], start, { endOn: dayOf(at(2026, 10, 15, 12) + 5 * D) }).verdict, "insufficient_data");
});

test("t critical values are conservative at small df", () => {
  assert.equal(tCritical95(1), 12.71); assert.equal(tCritical95(13), 2.13); assert.equal(tCritical95(1000), 1.96); assert.equal(tCritical95(0), Infinity);
});

test("ruleMetric + buildDailySeries zero-fill and use EAT days", () => {
  const txs = [spend("2026-10-20", 9, 1_000), spend("2026-10-20", 20, 500, { feeCents: 50 }), spend("2026-10-22", 9, 700, { flowClass: "fee" })];
  const m = ruleMetric({ kind: "daily_spend_max", maxCents: 1 });
  const s = buildDailySeries(txs, "2026-10-19", "2026-10-23", m.valueOf, dayOf);
  assert.deepEqual(s.map((p) => p.value), [0, 1_550, 0, 700, 0]);
  assert.equal(ruleMetric({ kind: "no_fuliza_draw" }).valueOf([spend("2026-10-20", 9, 1, { isFulizaDraw: true })]), 1);
  assert.equal(ruleMetric({ kind: "no_send_over", cents: 5 }).valueOf(txs), 2); // the fee row is not a send
  assert.equal(ruleMetric({ kind: "no_txn_after_hour", hour: 20 }).valueOf(txs), 1);
});

// ---------------------------------------------------------------- store (SQLite)
function db() {
  const raw = new DatabaseSync(":memory:"); const a = adapter(raw); migrate(a);
  const ins = (day: string, hour: number, cents: number, o: { template?: string; cls?: string | null; dir?: string; fee?: number; role?: string } = {}) => {
    const [y, m, d] = day.split("-").map(Number);
    raw.prepare(`INSERT INTO transactions (provider, kind, direction, amount, fee, occurred_at, template, parser_version, chain_status, status, role, flow_class)
      VALUES ('mpesa','till',?,?,?,?,?, '1','ok','confirmed',?,?)`).run(o.dir ?? "out", cents, o.fee ?? 0, at(y!, m!, d!, hour), o.template ?? "mpesa.x", o.role ?? "transaction", o.cls === undefined ? "spend" : o.cls);
  };
  return { raw, a, ins };
}

test("schema v9: tables exist, are in RESET_TABLES, reset clears them, version is 9", () => {
  const { raw, a } = db();
  for (const t of ["alerts_log", "alert_prefs", "capture_prompts", "journal_entries", "journal_checks"]) {
    assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
    assert.ok((RESET_TABLES as readonly string[]).includes(t), `${t} in RESET_TABLES`);
  }
  assert.ok(RESET_TABLES.indexOf("journal_checks") < RESET_TABLES.indexOf("journal_entries"));
  assert.equal(a.get(`SELECT value FROM meta WHERE key='schema_version'`).value, "10");
  createJournalEntry(a, { decisionText: "x" }, NOW);
  resetAllData(a);
  assert.equal(a.get(`SELECT COUNT(*) c FROM journal_entries`).c, 0);
});

test("schema v9: upgrade from a v8 database adds the tables; re-running migrate is a no-op", () => {
  const { raw, a } = db();
  for (const t of ["journal_checks", "journal_entries", "capture_prompts", "alert_prefs", "alerts_log"]) raw.exec(`DROP TABLE ${t}`);
  raw.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run();
  migrate(a);
  assert.equal(a.get(`SELECT value FROM meta WHERE key='schema_version'`).value, "10");
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='journal_checks'").get());
  migrate(a); migrate(a);
  assert.equal(a.get(`SELECT value FROM meta WHERE key='schema_version'`).value, "10");
});

test("store: create/validate/list/status; invalid input rejected", () => {
  const { a } = db();
  assert.throws(() => createJournalEntry(a, { decisionText: "  " }, NOW), /decision text/);
  assert.throws(() => createJournalEntry(a, { decisionText: "x", rule: { kind: "daily_spend_max", maxCents: -1 } as any }, NOW), /invalid journal rule/);
  assert.throws(() => createJournalEntry(a, { decisionText: "x", startedOn: "2026-10-20", endsOn: "2026-10-19" }, NOW), /ends before/);
  const id1 = createJournalEntry(a, { decisionText: " Cap eating out ", why: "tight month", linkedBudgetId: 3, rule: { kind: "weekly_spend_max", maxCents: 100_000 }, baseline: { weeklyAvg: 150_000 } }, NOW);
  const e = getJournalEntry(a, id1)!;
  assert.deepEqual([e.decisionText, e.why, e.linkedBudgetId, e.startedOn, e.status, e.baseline], ["Cap eating out", "tight month", 3, "2026-10-26", "active", { weeklyAvg: 150_000 }]);
  assert.deepEqual(e.rule, { kind: "weekly_spend_max", maxCents: 100_000 });
  const id2 = createJournalEntry(a, { decisionText: "Be kinder to myself", linkedTxId: 5, linkedObligationId: 2 }, NOW);
  assert.equal(getJournalEntry(a, id2)!.rule, null);
  setJournalStatus(a, id2, "ended", NOW);
  assert.deepEqual(listJournalEntries(a).map((x) => x.id), [id1, id2]);
  assert.deepEqual(listJournalEntries(a, "active").map((x) => x.id), [id1]);
  assert.equal(getJournalEntry(a, 999), null);
});

test("store: nightly checks from the ledger, idempotent, manual check-ins are never overwritten, Fuliza draws (funding notices) are seen", () => {
  const { a, ins } = db();
  // coverage from Oct 1; spend 30k on the 20th, 80k on the 21st; Fuliza draw on the 22nd (role funding_notice, not in tx_events)
  ins("2026-10-01", 9, 100);
  ins("2026-10-20", 9, 30_000); ins("2026-10-21", 9, 80_000);
  ins("2026-10-22", 9, 50_000, { template: "mpesa.fuliza_draw", role: "funding_notice", cls: null });
  ins("2026-10-26", 8, 100); // latest SMS this morning: yesterday is fully covered
  const daily = createJournalEntry(a, { decisionText: "daily cap", rule: { kind: "daily_spend_max", maxCents: 50_000 }, startedOn: "2026-10-20" }, NOW);
  const r = runJournalChecks(a, daily, NOW);
  assert.equal(r.written, 6);
  assert.equal(states(listChecks(a, daily)), "20:f 21:s 22:f 23:f 24:f 25:f");
  assert.equal(listChecks(a, daily)[1]!.evidenceTxIds.length, 1);
  assert.equal(r.adherence.evaluated, 6);
  assert.equal(r.adherence.verdict, "insufficient_data");
  // manual override survives a re-run
  addManualCheck(a, daily, "2026-10-21", "skipped", NOW, "was at a wedding");
  runJournalChecks(a, daily, NOW + 1000);
  const c21 = listChecks(a, daily)[1]!;
  assert.deepEqual([c21.state, c21.source, c21.note], ["skipped", "manual", "was at a wedding"]);
  const adh = journalAdherence(a, daily);
  assert.deepEqual([adh.followed, adh.slipped, adh.skipped], [5, 0, 1]);
  assert.equal(a.get(`SELECT COUNT(*) c FROM journal_checks WHERE entry_id = ?`, [daily]).c, 6, "no duplicate rows");
  // a corrected ledger re-evaluates auto days
  ins("2026-10-23", 9, 60_000);
  runJournalChecks(a, daily, NOW + 2000);
  assert.equal(listChecks(a, daily)[3]!.state, "slipped");
  // Fuliza rule sees the funding notice
  const fz = createJournalEntry(a, { decisionText: "no fuliza", rule: { kind: "no_fuliza_draw", days: 14 }, startedOn: "2026-10-20" }, NOW);
  runJournalChecks(a, fz, NOW);
  assert.equal(states(listChecks(a, fz)), "20:f 21:f 22:s 23:f 24:f 25:f");
  // manual-only entries have nothing to evaluate
  const manual = createJournalEntry(a, { decisionText: "meditate" }, NOW);
  assert.equal(runJournalChecks(a, manual, NOW).written, 0);
  addManualCheck(a, manual, "2026-10-25", "followed", NOW);
  assert.equal(journalAdherence(a, manual).followed, 1);
  assert.throws(() => runJournalChecks(a, 999, NOW), /no journal entry/);
});

test("store: days beyond the ledger are 'na' unless the caller says capture was running (syncedThroughMs)", () => {
  const { a, ins } = db();
  ins("2026-10-01", 9, 100); ins("2026-10-20", 10, 100);
  const e = createJournalEntry(a, { decisionText: "d", rule: { kind: "daily_spend_max", maxCents: 1_000_000 }, startedOn: "2026-10-20" }, NOW);
  runJournalChecks(a, e, NOW);
  assert.equal(states(listChecks(a, e)), "20:n 21:n 22:n 23:n 24:n 25:n"); // last SMS 10:00 on the 20th: no day is fully covered
  runJournalChecks(a, e, NOW, { syncedThroughMs: at(2026, 10, 26, 6) });
  assert.equal(states(listChecks(a, e)), "20:f 21:f 22:f 23:f 24:f 25:f");
});

test("store: outcome audit end to end, honest with 5 months of sparse data and with enough data", () => {
  const { a, ins } = db();
  // 40 days before (heavy: 1000/day), 20 days after (light: 400/day, small jitter)
  for (let i = 0; i < 40; i++) ins(dayOf(at(2026, 9, 1, 12) + i * D), 9, 100_000 + (i % 2) * 5_000);
  for (let i = 0; i < 20; i++) ins(dayOf(at(2026, 10, 10, 12) + i * D), 9, 40_000 + (i % 2) * 5_000);
  const e = createJournalEntry(a, { decisionText: "spend less", rule: { kind: "daily_spend_max", maxCents: 50_000 }, startedOn: "2026-10-10" }, NOW);
  const audit = auditJournalEntry(a, e, NOW)!;
  assert.equal(audit.verdict, "improved");
  assert.ok(audit.after.n >= 14 && audit.before.n >= 14);
  assert.ok(audit.diff! < 0 && audit.interval!.high < 0);
  // only 5 days since the decision: no claim
  const e2 = createJournalEntry(a, { decisionText: "recent", rule: { kind: "daily_spend_max", maxCents: 50_000 }, startedOn: "2026-10-21" }, NOW);
  const a2 = auditJournalEntry(a, e2, NOW)!;
  assert.deepEqual([a2.verdict, a2.diff, a2.interval], ["insufficient_data", null, null]);
  assert.equal(a2.after.n, 5);
  assert.equal(auditJournalEntry(a, createJournalEntry(a, { decisionText: "manual" }, NOW), NOW), null);
  // empty ledger: still honest
  const empty = db().a;
  const ee = createJournalEntry(empty, { decisionText: "z", rule: { kind: "no_fuliza_draw" } }, NOW);
  assert.equal(auditJournalEntry(empty, ee, NOW)!.verdict, "insufficient_data");
});
