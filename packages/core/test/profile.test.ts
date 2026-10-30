import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { factsFor, getProfile, loadWorldModel, recordFact, setProfile, worldModelPrompt } from "../src/profile/store.js";

test("profile: set/get verticals, tone and language", () => {
  const db = fixtureDb();
  const a = adapter(db);
  assert.deepEqual(getProfile(a).verticals, []);
  setProfile(a, { verticals: ["mama_mboga"], tone: "pesa", language: "sw", name: "Wanjiku" }, 5);
  const p = getProfile(a);
  assert.deepEqual(p.verticals, ["mama_mboga"]);
  assert.equal(p.tone, "pesa");
  assert.equal(p.name, "Wanjiku");
  db.close();
});

test("facts: upsert is idempotent and evidence survives", () => {
  const db = fixtureDb();
  const a = adapter(db);
  recordFact(a, "user", "business", "vegetable stall", { confidence: 0.9, evidence: { askedAt: 1 } });
  recordFact(a, "user", "business", "vegetable stall", { confidence: 1 });
  const facts = factsFor(a, "user");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.confidence, 1);
  db.close();
});

test("world model prompt includes confirmed context and no raw SMS", () => {
  const db = fixtureDb();
  const a = adapter(db);
  setProfile(a, { verticals: ["mama_mboga"], tone: "plain", language: "en", name: "Wanjiku" });
  recordFact(a, "user", "sells", "vegetables");
  db.prepare("UPDATE counterparties SET role_id = (SELECT id FROM roles WHERE name='supplier') WHERE display_name='NAIVAS'").run();
  const w = loadWorldModel(a);
  assert.ok(w.ventures.some((v) => v.name === "Mama mboga"));
  const prompt = worldModelPrompt(a);
  assert.match(prompt, /Wanjiku/);
  assert.match(prompt, /Mama mboga/);
  assert.match(prompt, /NAIVAS/);
  assert.doesNotMatch(prompt, /Confirmed\. Ksh/);
  db.close();
});
