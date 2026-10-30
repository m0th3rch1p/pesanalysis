import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at } from "./fixtures.js";
import { insertSecurityAlert, listSecurityAlerts, listAuditAlerts, getSecurityAlert } from "../src/ledger/accounts.js";
import { classifyBalanceBreak, suppressBalanceBreaks, balanceBreakEvidence } from "../src/security/breaks.js";
import { addFinePattern, isFinePattern } from "../src/security/fine.js";
import { maskPhones } from "../src/security/mask.js";

function tx(db: ReturnType<typeof fixtureDb>, provider: string, kind: string, amount: number, ms: number, balance: number | null, direction = "out") {
  return Number(db.prepare(`INSERT INTO transactions
    (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role,balance_after)
    VALUES (?,?,?,?,NULL,?,'test','1','confirmed','transaction',?)`).run(provider, kind, direction, amount, ms, balance).lastInsertRowid);
}
const alert = (db: ReturnType<typeof fixtureDb>, txId: number, d: number, ms: number, kind = "balance_break", sender = "MPESA") => insertSecurityAlert(adapter(db), {
  txId, severity: "warning", kind: kind as never, sender, title: "t", detail: "d",
  evidence: { discrepancy: d, provider: "mpesa" }, occurredAt: ms,
});

test("masking keeps only the last three digits", () => {
  assert.equal(maskPhones("Sent to 0712345678 and +254712345679 KES 500"), "Sent to •••678 and •••679 KES 500");
  assert.equal(maskPhones("Receipt UABC123XY KES 500"), "Receipt UABC123XY KES 500");
});

test("balance break suppression: Fuliza reorder, opposite pair, Airtel model", () => {
  const db = fixtureDb(); const a = adapter(db);
  const t1 = tx(db, "mpesa", "till", 40_000, at(2026, 10, 10, 10), 900_000);
  tx(db, "mpesa", "loan_draw", 5_000, at(2026, 10, 10, 10) + 60_000, null, "in");
  const a1 = alert(db, t1, 5_000, at(2026, 10, 10, 10));
  assert.equal(classifyBalanceBreak(a, a1), "fuliza_reorder");
  assert.equal(listSecurityAlerts(a).length, 0);
  assert.equal(listAuditAlerts(a).length, 1);
  assert.equal(getSecurityAlert(a, a1)?.suppressedReason, "fuliza_reorder");

  const t2 = tx(db, "mpesa", "send", 10_000, at(2026, 10, 11, 10), 500_000);
  const t3 = tx(db, "mpesa", "send", 10_000, at(2026, 10, 11, 10) + 20 * 60_000, 500_000);
  const a2 = alert(db, t2, 3_000, at(2026, 10, 11, 10));
  const a3 = alert(db, t3, -3_000, at(2026, 10, 11, 10) + 20 * 60_000);
  assert.equal(classifyBalanceBreak(a, a2), "opposite_pair");
  assert.equal(getSecurityAlert(a, a3)?.suppressedReason, "opposite_pair");

  const t4 = tx(db, "airtel_money", "airtime", 5_000, at(2026, 10, 12, 10), 100_000);
  const a4 = alert(db, t4, 500, at(2026, 10, 12, 10));
  assert.equal(classifyBalanceBreak(a, a4), "airtel_model");

  const t5 = tx(db, "mpesa", "till", 40_000, at(2026, 10, 13, 10), 900_000);
  const a5 = alert(db, t5, 261_00, at(2026, 10, 13, 10));
  assert.equal(classifyBalanceBreak(a, a5), null);
  assert.equal(getSecurityAlert(a, a5)?.visibility, "prominent");
  const ev = balanceBreakEvidence(a, a5);
  assert.equal(ev?.discrepancyCents, 26_100);
  assert.equal(ev?.expectedBalanceCents, 900_000 + 26_100);

  const t6 = tx(db, "mpesa", "till", 100, at(2026, 10, 14, 10), 1_000);
  alert(db, t6, 100, at(2026, 10, 14, 10));
  assert.equal(suppressBalanceBreaks(a).suppressed, 0);
  db.close();
});

test("'This is fine' suppresses the same kind and sender suffix, not other senders", () => {
  const db = fixtureDb(); const a = adapter(db);
  const t = tx(db, "mpesa", "send", 100, at(2026, 10, 15, 10), 1000);
  const first = alert(db, t, 0, at(2026, 10, 15, 10), "msisdn_spoof", "0712345678");
  addFinePattern(a, "msisdn_spoof", "0712345678");
  assert.equal(isFinePattern(a, "msisdn_spoof", "+254712345678"), true);
  const t2 = tx(db, "mpesa", "send", 100, at(2026, 10, 16, 10), 1000);
  const second = alert(db, t2, 0, at(2026, 10, 16, 10), "msisdn_spoof", "+254712345678");
  assert.equal(getSecurityAlert(a, second)?.visibility, "audit");
  assert.equal(getSecurityAlert(a, second)?.suppressedReason, "user_fine");
  const t3 = tx(db, "mpesa", "send", 100, at(2026, 10, 17, 10), 1000);
  const other = alert(db, t3, 0, at(2026, 10, 17, 10), "msisdn_spoof", "0700000999");
  assert.equal(getSecurityAlert(a, other)?.visibility, "prominent");
  db.close();
});
