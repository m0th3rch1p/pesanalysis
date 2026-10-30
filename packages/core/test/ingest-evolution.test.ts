import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestSms, type Store } from "../src/ingest.js";
import { parseSms } from "../src/sms/parse.js";
import { migrate, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";
import { evaluateProposal, type Proposal } from "../src/evolution/proposals.js";
import { buildTools } from "../src/agent/tools.js";
import { agentAnswer, numbersVerified as numbersVerifiedFn } from "../src/agent/loop.js";
import { mamaMboga } from "../src/synth/personas.js";
import { binomTwoSided, wilson, permTestOneSided } from "../src/detectors/stats.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { KnnItem, Suggestion } from "../src/labels/suggest.js";

/** In-memory Store + DbAdapter doubles (exactly the interface the Expo side implements over sqlite). */
function memoryDb(): DbAdapter {
  const tables: Record<string, any[]> = {};
  const exec = (sql: string) => {
    const create = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql);
    if (create && !tables[create[1]!]) tables[create[1]!] = [];
  };
  return {
    exec, run: exec, get: () => null, all: () => [],
  };
}

function memoryStore(): Store & { txs: any[]; cps: Map<string, number> } {
  const txs: any[] = [];
  const cps = new Map<string, number>();
  const roles = new Map<number, string>();
  const smsSeen = new Set<string>();
  let smsId = 0, txId = 0, cpId = 0;
  const history: KnnItem[] = [
    { id: "h1", label: "Fuel", text: "shell kiambu road" },
    { id: "h2", label: "Fuel", text: "total energies kasarani" },
  ];
  return {
    txs, cps,
    hasSms: (s) => smsSeen.has(`${s.sender}|${s.receivedAt}|${s.body}`),
    insertSms: (s) => { smsSeen.add(`${s.sender}|${s.receivedAt}|${s.body}`); return ++smsId; },
    insertTx: (t) => { txs.push(t); const id = ++txId; roles.set(id, t.role); return id; },
    findTxByEventRef: (ref) => {
      const i = txs.findIndex((t) => t.eventRef === ref);
      if (i < 0) return null;
      return { id: i + 1, provider: txs[i]!.parsed.provider, role: roles.get(i + 1) ?? txs[i]!.role };
    },
    setTxRole: (id, role) => { roles.set(id, role); if (txs[id - 1]) txs[id - 1].role = role; },
    upsertCounterparty: (key) => {
      if (!cps.has(key)) cps.set(key, ++cpId);
      return { id: cps.get(key)!, isNew: !cps.has(key) };
    },
    findLabelIdByName: (n) => (n === "Fuel" ? 1 : n === "Groceries" ? 2 : null),
    lastBalanceTx: () => null,
    chainAnchor: () => {
      const withBal = txs.filter((t) => t.parsed.balanceAfter != null && t.parsed.provider === "mpesa");
      const last = withBal[withBal.length - 1];
      // pending: sum of effects of balance-less mpesa txs after the anchor (Fuliza draws credit the wallet)
      const idx = last ? txs.indexOf(last) : -1;
      let pending = 0;
      for (const t of txs.slice(idx + 1)) {
        if (t.parsed.balanceAfter != null) continue;
        const p = t.parsed;
        const eff = p.kind === "loan_draw" ? p.amount
          : ["send", "paybill", "till", "withdraw", "airtime", "bundle"].includes(p.kind) ? -(p.amount + (p.fee ?? 0))
          : ["receive", "deposit", "reversal"].includes(p.kind) ? p.amount - (p.fee ?? 0)
          : null;
        if (eff != null) pending += eff;
      }
      return { anchor: last ? last.parsed.balanceAfter : null, pending };
    },
    confirmedHistoryForKnn: () => history,
  };
}

test("ingestSms parses, resolves counterparty, chains balances, and decides notifications", () => {
  const store = memoryStore();
  const r1 = ingestSms({ sender: "MPESA", body: "TJ12ABC3XY Confirmed. Ksh1,000.00 sent to JANE SMITH 254712345678 on 24/10/26 at 2:15 PM. New M-PESA balance is Ksh9,000.00. Transaction cost, Ksh13.00.", receivedAt: Date.now() }, store);
  assert.ok(r1.stored && r1.actions);
  assert.equal(r1.actions.title, "Ksh1,000.00 sent to JANE SMITH");
  assert.equal(r1.actions.chainStatus, "first");
  const r2 = ingestSms({ sender: "MPESA", body: "TJ12ABC3XZ Confirmed. Ksh500.00 paid to SUPERMARKET LTD. on 24/10/26 at 3:15 PM.New M-PESA balance is Ksh8,500.00. Transaction cost, Ksh0.00.", receivedAt: Date.now() + 1 }, store);
  assert.equal(r2.actions!.chainStatus, "ok");
  const r3 = ingestSms({ sender: "MPESA", body: "TJ12ABC3YY Confirmed. Ksh200.00 paid to OTHER SHOP. on 24/10/26 at 4:15 PM.New M-PESA balance is Ksh7,800.00. Transaction cost, Ksh0.00.", receivedAt: Date.now() + 2 }, store);
  assert.equal(r3.actions!.chainStatus, "break"); // 8500 - 200 != 7800
  assert.equal(r3.actions!.chainDiscrepancy, 50000);
  assert.ok(store.txs.every((t) => t.chainStatus !== "unknown" || t.parsed.balanceAfter == null));
});

test("an exact SMS already captured is not replayed by a catch-up", () => {
  const store = memoryStore();
  const sms = {
    sender: "MPESA",
    body: "TJ12ABC3XY Confirmed. Ksh1,000.00 sent to JANE SMITH 254712345678 on 24/10/26 at 2:15 PM. New M-PESA balance is Ksh9,000.00. Transaction cost, Ksh13.00.",
    receivedAt: Date.now(),
  };
  const first = ingestSms(sms, store);
  assert.ok(first.stored);
  const again = ingestSms(sms, store);
  assert.equal(again.stored, false);
  assert.equal(again.skipReason, "duplicate_sms");
  assert.equal(store.txs.length, 1);
});

test("promos and failures are never stored as transactions", () => {
  const store = memoryStore();
  const promo = ingestSms({ sender: "Safaricom", body: "Thank You For Purchasing Daily 50MB+20SMS+WhatsApp bundle. Expiry date 24/10/26 18:00.", receivedAt: Date.now() }, store);
  assert.equal(promo.stored, false);
  assert.equal(promo.skipReason, "not_a_transaction");
  const fail = ingestSms({ sender: "MPESA", body: "Failed. You do not have enough money in your M-PESA account to pay Ksh1,000.00 to SOMEONE. Your M-PESA balance is Ksh50.00.", receivedAt: Date.now() }, store);
  assert.equal(fail.stored, false);
  const foreign = ingestSms({ sender: "CHURCH BULLETIN", body: "Sunday service at 9 AM", receivedAt: Date.now() }, store);
  assert.equal(foreign.skipReason, "not_financial_sender");
});

test("event linking: Fuliza draw and payment with one receipt are two messages, one event", () => {
  const store = memoryStore();
  const draw = "TEX0000001 Confirmed. Fuliza M-PESA amount is Ksh 23.00. Access Fee charged Ksh 0.23. Total Fuliza M-PESA outstanding amount is Ksh183.46 due on 21/11/26. To check daily charges, Dial *334#OK Select Query Charges";
  const pay = "TEX0000001 Confirmed. Ksh23.00 sent to ACME SHOP for account ACC0000001 on 22/10/26 at 10:22 PM New M-PESA balance is Ksh0.00. Transaction cost, Ksh0.00.";
  const t = Date.parse("2026-10-22T19:22:00Z");
  ingestSms({ sender: "MPESA", body: draw, receivedAt: t }, store);
  ingestSms({ sender: "MPESA", body: pay, receivedAt: t + 1000 }, store);
  assert.equal(store.txs.length, 2);
  assert.equal(store.txs[0].role, "funding_notice");
  assert.equal(store.txs[1].role, "transaction");
  assert.equal(store.txs[0].eventRef, store.txs[1].eventRef);
});

test("event linking: Equity mirror arrives before M-Pesa and is demoted, not double-counted", () => {
  const store = memoryStore();
  const mirror = "JANE WANJIKU OTIENO has sent KShs. 4950.0 to your MPESA. The MPESA receipt number is  UJ0000Q2UJ and transaction reference is  EQA00C4D3EA2AEC.";
  const recv = "UJ0000Q2UJ Confirmed.You have received Ksh4,950.00 from Equity Bulk Account 999999 on 2/10/26 at 4:54 PM New M-PESA balance is Ksh4,950.00.  See all your balances now https://saf.cx/kWQpy.";
  const t = Date.parse("2026-10-02T13:54:00Z");
  ingestSms({ sender: "Equity Bank", body: mirror, receivedAt: t + 300 }, store);
  ingestSms({ sender: "MPESA", body: recv, receivedAt: t }, store);
  assert.equal(store.txs[0].role, "bank_mirror");
  assert.equal(store.txs[1].role, "transaction");
  assert.equal(store.txs[0].eventRef, "ref:UJ0000Q2UJ");
});

test("event linking: Okoa duplicates 15 minutes apart share one event", () => {
  const store = memoryStore();
  const okoa = "You have received Ksh18.00. The fee is KSH 2.00.Your debt of Ksh 20.00 should be paid by 19-10-2026.TOTAL UNPAID OKOA JAHAZI is 120.00. You can now Okoa Minutes to Call MORE for LESS. Just select Okoa minutes. Dial *131# to check your okoa limit.";
  const saf = "You have received Sh18.00. The fee is Sh2. Your debt of Sh20 should be paid by 2026-10-19. TOTAL UNPAID OKOA JAHAZI is 120.00. You can now Okoa Minutes to Call MORE for LESS. Just select Okoa minutes. Dial *131# to check your okoa limit.";
  const t = Date.parse("2026-10-14T18:17:00Z");
  ingestSms({ sender: "Okoa Jahazi", body: okoa, receivedAt: t }, store);
  ingestSms({ sender: "Safaricom", body: saf, receivedAt: t - 15 * 60_000 }, store);
  assert.equal(store.txs.length, 2);
  assert.equal(store.txs[0].role, "airtime_notice");
  assert.equal(store.txs[1].role, "airtime_notice");
  assert.equal(store.txs[0].eventRef, store.txs[1].eventRef);
});

test("migrate: fresh db gets schema v2 + taxonomy seeds", () => {
  const calls: string[] = [];
  const db: DbAdapter = { exec: (s) => void calls.push(s), run: () => {}, get: () => null, all: () => [] };
  migrate(db);
  assert.ok(calls.some((c) => c.includes("CREATE TABLE IF NOT EXISTS transactions")));
  assert.equal(SCHEMA_VERSION, 10);
});

test("evolution gate: applies clear wins, abstains on small n, rejects regressions", () => {
  const prop: Proposal = { id: "p1", origin: "profiler", type: "rule_add", patch: {}, createdAt: 0 };
  // history of 40 items; patch improves 30, worsens 2 -> after penalty 30 vs 4 => apply
  const g1 = evaluateProposal(prop, Array.from({ length: 40 }, (_, i) => i), (i) => 0, (i) => (i < 30 ? 1 : i < 32 ? -1 : 0));
  assert.equal(g1.verdict, "apply");
  const g2 = evaluateProposal(prop, [1, 2, 3], (i) => 0, (i) => 1);
  assert.equal(g2.verdict, "abstain"); // n too small
  const g3 = evaluateProposal(prop, Array.from({ length: 40 }, (_, i) => i), (i) => 0, (i) => (i < 5 ? 1 : -1));
  assert.equal(g3.verdict, "reject");
  const g4 = evaluateProposal(prop, Array.from({ length: 40 }, () => 7), (i) => 1, (i) => 1);
  assert.equal(g4.verdict, "abstain"); // no effect
});

test("stats: binomTwoSided + wilson behave", () => {
  assert.ok(binomTwoSided(10, 10, 0.5) < 0.05);
  assert.ok(binomTwoSided(10, 5, 0.5) > 0.5);
  const w = wilson(8, 10);
  assert.ok(w.lo > 0.48 && w.lo < 0.62, String(w.lo));
});

test("permTestOneSided: strong signal -> small p; identical -> ~1", () => {
  const a = Array.from({ length: 20 }, (_, i) => i * 10 + 100);
  const b = Array.from({ length: 20 }, (_, i) => i * 10);
  assert.ok(permTestOneSided(a, b) < 0.01);
  assert.ok(permTestOneSided(b, b, 500) > 0.2);
});

test("agent: deterministic fallback answers without an LLM and uses real aggregates", async () => {
  const now = Date.now();
  const txs = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), occurredAt: now - i * 3600_000, direction: "out" as const, amount: 10000,
    counterpartyKey: "t:111", kind: "till" as const, fee: 0, label: "Groceries", scope: "personal" as const, role: null, provider: "mpesa",
  }));
  const findings = [{ detector: "fee_drag", id: "x", title: "KES 120 in fees this week", n: 5, evidence: {} }];
  const tools = buildTools(txs, findings as any);
  const r = await agentAnswer("How much did I spend this week?", tools, null);
  assert.ok(r.answer.includes("Answering from the local ledger"));
  assert.ok(r.numbersVerified);
});

test("agent: number-preservation post-check redacts hallucinated numbers", () => {
  const out = numbersVerifiedFn("You spent Ksh999,999.99 this week (Ksh99 in fees).", { sum: 12000 });
  assert.ok(!out.includes("999,999") && !out.includes("999999"), out);
  assert.ok(out.includes("Ksh99"), out);
});

test("ingest blocks MSISDN spoof and records a critical alert", () => {
  const store = memoryStore();
  const alerts: any[] = [];
  (store as any).recordSecurityAlert = (a: any) => alerts.push(a);
  const r = ingestSms({ sender: "+254722000111", body: "TJ99AA11BB Confirmed. You have received Ksh15,000.00 from JANE DOE. New M-PESA balance is Ksh15,000.00.", receivedAt: Date.now() }, store);
  assert.equal(r.stored, false);
  assert.equal(r.security?.kind, "msisdn_spoof");
  assert.equal(store.txs.length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "msisdn_spoof");
});
