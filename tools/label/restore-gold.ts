/**
 * Builds the encrypted restore pack for WS3.5 from the private gold export.
 * Usage:
 *   PESAPACK_PASS='at least 8 chars' npx tsx tools/label/restore-gold.ts --out /tmp/gold.pesapack
 * Never prints message text or names. The file is written outside the repo by convention.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { encryptBackup } from "../../packages/core/src/backup/container.js";
import { LABEL_PACK_FORMAT, type LabelPackEvent } from "../../packages/core/src/backup/label-pack.js";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = opt("--out");
const goldPath = opt("--gold") ?? "data/private/gold.events.jsonl";
const pass = process.env.PESAPACK_PASS ?? opt("--pass");
if (!out) { console.error("missing --out"); process.exit(2); }
if (!pass || pass.length < 8) { console.error("set PESAPACK_PASS (min 8 characters)"); process.exit(2); }

interface Event {
  primarySmsRef?: string; primaryLabel?: string; rawLabels?: string[]; category?: string; detail?: string;
  funding?: { noticeRef?: string | null } | null;
}
const REF = /^[A-Z0-9]{6,32}$/;
const events: LabelPackEvent[] = [];
let skippedNoRef = 0, skippedNoCategory = 0, skippedInvalidRef = 0;
for (const line of readFileSync(goldPath, "utf8").trim().split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as Event;
  if (!e.primarySmsRef) { skippedNoRef++; continue; }
  if (!REF.test(e.primarySmsRef)) { skippedInvalidRef++; continue; }
  if (!e.category) { skippedNoCategory++; continue; }
  const items = (e.detail ?? "").split(/\s*(?:\+|,|;|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  events.push({
    ref: e.primarySmsRef,
    category: e.category,
    detail: e.detail ?? "",
    items,
    rawLabel: e.primaryLabel ?? e.category,
    rawLabels: e.rawLabels ?? [],
    fundingNoticeRef: e.funding?.noticeRef ?? null,
  });
}
async function main() {
  const payload = new TextEncoder().encode(JSON.stringify({
    format: LABEL_PACK_FORMAT, schemaVersion: 10, createdAt: Date.now(), events,
  }));
  const enc = await encryptBackup(payload, {
    passphrase: pass!,
    rng: (n) => randomBytes(n),
    app: "pesanalysis-label-pack",
    recovery: false,
    meta: { kind: "gold-label-pack", events: events.length },
  });
  writeFileSync(out!, enc.bytes);
  const sha = createHash("sha256").update(enc.bytes).digest("hex");
  console.log(JSON.stringify({ out, events: events.length, skippedNoRef, skippedInvalidRef, skippedNoCategory, bytes: enc.bytes.length, sha256: sha, encrypted: true }, null, 2));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
