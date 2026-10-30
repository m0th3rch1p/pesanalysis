import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, NOW } from "./fixtures.js";
import {
  capturePausedUntil, getQuietCapturePolicy, isCounterpartySuppressed, listSuppressedCounterparties,
  pauseCaptureUntil, resumeCapture, setQuietCapturePolicy, setTellAutoFiled, suppressCounterparty, tellAutoFiled, unsuppressCounterparty,
} from "../src/capture/controls.js";
import { decidePrompt } from "../src/capture/materiality.js";
import { registerCapture } from "../src/capture/store.js";

const tx = {
  id: 1, amountCents: 30_000, feeCents: 0, direction: "out" as const, occurredAt: NOW, counterpartyKey: "t:1",
  counterpartyPriorCount: 5, labelId: null, labelConfidence: 0, labelSource: "none" as const, businessProb: 0,
  expectedFeeCents: null, details: {},
};

test("suppress, pause and quiet policy persist", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = (db.prepare("SELECT id FROM counterparties LIMIT 1").get() as { id: number }).id;
  assert.equal(isCounterpartySuppressed(a, cp), false);
  const txId = (db.prepare("SELECT t.id FROM transactions t WHERE t.counterparty_id = ? LIMIT 1").get(cp) as { id: number }).id;
  registerCapture(a, { id: txId, amountCents: 30_000, counterpartyKey: "t:1", details: {} }, { action: "prompt_now", tier: "single", score: 5, reasons: [] } as never, NOW);
  assert.equal((db.prepare("SELECT resolved_at FROM capture_prompts WHERE tx_id = ?").get(txId) as { resolved_at: number | null }).resolved_at, null);
  suppressCounterparty(a, cp, NOW);
  assert.equal(isCounterpartySuppressed(a, cp), true);
  assert.notEqual((db.prepare("SELECT resolved_at FROM capture_prompts WHERE tx_id = ?").get(txId) as { resolved_at: number | null }).resolved_at, null);
  assert.equal(listSuppressedCounterparties(a).length, 1);
  unsuppressCounterparty(a, cp);
  assert.equal(isCounterpartySuppressed(a, cp), false);

  assert.equal(capturePausedUntil(a), null);
  pauseCaptureUntil(a, NOW + 86_400_000);
  assert.equal(capturePausedUntil(a), NOW + 86_400_000);
  resumeCapture(a);
  assert.equal(capturePausedUntil(a), null);

  assert.equal(getQuietCapturePolicy(a), "ask_anyway");
  setQuietCapturePolicy(a, "hold");
  assert.equal(getQuietCapturePolicy(a), "hold");
  assert.equal(tellAutoFiled(a), false);
  setTellAutoFiled(a, true);
  assert.equal(tellAutoFiled(a), true);
  db.close();
});

test("quiet hours ask by default, hold only when chosen", () => {
  const late = Date.UTC(2026, 9, 26, 20, 0); // 23:00 EAT
  assert.equal(decidePrompt(tx, [], late).action, "prompt_now");
  assert.equal(decidePrompt(tx, [], late, { quietPolicy: "hold" }).action, "defer");
});
