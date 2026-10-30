import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSms, auditBalanceChain, detectAmountMultiples, type LedgerTx, type ParsedSms } from "../src/index.ts";
import { bodaRider, mamaMboga, salariedTrip } from "../src/synth/personas.ts";

function parseAll(c: ReturnType<typeof mamaMboga>) {
  const parsed: ParsedSms[] = [];
  for (const m of c.messages) { const o = parseSms(m); assert.ok(o.ok, `unparsed synthetic: ${m.body}`); if (o.ok) parsed.push(o.parsed); }
  return parsed;
}

test("synthetic corpora are deterministic", () => {
  assert.deepEqual(mamaMboga(7).messages.map((m) => m.body), mamaMboga(7).messages.map((m) => m.body));
});
test("every synthetic message round-trips through the parser (consistency check only; NOT real-world coverage)", () => {
  assert.ok(parseAll(mamaMboga()).length > 500);
  assert.ok(parseAll(salariedTrip()).length > 50);
});
test("balance chain: exactly the planted break is detected on mama_mboga", () => {
  const res = auditBalanceChain(parseAll(mamaMboga()));
  const breaks = res.filter((r) => r.status === "break");
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.discrepancy, 30000);
});
test("balance chain: salaried_trip has no breaks", () => {
  assert.equal(auditBalanceChain(parseAll(salariedTrip())).filter((r) => r.status === "break").length, 0);
});
test("detector recovers planted KES-50 price points on incoming amounts", () => {
  const parsed = parseAll(mamaMboga());
  const txs: LedgerTx[] = parsed.map((p, i) => ({ id: String(i), occurredAt: p.occurredAt, direction: p.direction, amount: p.amount, counterpartyKey: p.counterpartyId ?? p.counterpartyName }));
  const f = detectAmountMultiples(txs).find((x) => x.id === "amount_multiples:dir:in:50");
  assert.ok(f, "expected the planted base-50 finding on incoming amounts");
  assert.ok(f.pValue! < 1e-4);
});
test("detector emits nothing for the salaried persona's incoming (n too small => 'we don't know')", () => {
  const parsed = parseAll(salariedTrip());
  const txs: LedgerTx[] = parsed.map((p, i) => ({ id: String(i), occurredAt: p.occurredAt, direction: p.direction, amount: p.amount, counterpartyKey: p.counterpartyId ?? p.counterpartyName }));
  assert.equal(detectAmountMultiples(txs).filter((x) => x.id.includes(":dir:in:")).length, 0);
});

test("synthetic corpora accept an explicit recent start", () => {
  const start = Date.UTC(2026, 3, 1) - 3 * 3_600_000;
  const c = bodaRider(3, 10, start);
  assert.ok(c.messages.length > 0);
  assert.ok(Math.min(...c.messages.map((m) => m.receivedAt)) >= start);
  assert.ok(Math.max(...c.messages.map((m) => m.receivedAt)) < start + 11 * 86_400_000);
});
