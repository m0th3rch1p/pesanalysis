import test from "node:test";
import assert from "node:assert/strict";
import { auditBalanceChain } from "../src/ledger/balance-chain.js";
import type { ParsedSms } from "../src/types.js";

const T0 = Date.UTC(2026, 9, 26, 6, 0, 0); // 09:00 EAT, minute-aligned like body timestamps
const K = (kes: number) => Math.round(kes * 100);

function m(o: Partial<ParsedSms> & Pick<ParsedSms, "kind" | "amount">): ParsedSms {
  return {
    provider: "mpesa", ref: null, direction: "out", fee: null, balanceAfter: null, counterpartyName: null,
    counterpartyId: null, account: null, occurredAt: T0, template: "t", parserVersion: "t", ...o,
  };
}
const recv = (ref: string, kes: number, bal: number, at: number) =>
  m({ ref, kind: "receive", direction: "in", amount: K(kes), balanceAfter: K(bal), occurredAt: at });
const till = (ref: string, kes: number, bal: number, at: number) =>
  m({ ref, kind: "till", amount: K(kes), fee: 0, balanceAfter: K(bal), occurredAt: at });
const draw = (ref: string, kes: number, at: number) =>
  m({ ref, kind: "loan_draw", direction: "neutral", amount: K(kes), occurredAt: at });

const statuses = (r: ReturnType<typeof auditBalanceChain>) => r.map((x) => x.status);

test("correct order: payment funded by a draw that precedes it reconciles", () => {
  const r = auditBalanceChain([recv("A1", 200, 200, T0), draw("D1", 500, T0 + 60_000), till("P1", 700, 0, T0 + 60_000)]);
  assert.deepEqual(statuses(r), ["first", "unknown", "ok"]);
});

test("B4: draw stamped seconds AFTER the payment it funds no longer causes false breaks", () => {
  const seq = [
    recv("A1", 200, 200, T0),
    till("P1", 700, 0, T0 + 60_000),          // minute-stamped from the body
    draw("D1", 500, T0 + 60_000 + 25_000),    // receive-time stamp, after the payment
    recv("A2", 100, 100, T0 + 3_600_000),
  ];
  const before = auditBalanceChain(seq, { drawReorderWindowMs: 0 });
  assert.equal(before.filter((x) => x.status === "break").length, 2, "baseline shows the false breaks");
  const r = auditBalanceChain(seq);
  assert.deepEqual(statuses(r), ["first", "ok", "unknown", "ok"]);
  assert.equal(r[2]!.reordered, true);
  assert.deepEqual(r.map((x) => x.index), [0, 1, 2, 3], "results stay in input order");
  assert.deepEqual(r.map((x) => x.ref), ["A1", "P1", "D1", "A2"]);
});

test("same-ref draw/payment pair arriving swapped reconciles", () => {
  const r = auditBalanceChain([
    recv("A1", 50, 50, T0),
    m({ ref: "X9", kind: "paybill", amount: K(300), fee: 0, balanceAfter: K(0), occurredAt: T0 + 120_000 }),
    draw("X9", 250, T0 + 124_000),
  ]);
  assert.deepEqual(statuses(r), ["first", "ok", "unknown"]);
});

test("a real break is NOT hidden: a missing message still breaks after reordering", () => {
  // KES 100 send is missing from the feed
  const seq = [
    recv("A1", 200, 200, T0),
    till("P1", 700, 0, T0 + 60_000),
    draw("D1", 500, T0 + 70_000),
    recv("A2", 300, 200, T0 + 3_600_000),   // true chain: 0 + 300 - 100(missing) = 200
  ];
  const r = auditBalanceChain(seq);
  assert.deepEqual(statuses(r), ["first", "ok", "unknown", "break"]);
  assert.equal(r[3]!.discrepancy, K(100));
});

test("a real break co-occurring with a misordered draw: draw is fixed, the genuine break remains", () => {
  const seq = [
    recv("A1", 200, 200, T0),
    till("P1", 700, 40, T0 + 60_000),    // true balance should be 0; 40 means a 40 inflow went unreported
    draw("D1", 500, T0 + 80_000),
  ];
  const r = auditBalanceChain(seq);
  assert.equal(r.filter((x) => x.status === "break").length, 1);
  assert.equal(r[1]!.status, "break");
  assert.equal(r[1]!.discrepancy, -K(40));
});

test("missing draw SMS: the payment break is preserved", () => {
  const r = auditBalanceChain([recv("A1", 200, 200, T0), till("P1", 700, 0, T0 + 60_000), recv("A2", 100, 100, T0 + 3_600_000)]);
  assert.equal(r[1]!.status, "break");
  assert.equal(r[1]!.discrepancy, -K(500));
});

test("draw far outside the window is not pulled across unrelated messages", () => {
  const seq = [
    recv("A1", 200, 200, T0),
    till("P1", 700, 0, T0 + 60_000),
    draw("D1", 500, T0 + 60_000 + 3_600_000),
  ];
  const r = auditBalanceChain(seq);
  assert.equal(r[1]!.status, "break");
  assert.ok(!r[2]!.reordered);
});

test("a stray residual stays a break: reordering shrinks the discrepancy but never clears it", () => {
  // KES 5 unexplained in the stated balance; the draw still explains the other KES 500
  const seq = [recv("A1", 200, 200, T0), till("P1", 700, 5, T0 + 60_000), draw("D1", 500, T0 + 61_000)];
  const r = auditBalanceChain(seq);
  assert.equal(r[1]!.status, "break");
  assert.equal(r[1]!.discrepancy, -K(5));
  const off = auditBalanceChain(seq, { drawReorderWindowMs: 0 });
  assert.equal(off[1]!.discrepancy, -K(505));
});

test("two draws funding two payments, both misordered", () => {
  const seq = [
    recv("A1", 100, 100, T0),
    till("P1", 400, 0, T0 + 60_000),
    draw("D1", 300, T0 + 75_000),
    till("P2", 250, 0, T0 + 600_000),
    draw("D2", 250, T0 + 615_000),
    recv("A2", 10, 10, T0 + 4_000_000),
  ];
  const r = auditBalanceChain(seq);
  assert.equal(r.filter((x) => x.status === "break").length, 0, JSON.stringify(statuses(r)));
  assert.equal(r.filter((x) => x.reordered).length, 2);
});

test("clean chains are untouched (no reordering when nothing is broken)", () => {
  const r = auditBalanceChain([recv("A1", 100, 100, T0), till("P1", 40, 60, T0 + 1000), recv("A2", 10, 70, T0 + 2000)]);
  assert.deepEqual(statuses(r), ["first", "ok", "ok"]);
  assert.ok(!r.some((x) => x.reordered));
});
