import test from "node:test";
import assert from "node:assert/strict";
import { candidateFingerprint, modelCandidate } from "../src/ai/candidate.js";

const c = (sender: string, body: string, skipReason = "no_template_match") => modelCandidate({ sender, body, receivedAt: Date.now(), skipReason });

test("transaction-like messages from known financial senders are candidates", () => {
  const cases = [
    ["MPESA", "QK12ABC Confirmed. Ksh1,200.00 sent to JANE DOE 0712***456 on 29/10/26 at 9:15 AM. New M-PESA balance is Ksh3,400.00."],
    ["EQUITYBANK", "Dear customer, KES 5,000.00 has been credited to your account 0123***789 on 29/10/26. Balance KES 9,200."],
    ["CREDOTOSHA", "Your loan repayment of KES 1,050 is due on 30/10/26. Pay via M-PESA Paybill."],
  ];
  for (const [s, b] of cases) {
    if (!s || !b) continue;
    const v = c(s, b);
    assert.equal(v.candidate, true, `${s}: ${v.reasons.join(",")}`);
  }
});

test("unknown alphanumeric senders need strong transaction language", () => {
  assert.equal(c("SOME_NEW_BANK", "Confirmed. Ksh 400.00 paid to TILL 123456. New balance Ksh 1,000.").candidate, true);
  assert.equal(c("SOME_NEW_BANK", "Ksh 400.00 is waiting for you. Collect today.").candidate, false);
});

test("promotions, offers, OTPs, links and personal numbers are rejected", () => {
  const no = [
    ["MPESA", "Congratulations! You have won Ksh 100,000 in our promotion. Dial *123# to claim."],
    ["SAFARICOM", "Get Ksh 20 airtime bonus on your next purchase. Terms and conditions apply."],
    ["MPESA", "Your verification code is 482913. Do not share this code."],
    ["KCB", "Pre-approved loan offer of KES 200,000. Apply now at https://example.com"],
    ["0712345678", "Confirmed. Ksh 1,000 sent. Balance Ksh 0."],
    ["MPESA", "Your account statement is ready"],
  ];
  for (const [s, b] of no) { if (!s || !b) continue; assert.equal(c(s, b).candidate, false, `${s}: ${b}`); }
  assert.equal(c("MPESA", "Confirmed. Ksh 500.00 sent to JANE. New M-PESA balance is Ksh 100.", "phone_number_sender").candidate, false);
  assert.equal(c("M-PESA", "Confirmed. Ksh 500.00 sent to JANE." + " x".repeat(400)).candidate, false);
});

test("fingerprint never contains the body", () => {
  const f = candidateFingerprint("MPESA", "Ksh 1,000 sent to JANE 0712345678");
  assert.ok(!f.includes("JANE"));
  assert.ok(!f.includes("0712345678"));
});
