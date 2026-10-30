import test from "node:test";
import assert from "node:assert/strict";
import { guardedTranslate, maskEntities, restoreEntities, verifyTranslation } from "../src/ai/translate-guard.js";

const SRC = "You sent Ksh1,250.50 to 0712345678 on 26/10/26 at 2:30 PM. Ref SJK3L9X2QW. Fees were KES 15, 3 payments, 16% VAT.";

test("mask: every digit group, amount, date, time, phone and ref becomes a placeholder; none survive", () => {
  const { masked, entities } = maskEntities(SRC);
  assert.doesNotMatch(masked, /\d/);
  assert.match(masked, /\[\[EA\]\]/);
  const kinds = Object.fromEntries(entities.map((e) => [e.text, e.kind]));
  assert.equal(kinds["Ksh1,250.50"], "amount");
  assert.equal(kinds["0712345678"], "phone");
  assert.equal(kinds["26/10/26"], "date");
  assert.equal(kinds["2:30 PM"], "time");
  assert.equal(kinds["SJK3L9X2QW"], "ref");
  assert.equal(kinds["KES 15"], "amount");
  assert.equal(kinds["3"], "number");
  assert.equal(kinds["16%"], "number");
});

test("mask/restore round-trips exactly", () => {
  const { masked, entities } = maskEntities(SRC);
  const r = restoreEntities(masked, entities);
  assert.equal(r.text, SRC);
  assert.deepEqual([r.missing, r.duplicated, r.invented], [[], [], []]);
});

test("mask: a phone number or date is one entity, not split digit groups", () => {
  const { entities } = maskEntities("Call +254 700 000 555 or 0700-000-111 on 2026-10-26");
  assert.deepEqual(entities.map((e) => e.kind), ["phone", "phone", "date"]);
});

test("restore tolerates spacing/case damage to placeholders but reports dropped, duplicated, invented ones", () => {
  const { entities } = maskEntities("Paid Ksh500 on 26/10/26 ref AB12CD34EF");
  const r1 = restoreEntities("Ulilipa [ [ ea ] ] tarehe [[EB]] ref [[EC]]", entities);
  assert.equal(r1.text, "Ulilipa Ksh500 tarehe 26/10/26 ref AB12CD34EF");
  const r2 = restoreEntities("Ulilipa [[EA]] [[EA]] tarehe [[EI]]", entities);
  assert.deepEqual(r2.missing, [2, 3]);
  assert.deepEqual(r2.duplicated, [1]);
  assert.deepEqual(r2.invented, [9]);
  assert.ok(!r2.text.includes("[["));
});

test("verify: passes a faithful Swahili translation (reordered, separators changed)", () => {
  const v = verifyTranslation("Spent Ksh2,705 on 26/10/26 in 3 payments.", "Ulitumia Ksh2.705 tarehe 26/10/26 kwa malipo 3.");
  assert.deepEqual(v, { accepted: true, reasons: [] });
});

test("verify: fails when any source number is missing", () => {
  const v = verifyTranslation("Spent Ksh2,705 in 3 payments.", "Ulitumia Ksh2,705 kwa malipo.");
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.includes("number_missing:3"));
});

test("verify: fails when a number is invented, changed or duplicated", () => {
  assert.ok(verifyTranslation("Spent Ksh2,705.", "Ulitumia Ksh2,750.").reasons.some((r) => r.startsWith("number_invented")));
  assert.ok(verifyTranslation("Spent Ksh2,705.", "Ulitumia Ksh2,705 mara 2.").reasons.some((r) => r.startsWith("number_invented")));
  assert.ok(verifyTranslation("Paid Ksh500.", "Ulilipa Ksh500 na Ksh500.").reasons.some((r) => r.startsWith("number_invented")));
  assert.ok(verifyTranslation("Paid Ksh500 and Ksh500.", "Ulilipa Ksh500.").reasons.some((r) => r.startsWith("number_missing")));
  // date reformatted as a month name changes the digit multiset => caught
  assert.equal(verifyTranslation("On 26/10/26 you paid.", "Tarehe 26 Oktoba 2026 ulilipa.").accepted, false);
  // decimals: 500.00 equals 500 but 500.5 does not
  assert.equal(verifyTranslation("Ksh500.00", "Ksh500").accepted, true);
  assert.equal(verifyTranslation("Ksh500.00", "Ksh500.5").accepted, false);
  // leading zeros matter (phone numbers)
  assert.equal(verifyTranslation("Call 0712345678", "Piga 712345678").accepted, false);
});

test("verify: leftover placeholders, links, empty output, strict order", () => {
  assert.ok(verifyTranslation("Paid 5", "Ulilipa [[EA]]").reasons.includes("unrestored_placeholder"));
  assert.ok(verifyTranslation("Paid 5", "Ulilipa 5 tazama https://evil.example").reasons.includes("invented_link"));
  assert.equal(verifyTranslation("Paid 5", "   ").accepted, false);
  assert.equal(verifyTranslation("Paid 5", "Ulilipa 5 tazama www.evil.example").accepted, false);
  const swapped = verifyTranslation("Borrowed 300 repaid 500", "Ulirejesha 500 ulikopa 300", { strictOrder: true });
  assert.ok(swapped.reasons.includes("number_order_changed"));
  assert.equal(verifyTranslation("Borrowed 300 repaid 500", "Ulirejesha 500 ulikopa 300").accepted, true);
});

test("guardedTranslate: end to end; the model only ever sees placeholders", async () => {
  let seen = "";
  const ok = await guardedTranslate(SRC, async (masked) => { seen = masked; return masked.replace("You sent", "Ulituma").replace("to", "kwa"); });
  assert.equal(ok.verdict.accepted, true, ok.verdict.reasons.join());
  assert.match(ok.text!, /Ksh1,250\.50/);
  assert.doesNotMatch(seen, /\d/);
  assert.doesNotMatch(seen, /SJK3L9X2QW|0712345678/);
});

test("guardedTranslate: dropped placeholder, invented digits, thrown model are all rejected with null text", async () => {
  const dropped = await guardedTranslate(SRC, async (m) => m.replace("[[EA]]", ""));
  assert.equal(dropped.text, null);
  assert.ok(dropped.verdict.reasons.some((r) => r.startsWith("placeholder_missing")));
  const invented = await guardedTranslate("Paid Ksh500", async () => "Ulilipa Ksh900");
  assert.equal(invented.text, null);
  assert.ok(invented.verdict.reasons.some((r) => r.startsWith("number_invented")));
  const boom = await guardedTranslate("Paid Ksh500", async () => { throw new Error("worker aborted"); });
  assert.equal(boom.text, null);
  assert.match(boom.verdict.reasons[0]!, /translate_failed/);
  const empty = await guardedTranslate("Paid Ksh500", async () => "");
  assert.equal(empty.text, null);
});

test("guardedTranslate: model-inserted placeholder for a number that never existed is rejected", async () => {
  const r = await guardedTranslate("Paid Ksh500", async (m) => `${m} [[EG]]`);
  assert.equal(r.text, null);
  assert.ok(r.verdict.reasons.some((x) => x.startsWith("placeholder_invented")));
});

test("placeholder letter codec is bijective across the 26 -> 27 boundary", async () => {
  const { placeholderLetters, placeholderId } = await import("../src/ai/translate-guard.js");
  assert.deepEqual([1, 26, 27, 52, 53, 702, 703].map(placeholderLetters), ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  for (let i = 1; i < 2000; i++) assert.equal(placeholderId(placeholderLetters(i)), i);
  // 30 entities: restore must still be exact
  const src = Array.from({ length: 30 }, (_, i) => `Ksh${i + 100}`).join(" ");
  const { masked, entities } = maskEntities(src);
  assert.equal(entities.length, 30);
  assert.doesNotMatch(masked, /\d/);
  assert.equal(restoreEntities(masked, entities).text, src);
});
