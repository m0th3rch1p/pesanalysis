import test from "node:test";
import assert from "node:assert/strict";
import { mergeOcrLines, parseReceipt } from "../src/ai/receipt.js";

// Synthetic Kenyan till slips. No real merchants, PINs or serials.
const SUPERMARKET = [
  "GREEN VALLEY SUPERMARKET LTD",
  "P.O. BOX 12345 NAIROBI",
  "TEL: 0700 000 000",
  "KRA PIN: P000111222Z",
  "TAX INVOICE",
  "DATE: 26/10/2026 14:32",
  "MILK 500ML        2 x 60.00     120.00",
  "BREAD                           65.00",
  "SUGAR 1KG                      180.00",
  "SUBTOTAL                       365.00",
  "VAT 16%                         50.34",
  "TOTAL ITEMS: 3",
  "TOTAL                         365.00",
  "CASH                           400.00",
  "CHANGE                          35.00",
  "ETR NO: KRACU0123456789",
  "THANK YOU",
];

test("receipt: supermarket slip", () => {
  const r = parseReceipt(SUPERMARKET);
  assert.equal(r.totalCents?.value, 36_500);
  assert.ok(r.totalCents!.confidence >= 0.9, String(r.totalCents!.confidence));
  assert.deepEqual(r.totalCents!.evidence.map((e) => e.text), ["TOTAL 365.00"]);
  assert.equal(r.merchant?.value, "GREEN VALLEY SUPERMARKET LTD");
  assert.equal(r.date?.value, "2026-10-26");
  assert.equal(r.time?.value, "14:32");
  assert.equal(r.kraPin?.value, "P000111222Z");
  assert.equal(r.etrSerial?.value, "KRACU0123456789");
  assert.equal(r.tenderedCents?.value, 40_000);
  assert.equal(r.changeCents?.value, 3_500);
  assert.equal(r.vat.length, 1);
  assert.deepEqual([r.vat[0]!.rate, r.vat[0]!.amountCents], [16, 5_034]);
  assert.deepEqual(r.warnings, []);
});

test("receipt: total never picks change, cash tendered, subtotal, VAT or item count", () => {
  const r = parseReceipt(["SHOP", "SUBTOTAL 1,000.00", "TOTAL VAT 137.93", "TOTAL ITEMS 12", "TOTAL 1,000.00", "CASH TENDERED 5,000.00", "CHANGE 4,000.00"]);
  assert.equal(r.totalCents?.value, 100_000);
  assert.equal(r.changeCents?.value, 400_000);
  assert.equal(r.tenderedCents?.value, 500_000);
});

test("receipt: largest amount following TOTAL / AMOUNT DUE / GRAND TOTAL wins", () => {
  const r = parseReceipt(["CAFE ROYALE", "TOTAL 800.00", "GRAND TOTAL KES 1,000.00", "AMOUNT DUE 1,000.00", "MPESA 1,000.00"]);
  assert.equal(r.totalCents?.value, 100_000);
  assert.ok(r.warnings.includes("multiple_distinct_totals_largest_chosen"));
  assert.ok(r.totalCents!.confidence < 0.95 + 0.05);
});

test("receipt: amount on the next OCR line, currency prefixes and /=", () => {
  assert.equal(parseReceipt(["STORE", "TOTAL", "1,250.00"]).totalCents?.value, 125_000);
  assert.equal(parseReceipt(["STORE", "TOTAL Ksh 1,250.00"]).totalCents?.value, 125_000);
  assert.equal(parseReceipt(["STORE", "AMOUNT DUE KSH1250/="]).totalCents?.value, 125_000);
  assert.equal(parseReceipt(["STORE", "TOTAL: KES 99"]).totalCents?.value, 9_900);
  const nl = parseReceipt(["STORE", "TOTAL", "1,250.00"]);
  assert.ok(nl.totalCents!.confidence < parseReceipt(["STORE", "TOTAL 1,250.00"]).totalCents!.confidence);
});

test("receipt: cash minus change equals total raises confidence; tendered below total lowers it", () => {
  const ok = parseReceipt(["STORE", "TOTAL 350.00", "CASH 500.00", "CHANGE 150.00"]);
  const bad = parseReceipt(["STORE", "TOTAL 350.00", "CASH 200.00"]);
  assert.ok(ok.totalCents!.confidence > bad.totalCents!.confidence);
  assert.ok(bad.warnings.includes("tendered_less_than_total"));
});

test("receipt: no TOTAL keyword => low-confidence fallback, flagged; never uses change/cash/vat", () => {
  const r = parseReceipt(["SOME KIOSK", "SODA 50.00", "BUNS 120.00", "CASH 500.00", "CHANGE 330.00", "VAT 16% 17.00"]);
  assert.equal(r.totalCents?.value, 12_000);
  assert.ok(r.totalCents!.confidence <= 0.4);
  assert.ok(r.warnings.includes("total_inferred_without_total_keyword"));
});

test("receipt: nothing parseable returns nulls and a warning, never throws", () => {
  for (const input of [[], [""], ["???", "###"], ["TOTAL"], ["TOTAL ABC"]]) {
    const r = parseReceipt(input);
    assert.equal(r.totalCents, null);
    assert.ok(r.warnings.includes("no_total_found"));
  }
});

test("receipt: dates in dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, ISO and '26 Oct 2026'; invalid and expiry dates ignored", () => {
  const cases: Array<[string, string | undefined]> = [
    ["DATE 26/10/2026", "2026-10-26"], ["26-10-26 09:05", "2026-10-26"], ["Date: 05.01.2026", "2026-01-05"],
    ["2026-10-26", "2026-10-26"], ["26 Oct 2026", "2026-10-26"], ["26-Oct-26", "2026-10-26"],
    ["31/02/2026", undefined], ["EXPIRY 01/01/2030", undefined], ["32/13/2026", undefined],
  ];
  for (const [line, want] of cases) assert.equal(parseReceipt(["STORE", line, "TOTAL 10.00"]).date?.value, want, line);
  assert.equal(parseReceipt(["STORE", "EXP 01/01/2030", "DATE 26/10/2026", "TOTAL 10.00"]).date?.value, "2026-10-26");
});

test("receipt: time with am/pm, future date lowers confidence when now is given", () => {
  assert.equal(parseReceipt(["STORE", "DATE 26/10/2026 02:15 PM", "TOTAL 1.00"]).time?.value, "14:15");
  const now = Date.UTC(2026, 9, 26);
  const fut = parseReceipt(["STORE", "DATE 26/10/2027", "TOTAL 1.00"], { now });
  const cur = parseReceipt(["STORE", "DATE 26/10/2026", "TOTAL 1.00"], { now });
  assert.ok(fut.date!.confidence < cur.date!.confidence);
  assert.ok(fut.warnings.includes("date_in_future"));
});

test("receipt: VAT lines with rates, total VAT, amount on next line; VAT registration lines excluded", () => {
  const r = parseReceipt(["STORE", "VAT NO: 0123456X", "KRA PIN P000111222Z", "A 16% VAT 100.00", "B 8% TAX 8.00", "TOTAL VAT", "108.00", "TOTAL 1,008.00"]);
  assert.deepEqual(r.vat.map((v) => [v.rate, v.amountCents]), [[16, 10_000], [8, 800], [null, 10_800]]);
  assert.equal(r.totalCents?.value, 100_800);
});

test("receipt: KRA PIN, ETR / CU serial, till number shapes", () => {
  const r = parseReceipt(["STORE", "PIN NO. A123456789B", "CUSN: KRAMW0000123456", "BUY GOODS TILL NO 123456", "TOTAL 5.00"]);
  assert.equal(r.kraPin?.value, "A123456789B");
  assert.equal(r.etrSerial?.value, "KRAMW0000123456");
  assert.equal(r.tillNo?.value, "123456");
  assert.equal(parseReceipt(["PIN: X123456789B"]).kraPin, null); // wrong first letter
  assert.equal(parseReceipt(["ETR RECEIPT"]).etrSerial, null); // needs a digit
  assert.equal(parseReceipt(["KRA 0712345678"]).kraPin, null);
});

test("receipt: merchant skips boilerplate, numbers and addresses; labelled merchant wins", () => {
  assert.equal(parseReceipt(["*** RECEIPT ***", "0700 000 000", "MAMA JANE STORES", "TOTAL 1.00"]).merchant?.value, "MAMA JANE STORES");
  assert.equal(parseReceipt(["TAX INVOICE", "Merchant: Quick Mart", "TOTAL 1.00"]).merchant?.value, "Quick Mart");
  assert.equal(parseReceipt(["12345", "TEL 0700", "TOTAL 1.00"]).merchant, null);
  const hinted = parseReceipt(["Q", "BLUE STAR HARDWARE LTD"]).merchant!;
  assert.ok(hinted.confidence >= 0.65);
});

test("receipt: OCR confidence scales field confidence; evidence line numbers are indexes", () => {
  const r = parseReceipt([{ text: "STORE X", confidence: 0.9 }, { text: "TOTAL 100.00", confidence: 0.5 }]);
  assert.ok(r.totalCents!.confidence <= 0.5);
  assert.deepEqual(r.totalCents!.evidence, [{ line: 1, text: "TOTAL 100.00" }]);
});

test("receipt: thousands separators and decimals parse exactly (integer cents)", () => {
  assert.equal(parseReceipt(["S", "TOTAL 12,345,678.90"]).totalCents?.value, 1_234_567_890);
  assert.equal(parseReceipt(["S", "TOTAL 1250"]).totalCents?.value, 125_000);
  assert.equal(parseReceipt(["S", "TOTAL 0.99"]).totalCents?.value, 99);
});

test("receipt: garbage and hostile text never throw (fuzz)", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = "TOTAL CASH CHANGE VAT KRA PIN 0123456789.,/-:%=KES Ksh\n\u0000\u202e<script>";
  for (let i = 0; i < 300; i++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(""));
    const r = parseReceipt(lines);
    if (r.totalCents) assert.ok(Number.isInteger(r.totalCents.value) && r.totalCents.value > 0);
    for (const f of [r.totalCents, r.merchant, r.date]) if (f) assert.ok(f.confidence >= 0 && f.confidence <= 1);
  }
});

test("multi-photo receipt: merges overlapping boundary lines and extracts items", () => {
  const top = [
    "NAIVAS SUPERMARKET", "TILL 12345", "DATE 29/10/2026",
    "BREAD 60.00", "MILK 65.00", "SUGAR 130.00",
  ];
  const bottom = [
    "SUGAR 130.00", "SUBTOTAL 255.00", "COOKING OIL 1,200.00", "TOTAL 1,455.00", "CASH 2,000.00", "CHANGE 545.00",
  ];
  const merged = mergeOcrLines([top, bottom]);
  assert.equal(merged.filter((l) => l.text === "SUGAR 130.00").length, 1);
  const r = parseReceipt(merged);
  assert.equal(r.totalCents?.value, 145_500);
  assert.deepEqual(r.items.map((i) => [i.name, i.amountCents]), [
    ["BREAD", 6_000], ["MILK", 6_500], ["SUGAR", 13_000], ["COOKING OIL", 120_000],
  ]);
  const qty = parseReceipt(["SHOP", "2 x SODA 100.00", "TOTAL 100.00"]).items;
  assert.equal(qty[0]?.qty, 2);
  assert.equal(qty[0]?.unitCents, 5_000);
});

test("multi-photo receipt: reverse attach order stitches overlaps and ignores product-line merchants", () => {
  const top = [
    "NAIVAS SUPERMARKET", "NAIROBI CBD", "30/10/2026 09:41",
    "MILK 500ML 65.00", "BREAD 400G 65.00", "SUGAR 1KG 160.00",
    "COOKING OIL 1L 390.00", "MAIZE FLOUR 2KG 205.00", "TOTAL KES 885.00",
  ];
  const bottom = [
    "MAIZE FLOUR 2KG 205.00", "TOTAL KES 885.00", "MPESA 885.00", "TILL 123456", "THANK YOU",
  ];
  const merged = mergeOcrLines([bottom, top]);
  assert.deepEqual(merged.map((l) => l.text), [...top, ...bottom.slice(2)]);
  const r = parseReceipt(merged);
  assert.equal(r.totalCents?.value, 88_500);
  assert.equal(r.merchant?.value, "NAIVAS SUPERMARKET");
  assert.deepEqual(r.items.map((i) => [i.name, i.amountCents]), [
    ["MILK 500ML", 6_500], ["BREAD 400G", 6_500], ["SUGAR 1KG", 16_000],
    ["COOKING OIL 1L", 39_000], ["MAIZE FLOUR 2KG", 20_500],
  ]);
  assert.equal(parseReceipt(["MAIZE FLOUR 2KG", "TOTAL 205.00"]).merchant, null);
});

test("receipt items: trailing x2 is a quantity, not a price", () => {
  const items = parseReceipt(["SHOP", "MILK 500ML x2 130.00", "BREAD 65.00", "TOTAL 195.00"]).items;
  assert.deepEqual(items.map((i) => [i.name, i.qty, i.amountCents, i.unitCents]), [
    ["MILK 500ML", 2, 13_000, 6_500], ["BREAD", 1, 6_500, 6_500],
  ]);
});
