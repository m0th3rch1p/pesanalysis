import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, utf8Bytes } from "../src/util/sha256.js";

const ref = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("sha256 matches node:crypto for ascii, unicode, emoji, and block boundaries", () => {
  const cases = [
    "",
    "a",
    "abc",
    "M-PESA",
    "QGH7X8Y2Z1 Confirmed. Ksh500.00 sent to JANE DOE 254712345678 on 25/10/26 at 9:41 AM.",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "x".repeat(1000),
    "Umetumia KES 3,200 kwa kula nje wiki hii — 40% zaidi ya kawaida yako.",
    "Malipo yamepokelewa ✅ kutoka kwa mteja",
    "😀🙂🇰🇪",
    "ascii + ünïcødé + 日本語 + русский",
  ];
  for (const c of cases) assert.equal(sha256Hex(c), ref(c), `case len=${c.length}`);
});

test("utf8Bytes encodes the same bytes node does", () => {
  for (const s of ["", "abc", "é", "日本語", "😀", "🇰🇪"]) {
    assert.deepEqual([...utf8Bytes(s)], [...Buffer.from(s, "utf8")]);
  }
});
