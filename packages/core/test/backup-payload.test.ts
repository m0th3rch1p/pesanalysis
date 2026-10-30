import test from "node:test";
import assert from "node:assert/strict";
import {
  BackupError, KDF_LADDER, PAYLOAD_FORMAT, calibrateKdf, newestSnapshot, passphraseStrength, snapshotName, snapshotsToPrune, validatePayload,
} from "../src/index.js";

const opts = { allowedTables: ["transactions", "labels"], appSchemaVersion: 9 };
const good = (): any => ({ format: PAYLOAD_FORMAT, createdAt: 1, schemaVersion: 9, tables: { transactions: [{ id: 1, note: "x", n: null }] }, settings: [{ key: "a", value: "b" }] });

test("accepts a good payload", () => {
  const p = validatePayload(good(), opts);
  assert.equal(p.tables.transactions!.length, 1);
  assert.deepEqual(p.settings, [{ key: "a", value: "b" }]);
});
test("accepts legacy v1 as schema 0", () => {
  assert.equal(validatePayload({ ...good(), format: "pesanalysis-backup-v1", schemaVersion: undefined }, opts).schemaVersion, 0);
});
test("rejects newer schema with version code", () => {
  assert.throws(() => validatePayload({ ...good(), schemaVersion: 10 }, opts), (e: any) => e instanceof BackupError && e.code === "version");
});
const cases: Array<[string, unknown]> = [
  ["foreign format", { ...good(), format: "x" }],
  ["unknown table", { ...good(), tables: { sqlite_master: [] } }],
  ["injection table", { ...good(), tables: { "transactions; DROP TABLE x": [] } }],
  ["injection column", { ...good(), tables: { transactions: [{ "a) VALUES(1);--": 1 }] } }],
  ["object cell", { ...good(), tables: { transactions: [{ id: { a: 1 } }] } }],
  ["NaN cell", { ...good(), tables: { transactions: [{ id: NaN }] } }],
  ["non-list rows", { ...good(), tables: { transactions: {} } }],
  ["bad setting", { ...good(), settings: [{ key: 1, value: "x" }] }],
  ["not object", 5],
];
for (const [n, p] of cases) test(`rejects ${n}`, () => assert.throws(() => validatePayload(p, opts), BackupError));
test("row caps and reserved settings", () => {
  const p = { ...good(), tables: { transactions: [{ id: 1 }, { id: 2 }] }, settings: [{ key: "schema_version", value: "1" }, { key: "k", value: "v" }] };
  assert.throws(() => validatePayload(p, { ...opts, maxRows: 1 }), BackupError);
  assert.deepEqual(validatePayload(p, opts).settings, [{ key: "k", value: "v" }]);
});
test("booleans normalised", () => {
  assert.deepEqual(validatePayload({ ...good(), tables: { labels: [{ a: true }] } }, opts).tables.labels![0], { a: 1 });
});
test("calibrateKdf", async () => {
  assert.deepEqual((await calibrateKdf(async () => 2000)).kdf, KDF_LADDER[0]);
  assert.ok((await calibrateKdf(async () => 7000)).kdf.m < 19456);
  assert.deepEqual((await calibrateKdf(async () => 600_000)).kdf, { m: 8192, t: 3, p: 1 });
});
test("snapshot retention keeps newest 3, ignores foreign files", () => {
  const names = [1, 2, 3, 4, 5].map((i) => snapshotName(1_700_000_000_000 + i, "pre-reset"));
  assert.deepEqual(snapshotsToPrune([...names, "notes.txt", "manual.pesabak"], 3), [names[1], names[0]]);
  assert.equal(newestSnapshot(names), names[4]);
  assert.equal(newestSnapshot(["x"]), null);
});
test("passphraseStrength", () => {
  assert.equal(passphraseStrength("short").score, 0);
  assert.equal(passphraseStrength("password").score, 1);
  assert.equal(passphraseStrength("correct horse battery staple").score, 3);
});

test("accepts bounded base64 media and rejects traversal names", () => {
  const withMedia = { ...good(), media: [{ name: "12-1700000000000.jpg", data: "aGVsbG8=" }] };
  assert.equal(validatePayload(withMedia, opts).media?.[0]?.name, "12-1700000000000.jpg");
  for (const name of ["../x.jpg", "a/b.jpg", ".hidden"]) {
    assert.throws(() => validatePayload({ ...good(), media: [{ name, data: "aGVsbG8=" }] }, opts), BackupError);
  }
  assert.throws(() => validatePayload({ ...good(), media: [{ name: "x.jpg", data: "not base64!" }] }, opts), BackupError);
});
