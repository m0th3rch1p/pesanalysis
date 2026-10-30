import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAmountMultiples, detectTimeOfDay, detectPeriodic, detectFeeDrag, detectDebtCycle, detectScopeMix, detectEpisodes, episodesUnlock, runAllDetectors } from "../src/detectors/index.js";
import { mamaMboga, bodaRider } from "../src/synth/personas.js";
import type { LedgerTx } from "../src/detectors/types.js";

function ledgerOf(persona: ReturnType<typeof mamaMboga>): LedgerTx[] {
  const out: LedgerTx[] = [];
  for (let i = 0; i < persona.messages.length; i++) {
    const m = persona.messages[i]!;
    // crude amount extraction from rendered bodies (test-only; parsers are tested separately)
    const amt = /Ksh([\d,]+(?:\.\d+)?)/.exec(m.body)?.[1] ?? "0";
    const amount = Math.round(parseFloat(amt.replace(/,/g, "")) * 100);
    const dir = m.body.includes("You have received") && !m.body.includes("airtime of") ? "in" : m.body.includes("used to fully pay") || m.body.includes("deducted to repay") ? "out" : "out";
    out.push({
      id: `tx${i}`, occurredAt: m.receivedAt, direction: dir as LedgerTx["direction"], amount,
      counterpartyKey: m.body.includes("GIKOMBA") ? "t:111111" : m.body.includes("SHELL") ? "t:222222" : m.body.includes("Fuliza") ? "n:fuliza" : m.body.includes("sent to") || m.body.includes("received") ? `p:${/07000000\d\d/.exec(m.body)?.[0] ?? "x"}` : null,
      kind: m.kind, fee: 0, label: m.truth.label, scope: m.truth.scope, role: m.truth.role ?? null,
    });
  }
  return out;
}

test("amount_multiples finds the planted 50-base pattern in incoming mama-mboga sales", () => {
  const txs = ledgerOf(mamaMboga()).filter((t) => t.direction === "in" && t.label === "Sales (business)");
  const f = detectAmountMultiples(txs);
  assert.ok(f.length, "expected a finding");
  assert.ok(f.some((x) => x.evidence.base === 50));
});

test("time_of_day finds morning/evening sales peaks", () => {
  const all = ledgerOf(mamaMboga());
  const f = detectTimeOfDay(all).filter((x) => x.id.includes("label:Sales (business)"));
  assert.ok(f.some((x) => (x.evidence as any).window[0] === 6 || (x.evidence as any).window[0] === 16), JSON.stringify(f));
});

test("periodic finds the daily wholesale till and the boda's daily fuel", () => {
  const f1 = detectPeriodic(ledgerOf(mamaMboga()));
  assert.ok(f1.some((x) => (x.evidence as any).counterparty === "t:111111"), JSON.stringify(f1.map((x) => (x.evidence as any).counterparty)));
  const f2 = detectPeriodic(ledgerOf(bodaRider()));
  assert.ok(f2.some((x) => (x.evidence as any).counterparty === "t:222222"), JSON.stringify(f2.map((x) => (x.evidence as any).counterparty)));
  assert.ok([...f1, ...f2].every((x) => !/\bn:/.test(x.title)), f2.map((x) => x.title).join(" | "));
});

test("debt_cycle finds the weekly Fuliza loop in boda_rider", () => {
  const f = detectDebtCycle(ledgerOf(bodaRider()));
  assert.ok(f.some((x) => (x.evidence as any).draws >= 10), JSON.stringify(f));
});

test("scope_mix finds family support crossing the business wallet", () => {
  const f = detectScopeMix(ledgerOf(mamaMboga()), { windowDays: 365 });
  assert.ok(f.length, "expected scope_mix finding");
});

test("episodes clusters spending bursts after 8 weeks of history", () => {
  const now = Date.parse("2026-10-24T09:00:00Z");
  const history: LedgerTx[] = Array.from({ length: 60 }, (_, i) => ({
    id: `h${i}`, occurredAt: now - (60 - i) * 86_400_000, direction: "out" as const, amount: 1_000,
    counterpartyKey: `t:20${i}`, kind: "till" as const, label: "Groceries",
  }));
  const burst: LedgerTx[] = [0, 1, 2, 3].map((i) => ({
    id: `e${i}`, occurredAt: now + i * 10 * 60_000, direction: "out", amount: 50_000,
    counterpartyKey: `t:10000${i}`, kind: "till" as const, label: "Eating out",
  }));
  const f = detectEpisodes([...history, ...burst]);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.n, 4);
  assert.match(f[0]!.title, /Spend episode/);
  assert.equal(episodesUnlock(30).unlocked, false);
});

test("fee_drag emits with fee-bearing txs", () => {
  const now = Date.now();
  const txs: LedgerTx[] = Array.from({ length: 10 }, (_, i) => ({
    id: `f${i}`, occurredAt: now - i * 86_400_000, direction: "out" as const, amount: 100000,
    counterpartyKey: `p:25470000000${i}`, kind: "send" as const, fee: 1500,
  }));
  const f = detectFeeDrag(txs, { days: 30 });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.n, 10);
});

test("silence rule: too-few txs produce no findings", () => {
  const now = Date.now();
  const txs: LedgerTx[] = [{ id: "a", occurredAt: now, direction: "in", amount: 5000, counterpartyKey: "p:254700000001", kind: "receive" }];
  assert.deepEqual(runAllDetectors(txs), []);
});

test("time_of_day title names the group correctly and uses the user's own baseline", () => {
  const base = Date.UTC(2026, 9, 1, 14, 0, 0); // 17:00 EAT
  const txs: LedgerTx[] = [];
  for (let i = 0; i < 60; i++) txs.push({ id: `b${i}`, occurredAt: base - 5 * 3_600_000 + i * 60_000, direction: "out", amount: 10_000, counterpartyKey: null, label: "Groceries" });
  for (let i = 0; i < 24; i++) txs.push({ id: `d${i}`, occurredAt: base + i * 60_000, direction: "out", amount: 10_000, counterpartyKey: null, label: "Dinner" });
  const f = detectTimeOfDay(txs, { minN: 15 });
  assert.ok(f.length >= 1, JSON.stringify(f));
  const dinner = f.find((x) => x.id.includes("Dinner"))!;
  assert.match(dinner.title, /dinner debits/);
  assert.match(dinner.title, /usually/);
  assert.doesNotMatch(dinner.title, /uniform baseline/);
  assert.doesNotMatch(dinner.title, /out debits/);
});

test("debt_cycle repay lag is non-negative even when a repayment precedes a later draw", () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const t = (id: string, day: number, kind: "loan_draw" | "loan_repay", amount: number) => ({
    id, occurredAt: now - (30 - day) * DAY, direction: "in" as const, amount,
    counterpartyKey: "n:fuliza m pesa", counterpartyName: "Fuliza M-PESA", kind,
  });
  const txs = [
    t("d0", 0, "loan_draw", 10_000),
    t("r0", 1, "loan_repay", 10_000),
    t("d1", 5, "loan_draw", 10_000),
    t("r1", 6, "loan_repay", 10_000),
    t("d2", 10, "loan_draw", 10_000),
    t("r2", 11, "loan_repay", 10_000),
  ];
  const f = detectDebtCycle(txs as never, { minLoans: 3, windowDays: 90 });
  assert.equal(f.length, 1);
  assert.match(f[0]!.title, /Fuliza M-PESA/);
  assert.match(f[0]!.title, /repaid in ~1\.0d/);
  assert.ok((f[0]!.evidence as { meanRepayLagDays: number }).meanRepayLagDays >= 0);
});
