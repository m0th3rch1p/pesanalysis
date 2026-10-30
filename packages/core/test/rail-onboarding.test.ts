import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at } from "./fixtures.js";
import { discoverAccount, insertSecurityAlert, listAccounts, listSecurityAlerts, offRadarSummary, reconcileSecurity, resolveSecurityAlert } from "../src/ledger/accounts.js";
import type { ParsedSms } from "../src/types.js";
import { linkMaskedContacts } from "../src/entities/contact-link.js";

const parsed = (over: Partial<ParsedSms> = {}): ParsedSms => ({
  provider: "mpesa", ref: "KCB1", kind: "paybill", direction: "out", amount: 250_000, fee: 0,
  balanceAfter: 750_000, counterpartyName: "KCB BANK", counterpartyId: "522522", account: "11049281",
  occurredAt: at(2026, 10, 20), template: "mpesa.paybill.sent", parserVersion: "1", ...over,
});

test("accounts: M-Pesa -> KCB paybill auto-creates both nodes and links the transaction", () => {
  const db = fixtureDb(); const a = adapter(db);
  db.prepare(`INSERT INTO transactions (id, provider, kind, direction, amount, fee, occurred_at, template, parser_version, status)
    VALUES (901,'mpesa','paybill','out',250000,0,?, 'mpesa.paybill.sent','1','pending')`).run(at(2026, 10, 20));
  const out = discoverAccount(a, { sender: "MPESA", parsed: parsed(), txId: 901 });
  assert.ok(out.sourceId > 0 && out.targetId && out.targetId > 0);
  const accounts = listAccounts(a);
  const wallet = accounts.find((x) => x.provider === "mpesa")!;
  const kcb = accounts.find((x) => x.provider === "kcb")!;
  assert.equal(wallet.visibility, "full");
  assert.equal(kcb.visibility, "partial");
  assert.equal(kcb.total_in_cents, 250_000);
  const tx = db.prepare("SELECT account_id, settlement_status FROM transactions WHERE id=901").get() as { account_id: number; settlement_status: string };
  assert.equal(tx.account_id, wallet.id);
  assert.equal(tx.settlement_status, "settled");
  db.close();
});

test("security: alerts de-duplicate, list and resolve", () => {
  const db = fixtureDb(); const a = adapter(db);
  const id = insertSecurityAlert(a, { severity: "critical", kind: "msisdn_spoof", sender: "0712", title: "Fake", detail: "x", evidence: {}, occurredAt: 1 });
  const dup = insertSecurityAlert(a, { severity: "critical", kind: "msisdn_spoof", sender: "0712", title: "Fake", detail: "x", evidence: {}, occurredAt: 1 });
  assert.equal(id, dup);
  assert.equal(listSecurityAlerts(a).length, 1);
  resolveSecurityAlert(a, id, 2);
  assert.equal(listSecurityAlerts(a).length, 0);
  db.close();
});

test("off-radar summary counts labelled visible-account transfers", () => {
  const db = fixtureDb(); const a = adapter(db);
  const label = (db.prepare("SELECT id FROM labels WHERE name='Off-radar transfer'").get() as { id: number }).id;
  db.prepare(`INSERT INTO transactions (id, provider, kind, direction, amount, fee, occurred_at, template, parser_version, status)
    VALUES (902,'mpesa','paybill','out',250000,0,?, 'mpesa.paybill.sent','1','confirmed')`).run(at(2026, 10, 20));
  db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (902,?,'rule',1,1,1)").run(label);
  discoverAccount(a, { sender: "MPESA", parsed: parsed(), txId: 902 });
  const s = offRadarSummary(a, at(2026, 10, 1));
  assert.equal(s.offRadarCents, 250_000);
  assert.ok(s.share > 0);
  assert.ok(s.accounts.length >= 1);
  db.close();
});

test("contact unmasking links a masked key only when prefix/suffix/name agree", () => {
  const db = fixtureDb(); const a = adapter(db);
  const masked = "m:254712***678:jane_wambui";
  db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)").run(masked, "JANE WAMBUI", "[]", 1);

  const out = linkMaskedContacts(a, [
    { contactId: "c1", name: "Jane Wambui", phones: ["254712345678"] },
    { contactId: "c2", name: "Peter Kamau", phones: ["254712345999"] },
  ]);
  assert.equal(out.linked, 1);
  const row = db.prepare("SELECT display_name AS d, contact_id AS c FROM counterparties WHERE key=?").get(masked) as { d: string; c: string };
  assert.equal(row.c, "c1");
  const link = db.prepare("SELECT full_key AS f FROM entity_links WHERE masked_key=?").get(masked) as { f: string };
  assert.equal(link.f, "p:254712345678");
  db.close();
});
