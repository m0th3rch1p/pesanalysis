import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSms } from "../src/index.ts";

const ts = Date.UTC(2026, 9, 25, 12, 0, 0);
const p = (sender: string, body: string) => parseSms({ sender, body, receivedAt: ts });

test("phone-number senders are skipped (P2P chat is never ingested)", () => {
  const o = p("+254700000001", "hey");
  assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "phone_number_sender");
});
test("non-financial alphanumeric sender is skipped", () => {
  const o = p("Facebook", "Your code is 123456"); assert.equal(o.ok, false);
});
test("mpesa send", () => {
  const o = p("MPESA", "TJ12ABC3XY Confirmed. Ksh500.00 sent to JOHN DOE 0700000001 on 25/10/26 at 2:30 PM. New M-PESA balance is Ksh1,234.00. Transaction cost, Ksh7.00. Amount you can transact within the day is 499,500.00.");
  assert.ok(o.ok); if (!o.ok) return;
  assert.equal(o.parsed.kind, "send"); assert.equal(o.parsed.amount, 50000); assert.equal(o.parsed.fee, 700);
  assert.equal(o.parsed.balanceAfter, 123400); assert.equal(o.parsed.counterpartyName, "JOHN DOE"); assert.equal(o.parsed.counterpartyId, "0700000001");
  assert.equal(o.parsed.ref, "TJ12ABC3XY");
  assert.equal(new Date(o.parsed.occurredAt).toISOString(), "2026-10-25T11:30:00.000Z"); // 14:30 EAT
});
test("mpesa receive (irregular spacing)", () => {
  const o = p("MPESA", "TJ12ABC3XZ Confirmed.You have received Ksh1,500.00 from JANE WANJIKU 0700000002 on 25/10/26 at 9:05 AM  New M-PESA balance is Ksh2,734.00.  Earn interest daily on Ziidi.");
  assert.ok(o.ok); if (!o.ok) return;
  assert.equal(o.parsed.kind, "receive"); assert.equal(o.parsed.direction, "in"); assert.equal(o.parsed.amount, 150000);
});
test("mpesa paybill keeps account", () => {
  const o = p("MPESA", "TJ12ABC3XA Confirmed. Ksh1,200.00 sent to KPLC PREPAID for account 123456 on 25/10/26 at 2:30 PM New M-PESA balance is Ksh100.00. Transaction cost, Ksh0.00.");
  assert.ok(o.ok); if (!o.ok) return;
  assert.equal(o.parsed.kind, "paybill"); assert.equal(o.parsed.account, "123456"); assert.equal(o.parsed.counterpartyName, "KPLC PREPAID");
});
test("mpesa till", () => {
  const o = p("MPESA", "TJ12ABC3XB Confirmed. Ksh350.00 paid to JAVA HOUSE. on 25/10/26 at 1:10 PM.New M-PESA balance is Ksh900.00. Transaction cost, Ksh0.00.");
  assert.ok(o.ok); if (!o.ok) return; assert.equal(o.parsed.kind, "till"); assert.equal(o.parsed.counterpartyName, "JAVA HOUSE");
});
test("mpesa withdraw + airtime", () => {
  const w = p("MPESA", "TJ12ABC3XC Confirmed.on 25/10/26 at 2:30 PM Withdraw Ksh2,000.00 from 123456 - NYAMBURA AGENCIES New M-PESA balance is Ksh500.00. Transaction cost, Ksh28.00.");
  assert.ok(w.ok); if (w.ok) { assert.equal(w.parsed.kind, "withdraw"); assert.equal(w.parsed.amount, 200000); assert.equal(w.parsed.fee, 2800); }
  const a = p("MPESA", "TJ12ABC3XD confirmed. You bought Ksh50.00 of airtime on 25/10/26 at 2:30 PM.New M-PESA balance is Ksh450.00.");
  assert.ok(a.ok); if (a.ok) assert.equal(a.parsed.kind, "airtime");
});
test("unknown mpesa template yields a fingerprint, not a crash", () => {
  const o = p("MPESA", "TJ12ABC3XE Confirmed. Something brand new for NAIROBI 123");
  assert.equal(o.ok, false); if (!o.ok) { assert.equal(o.reason, "no_template_match"); assert.ok(o.fingerprint); }
});

test("mpesa paybill: 'KshX paid to NAME. Account N' is a paybill, not a till", () => {
  const o = p("MPESA", "QGH7X8Y2Z3 Confirmed. Ksh200.00 paid to KPLC PREPAID. Account 12345678 on 25/10/26 at 9:41 AM. New M-PESA balance is Ksh1,287.00. Transaction cost, Ksh0.00.");
  assert.ok(o.ok);
  assert.equal(o.parsed.kind, "paybill");
  assert.equal(o.parsed.account, "12345678");
  assert.equal(o.parsed.counterpartyName, "KPLC PREPAID");
  assert.equal(o.parsed.amount, 20000);
});
