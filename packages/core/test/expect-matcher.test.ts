import test from "node:test";
import assert from "node:assert/strict";
import { matchFlow, delayStats, robustMedian, madScaled, hintMatches, type MatchFlowSpec, type MatchTx, type OccState } from "../src/expect/matcher.js";
import { at } from "./fixtures.js";

const salary: MatchFlowSpec = { direction: "in", hint: "acme", minCents: 4_800_000, typCents: 5_000_000, maxCents: 5_200_000, graceDays: 1, missedAfterDays: 7, earlyDays: 3 };
const rent: MatchFlowSpec = { direction: "out", hint: "landlord", minCents: 3_000_000, typCents: 3_000_000, maxCents: 3_000_000, graceDays: 2, missedAfterDays: 10, earlyDays: 5 };
let nid = 1;
const tx = (dir: "in" | "out", cents: number, y: number, m: number, d: number, text = "ACME LTD SALARY", h = 10): MatchTx =>
  ({ id: nid++, direction: dir, amountCents: cents, occurredAt: at(y, m, d, h), text });
const one = (spec: MatchFlowSpec, due: string, txs: MatchTx[], now: number, extra: { pinned?: number[]; rejected?: number[]; waived?: boolean } = {}) =>
  matchFlow(spec, [{ id: 1, dueOn: due, ...extra }], txs, now)[0]!;

test("hint matching is tokenised, case/punctuation-insensitive", () => {
  assert.ok(hintMatches("acme ltd", "ACME-LTD  Payroll"));
  assert.ok(hintMatches("", "anything"));
  assert.ok(!hintMatches("acme", "ACNE LTD"));
  assert.ok(hintMatches("fuliza", "mpesa.fuliza_repay"));
});

test("salary: on time, early, and amount delta against typical", () => {
  const due = "2026-10-28";
  const on = one(salary, due, [tx("in", 5_000_000, 2026, 10, 28)], at(2026, 10, 28, 12));
  assert.equal(on.state, "matched"); assert.equal(on.delayDays, 0); assert.equal(on.amountDeltaCents, 0);
  const early = one(salary, due, [tx("in", 5_100_000, 2026, 10, 26)], at(2026, 10, 28, 12));
  assert.equal(early.state, "matched"); assert.equal(early.delayDays, -2); assert.equal(early.amountDeltaCents, 100_000);
});

test("no receipt: upcoming -> late -> missed purely by time (monotone)", () => {
  const due = "2026-10-28";
  const st = (d: number, m = 10) => one(salary, due, [], at(2026, m, d, 12)).state;
  assert.equal(st(27), "upcoming");
  assert.equal(st(28), "upcoming");
  assert.equal(st(29), "upcoming");   // grace 1
  assert.equal(st(30), "late");
  assert.equal(st(4, 11), "late");     // due+7
  assert.equal(st(5, 11), "missed");
  const order: OccState[] = ["upcoming", "late", "missed"];
  let last = 0;
  for (let k = 0; k < 40; k++) {
    const idx = order.indexOf(one(salary, due, [], at(2026, 10, 20, 12) + k * 86_400_000).state);
    assert.ok(idx >= last); last = idx;
  }
});

test("late arrival after 'missed' re-opens to matched with the real delay", () => {
  const r = one(salary, "2026-10-28", [tx("in", 5_000_000, 2026, 11, 6)], at(2026, 11, 7, 9));
  assert.equal(r.state, "matched"); assert.equal(r.delayDays, 9);
  // far outside the recovery window: stays missed
  const far = one(salary, "2026-10-28", [tx("in", 5_000_000, 2026, 12, 20)], at(2026, 12, 21, 9));
  assert.equal(far.state, "missed"); assert.equal(far.receivedCents, 0);
});

test("income partial then completion accumulates; delay is the completing day", () => {
  const a = tx("in", 2_000_000, 2026, 10, 28); const b = tx("in", 3_000_000, 2026, 10, 31);
  const p = one(salary, "2026-10-28", [a], at(2026, 11, 1, 9));
  assert.equal(p.state, "partial"); assert.equal(p.receivedCents, 2_000_000); assert.equal(p.delayDays, 0);
  const m = one(salary, "2026-10-28", [a, b], at(2026, 11, 1, 9));
  assert.equal(m.state, "matched"); assert.equal(m.delayDays, 3); assert.deepEqual(m.matchedTxIds, [a.id, b.id]);
});

test("ineligible transactions are ignored: direction, hint, out-of-range without hint, out of window", () => {
  const now = at(2026, 10, 29, 9);
  assert.equal(one(salary, "2026-10-28", [tx("out", 5_000_000, 2026, 10, 28)], now).receivedCents, 0);
  assert.equal(one(salary, "2026-10-28", [tx("in", 5_000_000, 2026, 10, 28, "OTHER CO")], now).receivedCents, 0);
  assert.equal(one(salary, "2026-10-28", [tx("in", 5_000_000, 2026, 9, 1)], now).receivedCents, 0);
  const noHint = { ...salary, hint: null };
  assert.equal(one(noHint, "2026-10-28", [tx("in", 5_000_000, 2026, 10, 28, "anyone")], now).state, "matched");
  assert.equal(one(noHint, "2026-10-28", [tx("in", 900_000, 2026, 10, 28, "anyone")], now).receivedCents, 0);
  assert.equal(one({ ...noHint, minCents: null, typCents: null, maxCents: null }, "2026-10-28", [tx("in", 900_000, 2026, 10, 28, "x")], now).receivedCents, 0);
  assert.equal(one(salary, "2026-10-28", [{ ...tx("in", 0, 2026, 10, 28), amountCents: 0 }], now).receivedCents, 0);
});

test("amount tolerance at the range edges", () => {
  const noHint = { ...salary, hint: null };
  const now = at(2026, 10, 29, 9);
  assert.equal(one(noHint, "2026-10-28", [tx("in", Math.round(5_200_000 * 1.02), 2026, 10, 28, "z")], now).state, "matched");
  assert.equal(one(noHint, "2026-10-28", [tx("in", Math.round(5_200_000 * 1.02) + 1, 2026, 10, 28, "z")], now).receivedCents, 0);
});

test("obligations accept several partial payments; overpayment beyond range is not auto-matched", () => {
  const now = at(2026, 11, 3, 9);
  const p1 = tx("out", 1_000_000, 2026, 11, 1, "LANDLORD PAYBILL"); const p2 = tx("out", 1_500_000, 2026, 11, 2, "Landlord"); const p3 = tx("out", 500_000, 2026, 11, 3, "landlord");
  assert.equal(one(rent, "2026-11-01", [p1], now).state, "partial");
  assert.equal(one(rent, "2026-11-01", [p1, p2], now).state, "partial");
  const full = one(rent, "2026-11-01", [p1, p2, p3], now);
  assert.equal(full.state, "matched"); assert.equal(full.receivedCents, 3_000_000);
  assert.equal(one(rent, "2026-11-01", [tx("out", 9_000_000, 2026, 11, 1, "landlord")], now).receivedCents, 0);
});

test("obligation without any amount: one hinted payment completes it", () => {
  const spec = { ...rent, minCents: null, typCents: null, maxCents: null };
  assert.equal(one(spec, "2026-11-01", [tx("out", 123, 2026, 11, 1, "landlord")], at(2026, 11, 2, 9)).state, "matched");
});

test("one-to-one: two weekly occurrences, transactions go to the nearest due date", () => {
  const spec: MatchFlowSpec = { direction: "in", hint: "mama", minCents: 100_000, typCents: 100_000, maxCents: 100_000, graceDays: 1, missedAfterDays: 3, earlyDays: 2 };
  const t1 = tx("in", 100_000, 2026, 10, 12, "MAMA"); // closest to the 12th
  const occs = [{ id: 1, dueOn: "2026-10-12" }, { id: 2, dueOn: "2026-10-19" }];
  const r1 = matchFlow(spec, occs, [t1], at(2026, 10, 22, 9));
  assert.deepEqual(r1.map((r) => r.matchedTxIds), [[t1.id], []]);
  assert.equal(r1[1]!.state, "late");
  const t2 = tx("in", 100_000, 2026, 10, 19, "MAMA");
  const r2 = matchFlow(spec, occs, [t2, t1], at(2026, 10, 22, 9));
  assert.deepEqual(r2.map((r) => r.matchedTxIds), [[t1.id], [t2.id]]);
  // a single transaction is never double-counted
  const r3 = matchFlow(spec, occs, [t2], at(2026, 10, 22, 9));
  assert.equal(r3.reduce((a, r) => a + r.matchedTxIds.length, 0), 1);
  assert.deepEqual(r3.map((r) => r.matchedTxIds), [[], [t2.id]]);
});

test("claimed transactions are not offered; overrides: pinned always wins, rejected never matches, waived is sticky", () => {
  const t = tx("in", 5_000_000, 2026, 10, 28);
  const now = at(2026, 10, 29, 9);
  assert.equal(matchFlow(salary, [{ id: 1, dueOn: "2026-10-28" }], [t], now, { usedTxIds: new Set([t.id]) })[0]!.receivedCents, 0);
  assert.equal(one(salary, "2026-10-28", [t], now, { rejected: [t.id] }).receivedCents, 0);
  const odd = tx("in", 123, 2026, 6, 1, "somebody else");
  const pinned = one(salary, "2026-10-28", [odd], now, { pinned: [odd.id] });
  assert.equal(pinned.matchedTxIds[0], odd.id);
  const w = one(salary, "2026-10-28", [t], now, { waived: true });
  assert.equal(w.state, "waived"); assert.deepEqual(w.matchedTxIds, []);
  // pinned transaction is excluded from automatic assignment elsewhere
  const rs = matchFlow(salary, [{ id: 1, dueOn: "2026-10-28", pinned: [t.id] }, { id: 2, dueOn: "2026-11-27" }], [t], at(2026, 11, 28, 9));
  assert.deepEqual(rs.map((r) => r.matchedTxIds.length), [1, 0]);
});

test("deterministic regardless of input order (property)", () => {
  const txs = [tx("in", 5_000_000, 2026, 10, 27), tx("in", 5_050_000, 2026, 10, 29), tx("in", 5_000_000, 2026, 11, 27), tx("in", 1_000_000, 2026, 11, 1)];
  const occs = [{ id: 1, dueOn: "2026-10-28" }, { id: 2, dueOn: "2026-11-27" }];
  const base = matchFlow(salary, occs, txs, at(2026, 11, 30, 9));
  for (let s = 0; s < 12; s++) {
    const rev = s % 2 ? [...txs].reverse() : txs;
    const rot = txs.map((_, i) => txs[(i + s) % txs.length]!);
    assert.deepEqual(matchFlow(salary, occs, rot, at(2026, 11, 30, 9)), base);
    assert.deepEqual(matchFlow(salary, [...occs].reverse(), rev, at(2026, 11, 30, 9)).sort((a, b) => a.id - b.id), base);
  }
});

test("state invariants hold over random scenarios (property)", () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let n = 0; n < 200; n++) {
    const txs: MatchTx[] = [];
    for (let k = 0; k < Math.floor(rnd() * 5); k++) txs.push(tx(rnd() < 0.8 ? "in" : "out", Math.floor(rnd() * 6_000_000) + 1, 2026, 10, 20 + Math.floor(rnd() * 12), rnd() < 0.7 ? "acme" : "zzz"));
    const now = at(2026, 10, 25, 9) + Math.floor(rnd() * 20) * 86_400_000;
    const r = one(salary, "2026-10-28", txs, now);
    assert.ok(["upcoming", "late", "missed", "matched", "partial"].includes(r.state));
    if (r.state === "matched") assert.ok(r.receivedCents >= 4_800_000 * 0.98 && r.delayDays != null && r.resolvedAt != null);
    if (r.state === "partial") assert.ok(r.receivedCents > 0 && r.receivedCents < 4_800_000 * 0.98);
    if (r.matchedTxIds.length === 0) assert.ok(["upcoming", "late", "missed"].includes(r.state) && r.receivedCents === 0 && r.delayDays === null);
    assert.equal(new Set(r.matchedTxIds).size, r.matchedTxIds.length);
  }
});

test("robust median / MAD resist outliers", () => {
  assert.equal(robustMedian([]), null);
  assert.equal(robustMedian([3, 1, 2]), 2);
  assert.equal(robustMedian([1, 2, 3, 4]), 2.5);
  assert.equal(robustMedian([0, 0, 0, 1, 100]), 0);
  assert.equal(madScaled([0, 0, 0, 1, 100]), 0);
  assert.ok(Math.abs((madScaled([1, 2, 3, 4, 5]) ?? 0) - 1.4826) < 1e-9);
  assert.equal(madScaled([]), null);
});

test("delay statistics: counts, medians, rates, reliability; upcoming/waived excluded", () => {
  const row = (state: OccState, delayDays: number | null, received = 0, expected: number | null = 100) => ({ state, delayDays, receivedCents: received, expectedCents: expected });
  const s = delayStats([
    row("matched", 0, 100), row("matched", 0, 100), row("matched", 2, 100), row("matched", 5, 100), row("matched", -1, 100),
    row("partial", 3, 40), row("missed", null), row("late", null), row("waived", null), row("upcoming", null),
  ]);
  assert.equal(s.decided, 8);
  assert.deepEqual(s.counts, { upcoming: 1, matched: 5, late: 1, partial: 1, missed: 1, waived: 1 });
  assert.equal(s.medianDelayDays, 1);                    // [-1,0,0,2,3,5]
  assert.equal(s.onTimeRate, 3 / 8);
  assert.equal(s.withinGraceRate, 3 / 8);
  assert.ok(Math.abs((s.reliability ?? 0) - 540 / 800) < 1e-12);
  assert.equal(s.arrivalRate, 6 / 8);
  const e = delayStats([]);
  assert.equal(e.decided, 0); assert.equal(e.medianDelayDays, null); assert.equal(e.onTimeRate, null); assert.equal(e.reliability, null);
  assert.equal(delayStats([row("matched", 1, 5, null)]).reliability, null);
});
