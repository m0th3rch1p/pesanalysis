import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSms } from "../src/index.ts";
import { classifyFlow } from "../src/ledger/flow.js";
import { auditBalanceChain } from "../src/ledger/balance-chain.js";
import { eventRefFor } from "../src/events/link.js";
import type { ParsedSms } from "../src/types.js";

const ts = Date.UTC(2026, 9, 28, 19, 30, 0);
const p = (sender: string, body: string) => parseSms({ sender, body, receivedAt: ts });
const ok = (sender: string, body: string): ParsedSms => {
  const o = p(sender, body); assert.ok(o.ok, JSON.stringify(o)); return (o as { parsed: ParsedSms }).parsed;
};

const MSH_IN = "TXX1ABC2D1 Confirmed.Ksh50.00 transferred to M-Shwari account on 28/10/26 at 10:28 PM. M-PESA balance is Ksh950.00 .New M-Shwari saving account balance is Ksh60.00. Transaction cost Ksh.0.00";
const MSH_OUT = "TXX1ABC2D2 Confirmed.Ksh50.00 transferred from M-Shwari account on 28/10/26 at 10:30 PM. M-Shwari balance is Ksh10.00 .M-PESA balance is Ksh980.00 .Transaction cost Ksh.0.00";
const KCB_IN = "TXX1ABC2D3 Confirmed. Ksh20.00 transfered to KCB M-PESA account on 28/10/26 at 10:29 PM. New M-PESA balance is Ksh930.00, new KCB M-PESA Saving account balance is Ksh30.00.";
const KCB_OUT = "TXX1ABC2D4 Confirmed. You have transfered Ksh20.00 from your KCB M-PESA account on 28/10/26 at 10:31 PM. KCB M-PESA Account balance is Ksh10.00. New M-PESA balance is Ksh1,000.00.";

test("M-Shwari deposit: send/out to M-Shwari, wallet balance separate from savings balance", () => {
  const x = ok("MPESA", MSH_IN);
  assert.equal(x.template, "mpesa.mshwari.deposit");
  assert.equal(x.kind, "send"); assert.equal(x.direction, "out"); assert.equal(x.amount, 5000);
  assert.equal(x.fee, 0); assert.equal(x.balanceAfter, 95000); assert.equal(x.savingsBalanceAfter, 6000);
  assert.equal(x.counterpartyName, "M-Shwari"); assert.equal(x.ref, "TXX1ABC2D1");
  assert.equal(new Date(x.occurredAt).toISOString(), "2026-10-28T19:28:00.000Z");
  assert.equal(classifyFlow(x), "transfer_own");
});
test("M-Shwari withdraw: receive/in from M-Shwari", () => {
  const x = ok("MPESA", MSH_OUT);
  assert.equal(x.template, "mpesa.mshwari.withdraw");
  assert.equal(x.kind, "receive"); assert.equal(x.direction, "in"); assert.equal(x.balanceAfter, 98000);
  assert.equal(x.savingsBalanceAfter, 1000); assert.equal(x.fee, 0);
  assert.equal(classifyFlow(x), "transfer_own");
});
test("KCB M-PESA deposit and withdraw (single-r 'transfered' wording)", () => {
  const a = ok("MPESA", KCB_IN);
  assert.equal(a.template, "mpesa.kcb.deposit"); assert.equal(a.kind, "send"); assert.equal(a.direction, "out");
  assert.equal(a.balanceAfter, 93000); assert.equal(a.savingsBalanceAfter, 3000); assert.equal(a.fee, null);
  assert.equal(a.counterpartyName, "KCB M-PESA"); assert.equal(classifyFlow(a), "transfer_own");
  const b = ok("MPESA", KCB_OUT);
  assert.equal(b.template, "mpesa.kcb.withdraw"); assert.equal(b.kind, "receive"); assert.equal(b.direction, "in");
  assert.equal(b.balanceAfter, 100000); assert.equal(b.savingsBalanceAfter, 1000);
  assert.equal(classifyFlow(b), "transfer_own");
});
test("wallet balance chain holds across savings movements", () => {
  const txs = [MSH_IN, KCB_IN, MSH_OUT, KCB_OUT].map((b) => ok("MPESA", b));
  // order by time: MSH_IN 10:28, KCB_IN 10:29, MSH_OUT 10:30, KCB_OUT 10:31
  const r = auditBalanceChain(txs);
  assert.deepEqual(r.slice(1).map((x) => x.status), ["ok", "ok", "ok"]);
});
test("dual message per movement: KCB-sender mirror is skipped, so one event only", () => {
  const main = ok("MPESA", KCB_IN);
  const mirror = p("KCB M-PESA", "Confirmed. KES 20.00 transferred to KCB M-PESA account. Your KCB M-PESA account balance is KES 30.00.");
  assert.equal(mirror.ok, false); if (!mirror.ok) assert.equal(mirror.reason, "not_a_transaction");
  const mirror2 = p("KCB M-PESA", "Confirmed. You have transferred KES 20.00 from your M-PESA savings Account to M-PESA. Your M-PESA savings Account balance is KES 10.00.");
  assert.equal(mirror2.ok, false); if (!mirror2.ok) assert.equal(mirror2.reason, "not_a_transaction");
  assert.equal(eventRefFor(main, KCB_IN), "ref:TXX1ABC2D3");
});
test("KCB loan request notices are not transactions", () => {
  for (const [s, b] of [
    ["MPESA", "TXX1ABC2D5 Confirmed. Your KCB M-PESA loan request will be processed shortly."],
    ["KCB M-PESA", "Dear customer, we are unable to process your loan request at the moment. Please try again later."],
    ["MShwari", "Dear Customer, grow your savings with the M-Shwari Lock Savings Account and stay on track towards your goals."],
  ] as const) { const o = p(s, b); assert.equal(o.ok, false); }
});
test("existing 'received from KCB' MPESA and bank messages are not shadowed", () => {
  const x = ok("MPESA", "TXX1ABC2D6 Confirmed.You have received Ksh300.00 from KCB 1 501901 on 6/4/26 at 1:40 PM New M-PESA balance is Ksh2,534.24.");
  assert.equal(x.template, "mpesa.receive");
});
// M-Shwari / KCB loan request-receive-repay disbursement and repayment templates are intentionally
// NOT implemented: none exist in the inbox and no authoritative public wording was fetched.
