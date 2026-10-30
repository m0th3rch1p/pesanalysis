import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PolicyManifest, ModelUse } from "../src/models/policy.js";

const manifest = JSON.parse(readFileSync(new URL("../src/models/policy.json", import.meta.url), "utf8")) as PolicyManifest;
const USES: ModelUse[] = ["inference", "finetuneTarget", "teacherLabelling", "redistributeAdapter", "commercial"];

test("policy manifest: every entry declares every use and valid permissions", () => {
  assert.equal(manifest.version, 1);
  const ids = new Set<string>();
  for (const e of manifest.entries) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    for (const u of USES) assert.ok(["allowed", "forbidden", "unverified"].includes(e.uses[u]), `${e.id}.${u}`);
    assert.ok(e.zones.length > 0, `${e.id} has no zones`);
  }
});

test("policy manifest: closed providers are forbidden as teachers (founder directive, D36)", () => {
  for (const id of ["anthropic-api", "openai-api"]) {
    const e = manifest.entries.find((x) => x.id === id);
    assert.ok(e, id);
    assert.equal(e.uses.teacherLabelling, "forbidden");
    assert.equal(e.uses.finetuneTarget, "forbidden");
  }
});

test("policy manifest: nothing is 'allowed' unless a shipped base or explicitly verified", () => {
  for (const e of manifest.entries) {
    for (const u of USES) {
      if (e.uses[u] === "allowed") assert.ok(e.shippedBase || e.verifiedAt, `${e.id}.${u} allowed without verification`);
    }
  }
});
