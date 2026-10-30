import { test } from "node:test";
import assert from "node:assert/strict";
import { profile } from "../src/evolution/profiler.js";
import { rollup, mergeCandidates, type RollupTx } from "../src/sessions/rollups.js";
import { narrateFinding, narrateDaily, protectTerms, glossary } from "../src/narration/templates.js";
import type { ParsedSms, Finding } from "../src/index.js";

const mk = (over: Partial<ParsedSms>): ParsedSms => ({
  provider: "mpesa", ref: "TJ12ABC3XY", kind: "till", direction: "out", amount: 35000, fee: 0,
  balanceAfter: 100000, counterpartyName: "SHELL KIAMBU ROAD", counterpartyId: null, account: null,
  occurredAt: 1, template: "mpesa.till", parserVersion: "t", ...over,
});

test("profiler: mines a high-precision keyword rule and gates it", () => {
  // "NAKURU WATER" has NO seed rule (r_water matches "nairobi water"/"water bill" only) -> minable
  const history = [
    ...Array.from({ length: 40 }, (_, i) => ({ parsed: mk({ counterpartyName: "NAKURU WATER & SEWERAGE", kind: "paybill", template: "mpesa.paybill.sent", ref: `R${i}000000001` }), label: "Utilities", cpKey: "t:1" })),
    ...Array.from({ length: 40 }, (_, i) => ({ parsed: mk({ counterpartyName: "NAIVAS KILIMANI", kind: "till", template: "mpesa.till", ref: `R${i + 50}00000001` }), label: "Groceries", cpKey: "t:2" })),
    ...Array.from({ length: 20 }, (_, i) => ({ parsed: mk({ counterpartyName: "QUICKMART YAYA", kind: "till", template: "mpesa.till", ref: `R${i + 90}0000001` }), label: "Groceries", cpKey: "t:3" })),
  ];
  const r = profile(history, { gateMinN: 10 });
  assert.ok(r.minableLabels.includes("Utilities"));
  const applied = r.proposals.filter((p) => r.verdicts.get(p.id)?.verdict === "apply");
  assert.ok(applied.length, JSON.stringify([...r.verdicts]));
  const nakuru = applied.find((p) => p.patch.ruleId === "m_nakuru");
  assert.ok(nakuru, JSON.stringify(r.proposals.map((p) => p.patch.ruleId)));
  assert.equal((nakuru!.patch as any).label, "Utilities");
});

test("profiler: abstains when history is tiny", () => {
  const r = profile([{ parsed: mk({}), label: "Fuel", cpKey: "t:1" }], { gateMinN: 30 });
  const v = [...r.verdicts.values()];
  assert.ok(r.proposals.length === 0 || v.every((x) => x.verdict === "abstain"));
});

test("rollup: daily buckets sum in/out/fees and flag chain breaks", () => {
  const day = Date.parse("2026-10-24T00:00:00Z");
  const txs: RollupTx[] = [
    { occurredAt: day + 3600_000, direction: "in", amount: 50000, fee: 0, kind: "receive", label: "Sales", cpKey: "p:1", chainStatus: "ok" },
    { occurredAt: day + 7200_000, direction: "out", amount: 20000, fee: 500, kind: "send", label: "Family support", cpKey: "p:2", chainStatus: "break" },
    { occurredAt: day + 10800_000, direction: "out", amount: 10000, fee: 0, kind: "loan_repay", label: "Debt repayment", cpKey: "n:fuliza", chainStatus: "ok" },
  ];
  const b = rollup(txs, "daily");
  assert.equal(b.length, 1);
  assert.equal(b[0]!.inCents, 50000);
  assert.equal(b[0]!.outCents, 30500);
  assert.equal(b[0]!.feesCents, 500);
  assert.equal(b[0]!.loanRepayCents, 10000);
  assert.equal(b[0]!.chainBreaks, 1);
  assert.ok(b[0]!.byLabel.some((l) => l.label === "Sales"));
});

test("rollup: monthly bucketing merges days", () => {
  const txs: RollupTx[] = [
    { occurredAt: Date.parse("2026-10-01T10:00:00Z"), direction: "in", amount: 1000, fee: 0, kind: "receive" },
    { occurredAt: Date.parse("2026-10-30T10:00:00Z"), direction: "out", amount: 500, fee: 0, kind: "till" },
    { occurredAt: Date.parse("2026-11-01T10:00:00Z"), direction: "out", amount: 700, fee: 0, kind: "till" },
  ];
  const b = rollup(txs, "monthly");
  assert.equal(b.length, 2);
  const oct = b.find((x) => x.label === "Oct 2026")!;
  assert.ok(oct);
  assert.equal(oct.inCents, 1000);
});

test("merge candidates: one key, several spellings", () => {
  const c = mergeCandidates([
    { occurredAt: 1, direction: "in", amount: 1000, cpKey: "p:254712345678", cpId: "0712345678", cpName: "JANE DOE" },
    { occurredAt: 2, direction: "in", amount: 1000, cpKey: "p:254712345678", cpId: "0712345678", cpName: "JANE D OE" },
  ]);
  assert.equal(c.length, 1);
  assert.match(c[0]!.reason, /2 spellings/);
});

test("narration: deterministic text + term protection", () => {
  const f: Finding = { detector: "time_of_day", id: "x", title: "peak", n: 100, pValue: 0.001, evidence: { window: [6, 9] } };
  assert.match(narrateFinding(f), /06:00 and 09:00/);
  assert.equal(glossary("restock"), "kujaza bidhaa");
  const p = protectTerms("Send money to the till, then check your balance and pay fees.");
  assert.ok(!/till|balance|fees/.test(p.text), p.text);
  assert.equal(p.restore(p.text), "Send money to the till, then check your balance and pay fees.");
});

test("narration: daily summary renders numbers from data", () => {
  const s = narrateDaily({ date: "24/10/26", inCents: 120000, outCents: 45000, feesCents: 1500, topLabels: [{ label: "Sales", cents: 120000 }] });
  assert.match(s, /1,200\.00/);
  assert.match(s, /Sales/);
});
