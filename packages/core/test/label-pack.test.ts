import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { encryptBackup, decryptBackup } from "../src/backup/container.js";
import { applyLabelPack, decodeLabelPack, LABEL_PACK_FORMAT } from "../src/backup/label-pack.js";

test("label pack: encrypted, decrypted, decoded and idempotent", async () => {
  const db = fixtureDb(); const a = adapter(db);
  db.prepare(`UPDATE transactions SET ref = 'UABC123XYZ' WHERE id = 1`).run();
  const pack = decodeLabelPack({
    format: LABEL_PACK_FORMAT, schemaVersion: 10, createdAt: 1,
    events: [{
      ref: "UABC123XYZ", category: "Pets", detail: "dog food", items: ["dog food"],
      rawLabel: "pets-dog food", rawLabels: ["pets-dog food"], fundingNoticeRef: null,
    }, {
      ref: "UNOTFOUND1", category: "Groceries", detail: "", items: [], rawLabel: "shop",
      rawLabels: ["shop"], fundingNoticeRef: null,
    }],
  });
  const preview = applyLabelPack(a, pack, { dryRun: true });
  assert.deepEqual([preview.events, preview.matched, preview.notFound, preview.items], [2, 1, 1, 1]);
  const r1 = applyLabelPack(a, pack);
  assert.equal(r1.applied, 1);
  const label = db.prepare(`SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = 1 AND tl.confirmed_at IS NOT NULL`).get() as { name: string };
  assert.equal(label.name, "Pets");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tx_items WHERE tx_id = 1 AND source = 'gold'`).get() as { n: number }).n, 1);
  const note = db.prepare(`SELECT text FROM tx_notes WHERE tx_id = 1 AND kind = 'text'`).get() as { text: string };
  assert.equal(note.text, "pets-dog food");
  const r2 = applyLabelPack(a, pack);
  assert.equal(r2.applied, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tx_items WHERE tx_id = 1 AND source = 'gold'`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tx_notes WHERE tx_id = 1 AND kind = 'text'`).get() as { n: number }).n, 1);

  let seed = 1;
  const rng = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 16807) % 2147483647) & 255);
  const plain = new TextEncoder().encode(JSON.stringify({ format: LABEL_PACK_FORMAT, schemaVersion: 10, createdAt: 1, events: pack.events }));
  const enc = await encryptBackup(plain, { passphrase: "correct horse", rng, recovery: false });
  const dec = await decryptBackup(enc.bytes, { passphrase: "correct horse" });
  assert.equal(new TextDecoder().decode(dec), new TextDecoder().decode(plain));
  await assert.rejects(() => decryptBackup(enc.bytes, { passphrase: "wrong pass" }));
  db.close();
});
