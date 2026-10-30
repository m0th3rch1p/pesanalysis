import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestLabel, notificationKind } from "../src/labels/suggest.js";
import { canLinkMaskedToFull, counterpartyKey, normalizePhone, normalizeName, parseMaskedPhone } from "../src/entities/normalize.js";
import { knnLabel } from "../src/labels/knn.js";
import type { ParsedSms } from "../src/types.js";

const p = (over: Partial<ParsedSms>): ParsedSms => ({
  provider: "mpesa", ref: "TJ12ABC3XY", kind: "till", direction: "out", amount: 35000, fee: 0,
  balanceAfter: 100000, counterpartyName: "SHELL KIAMBU ROAD", counterpartyId: null, account: null,
  occurredAt: Date.parse("2026-10-24T04:30:00Z"), template: "mpesa.till", parserVersion: "t",
  ...over,
});

test("entity normalization: Kenyan phones converge to one key", () => {
  assert.equal(normalizePhone("0712345678"), "254712345678");
  assert.equal(normalizePhone("+254712345678"), "254712345678");
  assert.equal(normalizePhone("254712345678"), "254712345678");
  assert.equal(normalizePhone("712345678"), "254712345678");
  assert.equal(counterpartyKey("0712345678", "JANE DOE"), "p:254712345678");
  assert.equal(counterpartyKey("555555", "NAIVAS"), "t:555555");
  assert.equal(counterpartyKey(null, "Jane  Doe!"), "n:jane doe");
});

test("rules: fuel station till suggests Fuel; KPLC paybill suggests Utilities", () => {
  assert.equal(suggestLabel(p({}))?.label, "Fuel");
  const kplc = suggestLabel(p({ kind: "paybill", counterpartyName: "KENYA POWER", account: "1234567" }));
  assert.equal(kplc?.label, "Utilities");
});

test("rules: loan repayments are debt, not airtime", () => {
  const f = suggestLabel(p({ kind: "loan_repay", counterpartyName: "Fuliza M-PESA", template: "mpesa.fuliza_repay_full" }));
  assert.equal(f?.label, "Debt repayment");
  const o = suggestLabel(p({ kind: "loan_repay", counterpartyName: "Okoa", template: "telco.okoa_repay" }));
  assert.equal(o?.label, "Debt repayment");
});

test("rules: data bundles are Airtime & data", () => {
  const d = suggestLabel(p({ kind: "paybill", counterpartyName: "SAFARICOM DATA BUNDLES", template: "mpesa.paybill" }));
  assert.equal(d?.label, "Airtime & data");
});

test("kNN learns from confirmed history and beats kind-defaults", () => {
  const history = [
    { id: "1", label: "Fuel", text: "shell kiambu road" },
    { id: "2", label: "Fuel", text: "shell waiyaki way" },
    { id: "3", label: "Groceries", text: "naivas kilimani" },
  ];
  const r = knnLabel("shell kiambu road", history);
  assert.equal(r?.label, "Fuel");
  const s = suggestLabel(p({}), { history });
  assert.equal(s?.label, "Fuel");
  assert.ok(s!.confidence >= 0.85); // auto-file territory
});

test("abstention: unknown counterparty with no rules -> kind default at most", () => {
  const s = suggestLabel(p({ counterpartyName: "WEIRD UNKNOWN SHOP 42", kind: "send", template: "mpesa.send" }));
  assert.ok(s === null || s.source === "kind_default" || s.confidence < 0.85, JSON.stringify(s));
});

test("notificationKind respects the auto-file threshold", () => {
  assert.equal(notificationKind({ label: "Fuel", confidence: 0.9, source: "rule", alternates: [] }), "auto");
  assert.equal(notificationKind({ label: "Rent", confidence: 0.7, source: "rule", alternates: [] }), "ask");
  assert.equal(notificationKind(null), "ask");
  assert.equal(notificationKind(null, "send"), "ask");
  assert.equal(notificationKind(null, "fee"), "silent");
});

test("masked MSISDN keys preserve prefix/suffix and do not collapse names", () => {
  assert.equal(parseMaskedPhone("0712***678"), "254712***678");
  assert.equal(parseMaskedPhone("+254712***678"), "254712***678");
  const a = counterpartyKey("0712***678", "JANE WAMBUI");
  const b = counterpartyKey("0722***999", "JANE WAMBUI");
  assert.equal(a, "m:254712***678:jane_wambui");
  assert.notEqual(a, b);
  assert.ok(canLinkMaskedToFull(a!, "254712345678", "JANE WAMBUI"));
  assert.ok(!canLinkMaskedToFull(a!, "254712345999", "JANE WAMBUI"));
  assert.ok(!canLinkMaskedToFull(a!, "254712345678", "PETER KAMAU"));
});


test("kNN never leaks Airtime & data across counterparty classes (WS0.3)", () => {
  const history = [
    { id: "1", label: "Airtime & data", text: "acme store", kind: "airtime" },
    { id: "2", label: "Airtime & data", text: "acme store", kind: "bundle" },
  ];
  for (const query of [
    p({ kind: "paybill", counterpartyName: "ACME STORE", template: "mpesa.paybill" }),
    p({ kind: "send", counterpartyName: "ACME STORE", template: "mpesa.send" }),
    p({ kind: "till", counterpartyName: "ACME STORE", template: "mpesa.till" }),
  ]) {
    const s = suggestLabel(query, { history });
    assert.notEqual(s?.label, "Airtime & data", `${query.kind} must not inherit telco label`);
  }
});

test("kNN requires two similar agreeing neighbours (WS0.3)", () => {
  const one = [{ id: "1", label: "Groceries", text: "acme store", kind: "till" }];
  assert.equal(suggestLabel(p({ kind: "till", counterpartyName: "ACME STORE" }), { history: one }), null);
  const two = [
    { id: "1", label: "Groceries", text: "acme store", kind: "till" },
    { id: "2", label: "Groceries", text: "acme stores", kind: "till" },
  ];
  const s = suggestLabel(p({ kind: "till", counterpartyName: "ACME STORE" }), { history: two });
  assert.equal(s?.label, "Groceries");
  assert.ok(s!.confidence <= 0.6, "small history must cap confidence at 0.6");
});

test("kNN learns only labels allowed for the target class (WS0.3)", () => {
  const history = [
    { id: "1", label: "Family support", text: "acme store", kind: "send" },
    { id: "2", label: "Family support", text: "acme store", kind: "send" },
  ];
  const s = suggestLabel(p({ kind: "paybill", counterpartyName: "ACME STORE" }), { history });
  assert.notEqual(s?.label, "Family support");
});

test("kind default never exceeds a counterparty default (WS0.3)", () => {
  const s = suggestLabel(p({ kind: "airtime", counterpartyName: "ACME STORE" }), {
    counterpartyDefault: { label: "Groceries", confidence: 0.5 },
  });
  const airtime = [s, ...(s?.alternates ?? [])].find((c) => c?.label === "Airtime & data");
  assert.ok(airtime);
  assert.equal(airtime!.confidence, 0.5);
});
