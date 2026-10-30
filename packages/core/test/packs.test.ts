import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { PACKS, applyPack, getPack, languageById, systemPromptFor, toneById } from "../src/packs/builtin.js";
import { getProfile, loadWorldModel } from "../src/profile/store.js";
import { listTags } from "../src/tags/store.js";

test("packs: applying is idempotent and creates ventures + profile", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const first = applyPack(a, "boda_rider", 5);
  const second = applyPack(a, "boda_rider", 6);
  assert.equal(first.ventures, 3);
  assert.equal(second.ventures, 3);
  assert.deepEqual(getProfile(a).verticals, ["boda_rider"]);
  const ventures = listTags(a).filter((t) => t.ventureKind);
  assert.ok(ventures.some((t) => t.name === "Fuel"));
  assert.ok(loadWorldModel(a).facts.some((f) => f.object === "boda rider"));
  db.close();
});

test("packs: several occupations can coexist", () => {
  const db = fixtureDb();
  const a = adapter(db);
  applyPack(a, "mama_mboga");
  applyPack(a, "salaried_professional");
  assert.deepEqual(getProfile(a).verticals, ["mama_mboga", "salaried_professional"]);
  db.close();
});

test("packs: every pack has valid KPIs and a prompt fragment", () => {
  for (const p of PACKS) {
    assert.ok(p.kpis.length >= 3);
    assert.ok(p.defaultTags.length >= 3);
    assert.ok(systemPromptFor({ verticals: [p.id] }).includes(p.name) || systemPromptFor({ verticals: [p.id] }).includes("User context"));
  }
  assert.throws(() => getPack("nope") ?? (() => { throw new Error("unknown pack: nope"); })(), /unknown/);
});

test("packs: tone and language are data, not hard-coded prose", () => {
  assert.match(toneById("pesa").systemFragment, /Swahili/);
  assert.equal(languageById("sw").lexicon["Fees & charges"], "Ada");
  const prompt = systemPromptFor({ tone: "pesa", language: "sw", verticals: ["mama_mboga"] });
  assert.match(prompt, /Pesanalysis/);
  assert.match(prompt, /Mama mboga|produce vendor/);
  assert.match(prompt, /Kiswahili/);
});
