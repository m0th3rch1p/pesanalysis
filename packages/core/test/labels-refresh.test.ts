import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { refreshPendingLabelSuggestions } from "../src/labels/refresh.js";

test("stale cross-class suggestions are removed on refresh (WS0.3)", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = db.prepare("INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES ('t:247247','EQUITY PAYBILL ACCOUNT','[]',1)").run();
  const cpId = Number(cp.lastInsertRowid);
  const airtime = db.prepare("SELECT id FROM labels WHERE name='Airtime & data'").get() as { id: number };
  const tx = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','paybill','out',10800,?,1792696920000,'mpesa.paybill','1','pending','transaction')`).run(cpId);
  const txId = Number(tx.lastInsertRowid);
  db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at) VALUES (?,?,'knn',0.66,1)").run(txId, airtime.id);

  refreshPendingLabelSuggestions(a);
  const left = db.prepare("SELECT l.name FROM tx_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.tx_id=? AND tl.confirmed_at IS NULL").all(txId) as Array<{ name: string }>;
  assert.equal(left.length, 0, JSON.stringify(left));
  db.close();
});

test("refresh keeps a valid suggestion and never touches confirmed labels", () => {
  const db = fixtureDb(); const a = adapter(db);
  const cp = db.prepare("SELECT id FROM counterparties WHERE display_name='NAIVAS'").get() as { id: number };
  const groceries = db.prepare("SELECT id FROM labels WHERE name='Groceries'").get() as { id: number };
  const tx = db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','till','out',30000,?,1792696920000,'mpesa.till','1','pending','transaction')`).run(cp.id);
  const txId = Number(tx.lastInsertRowid);
  db.prepare("INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at) VALUES (?,?,'knn',0.6,1)").run(txId, groceries.id);
  refreshPendingLabelSuggestions(a);
  const row = db.prepare("SELECT source, confirmed_at FROM tx_labels WHERE tx_id=? AND label_id=?").get(txId, groceries.id) as { source: string; confirmed_at: number | null };
  assert.equal(row.confirmed_at, null);
  assert.ok(["knn", "rule"].includes(row.source), row.source);
  db.close();
});
