import test from "node:test";
import assert from "node:assert/strict";
import { parseSms } from "../src/sms/parse.js";
import { detectSmsSpoof } from "../src/sms/universal-lexer.js";
import { railForPaybill, railForSender, isOffRadarDestination } from "../src/sms/rails-directory.js";
import { counterpartyKey } from "../src/entities/normalize.js";

const sms = (sender: string, body: string) => ({ sender, body, receivedAt: Date.UTC(2026, 9, 26, 10, 0) - 3 * 3_600_000 });

test("UFG parses an unseen bank debit without a template", () => {
  const r = parseSms(sms("STANBIC", "Dear customer, your account has been debited with KES 1,250.00 for payment to SAFARICOM. New balance is KES 8,750.00. Ref STAN123456 on 26/10/26 at 10:15."));
  assert.ok(r.ok);
  assert.equal(r.parsed.provider, "bank");
  assert.equal(r.parsed.direction, "out");
  assert.equal(r.parsed.amount, 125_000);
  assert.equal(r.parsed.balanceAfter, 875_000);
  assert.equal(r.parsed.ref, "STAN123456");
});

test("UFG parses an unseen SACCO credit", () => {
  const r = parseSms(sms("UNAITAS", "You have received KES 5,000.00 from JOHN DOE. Balance KES 12,000.00. Ref UNA987654."));
  assert.ok(r.ok);
  assert.equal(r.parsed.direction, "in");
  assert.equal(r.parsed.amount, 500_000);
  assert.equal(r.parsed.counterpartyName, "JOHN DOE");
});

test("UFG rejects a loan advertisement with no transaction grammar", () => {
  const r = parseSms(sms("STANBIC", "Enjoy a personal loan offer this Christmas. Apply today."));
  assert.equal(r.ok, false);
});

test("spoof trap catches a personal number sending a fake M-PESA receipt", () => {
  const a = detectSmsSpoof(sms("+254722000111", "TJ99AA11BB Confirmed. You have received Ksh15,000.00 from JANE DOE. New M-PESA balance is Ksh15,000.00."));
  assert.ok(a);
  assert.equal(a.kind, "msisdn_spoof");
  assert.equal(a.severity, "critical");
});

test("rail directory and masked keys compose", () => {
  assert.equal(railForPaybill("522522")?.displayName, "KCB Bank");
  assert.equal(railForSender("NCBA")?.provider, "ncba");
  assert.ok(isOffRadarDestination({ kind: "paybill", counterpartyId: "247247" }));
  const k = counterpartyKey("0712***678", "JANE WAMBUI");
  assert.equal(k, "m:254712***678:jane_wambui");
});

test("Pochi receive uses the wallet parser", () => {
  const r = parseSms(sms("MPESA", "QGH7X8Y2Z1 Confirmed. You have received Ksh500.00 from MAMA NJERI 254722000222 via Pochi la Biashara on 26/10/26 at 2:15 PM. New M-PESA balance is Ksh1,500.00. Transaction cost, Ksh0.00."));
  assert.ok(r.ok);
  assert.equal(r.parsed.kind, "receive");
  assert.equal(r.parsed.amount, 50_000);
});
