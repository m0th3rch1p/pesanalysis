import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContentQueryOutput } from "../src/index.ts";

test("parses multi-row adb output with newlines and commas in bodies", () => {
  const out = "Row: 0 address=MPESA, date=1792932621401, body=TJ1 Confirmed. Ksh1,000.00 sent\nto X, ok\r\nRow: 1 address=Safaricom, date=1792931983418, body=Hello\n";
  const r = parseContentQueryOutput(out);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.sender, "MPESA"); assert.equal(r[0]!.receivedAt, 1792932621401);
  assert.match(r[0]!.body, /Ksh1,000\.00 sent\nto X, ok/);
  assert.equal(r[1]!.body, "Hello");
});
