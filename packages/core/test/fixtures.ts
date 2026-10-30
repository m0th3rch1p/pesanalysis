import { DatabaseSync } from "node:sqlite";
import { migrate, seedTaxonomy, type DbAdapter } from "../src/db/migrate.js";

export function adapter(db: DatabaseSync): DbAdapter {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(...((params ?? []) as never[])),
    get: (sql, params) => db.prepare(sql).get(...((params ?? []) as never[])),
    all: (sql, params) => db.prepare(sql).all(...((params ?? []) as never[])),
  };
}

export const NOW = Date.UTC(2026, 9, 26, 9, 0); // 26 Oct 2026 12:00 EAT
export const at = (y: number, m: number, d: number, h = 10) => Date.UTC(y, m - 1, d, h) - 3 * 3_600_000;

/** Deterministic ledger used by plan/ask/search/tag tests. */
export function fixtureDb() {
  const db = new DatabaseSync(":memory:");
  migrate(adapter(db));
  seedTaxonomy(adapter(db), 1);
  const cp = (name: string) => {
    db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)").run(`n:${name.toLowerCase()}`, name, JSON.stringify([]), 1);
    return (db.prepare("SELECT id FROM counterparties WHERE key = ?").get(`n:${name.toLowerCase()}`) as { id: number }).id;
  };
  const naivas = cp("NAIVAS");
  const kplc = cp("KPLC");
  const shell = cp("SHELL");
  const employer = cp("EMPLOYER");
  const label = (name: string) => (db.prepare("SELECT id FROM labels WHERE name = ?").get(name) as { id: number }).id;
  let id = 0;
  const tx = (cpId: number, amount: number, dir: "in" | "out", when: number, labelName: string, opts: { fee?: number; kind?: string; template?: string } = {}) => {
    db.prepare(`INSERT INTO transactions
      (id, provider, kind, direction, amount, fee, counterparty_id, occurred_at, template, parser_version, chain_status, status, role)
      VALUES (?, 'mpesa', ?, ?, ?, ?, ?, ?, ?, '1', 'ok', 'confirmed', 'transaction')`)
      .run(++id, opts.kind ?? (dir === "in" ? "receive" : "till"), dir, amount, opts.fee ?? 0, cpId, when, opts.template ?? "mpesa.till");
    db.prepare("INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at) VALUES (?,?, 'user', 1, ?, ?)").run(id, label(labelName), when, when);
    return id;
  };
  tx(naivas, 100_000, "out", at(2026, 10, 5), "Groceries");
  tx(naivas, 200_000, "out", at(2026, 10, 6), "Groceries");
  tx(kplc, 50_000, "out", at(2026, 10, 7), "Utilities", { fee: 1_500, kind: "paybill" });
  tx(employer, 1_000_000, "in", at(2026, 10, 1), "Salary", { kind: "receive" });
  tx(shell, 300_000, "out", at(2026, 9, 15), "Fuel", { fee: 2_000 });
  db.prepare("INSERT INTO tags (name, kind, created_at) VALUES ('Mama mboga', 'venture', 1)").run();
  db.prepare("INSERT INTO ventures (name, kind, tag_id, status, opened_at) VALUES ('Mama mboga', 'business', 1, 'active', 1)").run();
  db.prepare("INSERT INTO tx_tags (tx_id, tag_id, source, created_at) VALUES (1, 1, 'user', 1), (2, 1, 'user', 1)").run();
  db.prepare("INSERT INTO tx_notes (tx_id, kind, text, created_at) VALUES (2, 'note', 'kale and tomatoes', 1)").run();
  return db;
}
