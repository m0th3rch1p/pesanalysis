import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { parseSms } from "./parse.js";
import { auditBalanceChain } from "../ledger/balance-chain.js";
import type { ParsedSms } from "../types.js";

/**
 * Parser coverage on the PRIVATE export. Prints counts + structural fingerprints (no names/numbers).
 * Full unparsed bodies -> data/private/unparsed.jsonl (gitignored).
 *   npm run coverage:private
 *   npm run coverage:private -- --sender MPESA       # fingerprints for one sender
 */
const senderFilterIdx = process.argv.indexOf("--sender");
const senderFilter = senderFilterIdx >= 0 ? process.argv[senderFilterIdx + 1] : undefined;
const root = new URL("../../../../data/private/", import.meta.url);
const file = new URL("sms.jsonl", root);
if (!existsSync(file)) { console.error("Missing data/private/sms.jsonl. Run: npm run sms:export"); process.exit(1); }

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sender: string; body: string; receivedAt: number })
  .filter((r) => !senderFilter || r.sender.toLowerCase() === senderFilter.toLowerCase());
const bySender = new Map<string, { parsed: number; unparsed: number; notTx: number }>();
const fp = new Map<string, { n: number; sender: string }>();
const parsedByProvider = new Map<string, ParsedSms[]>();
const templates = new Map<string, number>();
const unparsed: unknown[] = [];

for (const r of rows) {
  const s = bySender.get(r.sender) ?? { parsed: 0, unparsed: 0, notTx: 0 };
  const o = parseSms(r);
  if (o.ok) {
    s.parsed++; templates.set(o.parsed.template, (templates.get(o.parsed.template) ?? 0) + 1);
    const arr = parsedByProvider.get(o.parsed.provider);
    if (arr) arr.push(o.parsed); else parsedByProvider.set(o.parsed.provider, [o.parsed]);
  } else if (o.reason === "no_template_match") {
    s.unparsed++; unparsed.push(r);
    const k = o.fingerprint!; const e = fp.get(k) ?? { n: 0, sender: r.sender }; e.n++; fp.set(k, e);
  } else s.notTx++;
  bySender.set(r.sender, s);
}
console.log(`\n== ${rows.length} messages${senderFilter ? ` (sender=${senderFilter})` : ""} ==`);
console.log("sender".padEnd(18), "parsed", "UNPARSED", "notTx");
for (const [k, v] of [...bySender].sort((a, b) => b[1].unparsed - a[1].unparsed)) console.log(k.padEnd(18), String(v.parsed).padStart(6), String(v.unparsed).padStart(8), String(v.notTx).padStart(6));
console.log("\n== templates hit =="); for (const [k, n] of templates) console.log(String(n).padStart(5), k);
console.log("\n== per-sender unparsed fingerprints (top 8 each) ==");
const bySenderFp = new Map<string, Array<[string, number]>>();
for (const [k, v] of fp) {
  const arr = bySenderFp.get(v.sender);
  if (arr) arr.push([k, v.n]); else bySenderFp.set(v.sender, [[k, v.n]]);
}
for (const [sender, list] of [...bySenderFp].sort((a, b) => a[0].localeCompare(b[0]))) {
  list.sort((a, b) => b[1] - a[1]);
  console.log(`\n-- [${sender}] (${list.reduce((t, x) => t + x[1], 0)} unparsed) --`);
  for (const [k, n] of list.slice(0, 8)) console.log(String(n).padStart(4), k);
}
console.log("\n== balance-chain audit (per provider, time-ordered) ==");
for (const [p, txs] of parsedByProvider) {
  txs.sort((a, b) => a.occurredAt - b.occurredAt);
  const res = auditBalanceChain(txs); const c: Record<string, number> = {};
  res.forEach((x) => (c[x.status] = (c[x.status] ?? 0) + 1));
  console.log(p.padEnd(14), JSON.stringify(c));
}
writeFileSync(new URL("unparsed.jsonl", root), unparsed.map((u) => JSON.stringify(u)).join("\n") + "\n");
console.log(`\nunparsed bodies written to data/private/unparsed.jsonl (gitignored)`);
