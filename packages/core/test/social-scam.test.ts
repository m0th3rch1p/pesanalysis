import test from "node:test";
import assert from "node:assert/strict";
import { detectSocialScam } from "../src/sms/universal-lexer.js";

const m = (sender: string, body: string) => ({ sender, body, receivedAt: 1_700_000_000_000 });

test("reversal plea from a person is flagged", () => {
  const a = detectSocialScam(m("0712345678", "I sent you 2,000 by mistake, please send it back to this number"));
  assert.equal(a?.title, "Possible reversal scam");
  assert.equal(a?.kind, "reversal_trap");
});

test("phishing link asking for a PIN or fee is flagged; provider links are not", () => {
  assert.equal(detectSocialScam(m("EQUITYBANK", "Your account is suspended. Verify your PIN at https://equity-secure.example/login"))?.kind, "phishing");
  assert.equal(detectSocialScam(m("CREDOTOSHA", "Pay a small processing fee to activate your loan: https://cred.example/pay"))?.kind, "phishing");
  assert.equal(detectSocialScam(m("MPESA", "QK12 Confirmed. Ksh 500 sent. New M-PESA balance is Ksh 100. See all balances https://saf.cx/abc")), null);
  assert.equal(detectSocialScam(m("SOME BANK", "Your statement is ready at https://bank.example/statements")), null);
});

test("ordinary messages are not flagged", () => {
  assert.equal(detectSocialScam(m("MPESA", "QK12 Confirmed. Ksh 500 sent to JANE.")), null);
  assert.equal(detectSocialScam(m("SAFARICOM", "Your bundle expires today. Dial *544# to renew.")), null);
});
