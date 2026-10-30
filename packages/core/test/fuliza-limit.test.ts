import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at, NOW } from "./fixtures.js";
import { parseMpesa } from "../src/sms/parsers/mpesa.js";
import { backfillFulizaFromSms, discoverAccount, fulizaState } from "../src/ledger/accounts.js";

const draw = "UJM1B2L Confirmed. Fuliza M-PESA amount is Ksh 500.00. Access Fee charged Ksh 5.00. Total Fuliza M-PESA outstanding amount is Ksh505.00 due on 27/10/26. To check daily charges, Dial *334# Select Query Charges";
const repay = "UJM1B3G Confirmed. Ksh 500.00 from your M-PESA has been used to fully pay your outstanding Fuliza M-PESA. Available Fuliza M-PESA limit is Ksh 1,500.00. Your M-PESA balance is Ksh 200.00.";

test("Fuliza draw and repay parse the stated outstanding and available limit", () => {
  const d = parseMpesa({ sender: "MPESA", body: draw, receivedAt: at(2026, 10, 26) });
  assert.ok(d && d !== "skip");
  assert.equal(d.amount, 50_000);
  assert.equal(d.outstandingCents, 50_500);
  assert.equal(d.kind, "loan_draw");
  assert.ok(d.dueAt);
  const r = parseMpesa({ sender: "MPESA", body: repay, receivedAt: at(2026, 10, 27) });
  assert.ok(r && r !== "skip");
  assert.equal(r.availableCreditCents, 150_000);
  assert.equal(r.kind, "loan_repay");
});

test("credit-line account stores available/outstanding limits and does not book a draw as wallet outflow", () => {
  const db = fixtureDb(); const a = adapter(db);
  const d = parseMpesa({ sender: "MPESA", body: draw, receivedAt: at(2026, 10, 26) }) as import("../src/types.js").ParsedSms;
  const r = parseMpesa({ sender: "MPESA", body: repay, receivedAt: at(2026, 10, 27) }) as import("../src/types.js").ParsedSms;
  discoverAccount(a, { sender: "MPESA", parsed: d, occurredAt: d.occurredAt });
  const afterDraw = fulizaState(a);
  assert.ok(afterDraw);
  assert.equal(afterDraw!.outstandingCents, 50_500);
  const drawWallet = a.get(`SELECT total_out_cents AS v FROM accounts WHERE account_mask = 'MPESA'`) as { v?: number } | undefined;
  assert.ok(!drawWallet || drawWallet.v === 0, "a draw must not be counted as an M-PESA outflow");
  discoverAccount(a, { sender: "MPESA", parsed: r, occurredAt: r.occurredAt });
  const afterRepay = fulizaState(a);
  assert.ok(afterRepay);
  assert.equal(afterRepay!.availableCents, 150_000);
  assert.equal(afterRepay!.draws, 0, "fixture has no transaction rows; counts come from transactions");
  const repayWallet = a.get(`SELECT total_out_cents AS v FROM accounts WHERE account_mask = 'MPESA'`) as { v?: number } | undefined;
  assert.equal(repayWallet?.v, 50_000, "the repayment is a real wallet outflow");
  db.close();
});


test("backfill reads the stated Fuliza limit from stored messages", () => {
  const db = fixtureDb(); const a = adapter(db);
  a.run(`INSERT INTO sms_raw (sender, body, received_at, body_sha256) VALUES ('MPESA', ?, ?, 'h1')`, [draw, at(2026, 10, 26)]);
  a.run(`INSERT INTO sms_raw (sender, body, received_at, body_sha256) VALUES ('MPESA', ?, ?, 'h2')`, [repay, at(2026, 10, 27)]);
  const r = backfillFulizaFromSms(a, NOW);
  assert.equal(r.updated, 2);
  const st = fulizaState(a);
  assert.ok(st);
  assert.equal(st!.availableCents, 150_000);
  db.close();
});

test("a mixed Fuliza snapshot is normalised so limit = available + outstanding", () => {
  const db = fixtureDb(); const a = adapter(db);
  const d = parseMpesa({ sender: "MPESA", body: draw, receivedAt: at(2026, 10, 26) }) as import("../src/types.js").ParsedSms;
  discoverAccount(a, { sender: "MPESA", parsed: d, occurredAt: d.occurredAt });
  // The failure seen on the device: three fields from different messages (limit 205.67, available 0.67, owed 301.38).
  a.run(`UPDATE accounts SET credit_limit_cents = 20567, available_credit_cents = 67, outstanding_cents = 30138, due_at = ?, updated_at = ? WHERE kind = 'credit'`, [at(2026, 9, 24), at(2026, 9, 24)]);
  const st = fulizaState(a)!;
  assert.equal(st.availableCents, 67);
  assert.equal(st.outstandingCents, 30138);
  assert.equal(st.limitCents, 30205, "limit must cover available + outstanding");
  assert.ok(st.stale, "an old credit-line snapshot is marked stale");
  db.close();
});

test("a full repayment clears outstanding and the due date", () => {
  const db = fixtureDb(); const a = adapter(db);
  const d = parseMpesa({ sender: "MPESA", body: draw, receivedAt: at(2026, 10, 26) }) as import("../src/types.js").ParsedSms;
  const r = parseMpesa({ sender: "MPESA", body: repay, receivedAt: at(2026, 10, 27) }) as import("../src/types.js").ParsedSms;
  discoverAccount(a, { sender: "MPESA", parsed: d, occurredAt: d.occurredAt });
  discoverAccount(a, { sender: "MPESA", parsed: r, occurredAt: r.occurredAt });
  const st = fulizaState(a)!;
  assert.equal(st.outstandingCents, 0);
  assert.equal(st.dueAt, null);
  assert.equal(st.limitCents, 150_000);
  db.close();
});

test("the float sweep uses the same normalised Fuliza outstanding as the Home card", async () => {
  const { floatSnapshot } = await import("../src/expect/store.js");
  const db = fixtureDb(); const a = adapter(db);
  const inMsg = parseMpesa({ sender: "MPESA", body: "UJM1B4H Confirmed. You have received Ksh 100.00 from JANE DOE 0700000001 on 26/10/26 at 10:00 AM. New M-PESA balance is Ksh1,000.00.", receivedAt: at(2026, 10, 28) }) as import("../src/types.js").ParsedSms;
  discoverAccount(a, { sender: "MPESA", parsed: inMsg, occurredAt: inMsg.occurredAt });
  const d = parseMpesa({ sender: "MPESA", body: draw, receivedAt: at(2026, 10, 26) }) as import("../src/types.js").ParsedSms;
  discoverAccount(a, { sender: "MPESA", parsed: d, occurredAt: d.occurredAt });
  a.run(`UPDATE accounts SET credit_limit_cents = 20567, available_credit_cents = 67, outstanding_cents = 30138, updated_at = ? WHERE kind = 'credit'`, [NOW]);
  const st = fulizaState(a)!;
  assert.equal(floatSnapshot(a, NOW).sweep?.outstandingCents, st.outstandingCents);
  assert.equal(floatSnapshot(a, NOW).sweep?.outstandingCents, 30138);
  db.close();
});
