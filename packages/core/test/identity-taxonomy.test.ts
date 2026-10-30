import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at, NOW } from "./fixtures.js";
import { inferIdentity } from "../src/profile/infer.js";
import { createLabel, createRole, listLabelsFull, listRolesFull, renameLabel, renameRole, setCounterpartyRole } from "../src/labels/store.js";

test("identity inference suggests salaried work from recurring salary evidence", () => {
  const db = fixtureDb(); const a = adapter(db);
  const hy = inferIdentity(a, NOW);
  assert.ok(hy.length > 0);
  assert.equal(hy[0]!.packId, "salaried_professional");
  assert.ok(hy[0]!.why.some((w) => /salary/i.test(w)));
  db.close();
});

test("labels and roles can be created, renamed and assigned without history loss", () => {
  const db = fixtureDb(); const a = adapter(db);
  const id = createLabel(a, "Church giving", "Expenses", NOW);
  assert.ok(id > 0);
  assert.equal(createLabel(a, "church giving", "Expenses", NOW), id, "case-insensitive duplicate returns the same label");
  renameLabel(a, id, "Church & giving");
  assert.ok(listLabelsFull(a).some((l) => l.id === id && l.name === "Church & giving" && l.isCustom));
  const roleId = createRole(a, "church", NOW);
  assert.ok(roleId > 0);
  renameRole(a, roleId, "church group");
  const cp = a.get(`SELECT id FROM counterparties LIMIT 1`) as { id: number };
  setCounterpartyRole(a, cp.id, roleId);
  assert.ok(listRolesFull(a).some((r) => r.id === roleId && r.name === "church group" && r.people === 1));
  db.close();
});
