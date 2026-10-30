/**
 * Export YOUR OWN SMS from a USB/wifi-adb phone into data/private/sms.jsonl (gitignored).
 *   npm run sms:export                       # single device attached
 *   SERIAL=<adb-serial> npm run sms:export
 *   npm run sms:export -- --include-p2p      # ALSO include phone-number senders (other people's chats). Default: excluded.
 * Default keeps only financial sender families (core/src/sms/senders.ts) so third parties' private
 * messages never touch disk. Real data stays in data/private/. NEVER commit it, NEVER put it on video.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseContentQueryOutput, classifySender } from "../packages/core/src/index.ts";

const serial = process.env.SERIAL;
const includeP2p = process.argv.includes("--include-p2p");
const args = [...(serial ? ["-s", serial] : []), "shell", "content", "query", "--uri", "content://sms/inbox", "--projection", "address:date:body"];
const out = execFileSync("adb", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const rows = parseContentQueryOutput(out);
const kept = rows.filter((r) => includeP2p || classifySender(r.sender).financial);
const dir = new URL("../data/private/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("sms.jsonl", dir), kept.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
console.log(`read ${rows.length} messages, kept ${kept.length} (${includeP2p ? "incl. p2p" : "financial senders only"}) -> data/private/sms.jsonl`);
console.log("next: npm run coverage:private");
