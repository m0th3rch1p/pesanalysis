import test from "node:test";
import assert from "node:assert/strict";
import { adapter, at, fixtureDb, NOW } from "./fixtures.js";
import { allQuestions, answerQuestion, dismissQuestion, generateQuestions, pendingQuestions } from "../src/questions/service.js";

test("questions: frequent unknown counterparties are asked about, ranked by money", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const qs = generateQuestions(a, NOW);
  assert.ok(qs.length > 0);
  const naivas = qs.find((q) => q.prompt.includes("NAIVAS"));
  assert.ok(naivas);
  assert.equal(naivas!.kind, "unknown_role");
  assert.ok(naivas!.why.includes("Ksh3,000"));
  assert.ok(naivas!.options!.includes("supplier"));
  assert.ok(qs.every((q) => q.why.length > 0));
  db.close();
});

test("questions: answering a role updates the counterparty and writes a fact", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const q = generateQuestions(a, NOW).find((x) => x.prompt.includes("NAIVAS"))!;
  const r = answerQuestion(a, q.id, "supplier", NOW);
  assert.ok(r.ok);
  const role = db.prepare(`SELECT r.name FROM counterparties c JOIN roles r ON r.id = c.role_id WHERE c.display_name = 'NAIVAS'`).get() as { name: string };
  assert.equal(role.name, "supplier");
  const fact = db.prepare(`SELECT object FROM facts WHERE subject = 'cp:1' AND predicate = 'role'`).get() as { object: string };
  assert.equal(fact.object, "supplier");
  assert.equal(pendingQuestions(a).find((x) => x.id === q.id), undefined);
  db.close();
});

test("questions: dismiss suppresses re-asking for 14 days only", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const q = generateQuestions(a, NOW).find((x) => x.prompt.includes("NAIVAS"))!;
  dismissQuestion(a, q.id, NOW);
  assert.equal(generateQuestions(a, NOW + 86_400_000).find((x) => x.id === q.id), undefined);
  assert.ok(generateQuestions(a, NOW + 15 * 86_400_000).find((x) => x.id === q.id));
  db.close();
});

test("questions: pending large payment can be filed from the queue", () => {
  const db = fixtureDb();
  const a = adapter(db);
  db.exec(`UPDATE transactions SET status = 'pending' WHERE id = 5`);
  const q = generateQuestions(a, NOW).find((x) => x.kind === "pending_label");
  assert.ok(q);
  assert.match(q!.prompt, /Ksh3,000/);
  const r = answerQuestion(a, q!.id, "Fuel", NOW);
  assert.ok(r.ok, r.applied);
  const row = db.prepare(`SELECT t.status, l.name AS label FROM transactions t JOIN tx_labels tl ON tl.tx_id=t.id JOIN labels l ON l.id=tl.label_id WHERE t.id=5 AND tl.confirmed_at IS NOT NULL`).get() as { status: string; label: string };
  assert.equal(row.status, "confirmed");
  assert.equal(row.label, "Fuel");
  db.close();
});

test("questions: accepting a cluster creates a venture and tags history", () => {
  const db = fixtureDb();
  const a = adapter(db);
  db.prepare("UPDATE counterparties SET key = 't:555000' WHERE display_name = 'SHELL'").run();
  const cp = (db.prepare("SELECT id FROM counterparties WHERE display_name='SHELL'").get() as { id: number }).id;
  for (const d of [10, 12]) {
    db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,fee,counterparty_id,occurred_at,template,parser_version,chain_status,status,role)
      VALUES ('mpesa','till','out',120000,0,?,?,'mpesa.till','1','ok','confirmed','transaction')`).run(cp, at(2026, 10, d));
  }
  const q = generateQuestions(a, NOW).find((x) => x.kind === "untagged_cluster" && x.prompt.includes("SHELL"));
  assert.ok(q, JSON.stringify(allQuestions(a)));
  const r = answerQuestion(a, q!.id, "Yes, track it", NOW);
  assert.ok(r.ok, r.applied);
  const v = db.prepare(`SELECT COUNT(*) AS n FROM tx_tags tt JOIN tags tg ON tg.id=tt.tag_id WHERE tg.name='SHELL'`).get() as { n: number };
  assert.equal(v.n, 3);
  db.close();
});


test("questions: one role question per person across spelling variants, answer reaches both (WS0.4)", () => {
  const db = fixtureDb();
  const a = adapter(db);
  const cp = (key: string, name: string) => {
    db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)").run(key, name, JSON.stringify([name]), 1);
    return (db.prepare("SELECT id FROM counterparties WHERE key = ?").get(key) as { id: number }).id;
  };
  const lower = cp("n:alex kamau", "alex kamau");
  const upper = cp("n:ALEX KAMAU", "ALEX KAMAU");
  const tx = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','send','out',5000,?,?,'mpesa.send','1','confirmed','transaction')`);
  tx.run(lower, at(2026, 10, 20)); tx.run(lower, at(2026, 10, 21));
  tx.run(upper, at(2026, 10, 22)); tx.run(upper, at(2026, 10, 23));
  const qs = generateQuestions(a, NOW).filter((q) => /alex kamau/i.test(q.prompt));
  assert.equal(qs.length, 1, "same person must be asked once");
  const r = answerQuestion(a, qs[0]!.id, "friend", NOW);
  assert.ok(r.ok, r.applied);
  const roles = db.prepare(`SELECT r.name FROM counterparties c JOIN roles r ON r.id=c.role_id WHERE c.id IN (?,?)`).all(lower, upper) as Array<{ name: string }>;
  assert.equal(roles.length, 2);
  assert.ok(roles.every((x) => x.name === "friend"));
  db.close();
});
