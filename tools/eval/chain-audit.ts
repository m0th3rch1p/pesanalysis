/**
 * Offline balance-chain recheck (WS4.2). Reads the private SMS export locally and prints
 * aggregate counts only. No message text, names or numbers are printed.
 *   npx tsx tools/eval/chain-audit.ts [data/private/sms.jsonl]
 */
import { readFileSync } from "node:fs";
import { parseSms } from "../../packages/core/src/sms/parse.js";
import { auditBalanceChain, balanceEffect } from "../../packages/core/src/ledger/balance-chain.js";
import type { ParsedSms } from "../../packages/core/src/types.js";

interface Raw { sender: string; receivedAt: number; body: string }
const path = process.argv[2] ?? "data/private/sms.jsonl";
const raws = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Raw);
const parsed: ParsedSms[] = [];
for (const r of raws) {
  try { const o = parseSms({ sender: r.sender, body: r.body, receivedAt: r.receivedAt }); if (o.ok) parsed.push(o.parsed); } catch { /* skip */ }
}
parsed.sort((a, b) => a.occurredAt - b.occurredAt);
const results = auditBalanceChain(parsed);
let fuliza = 0, opposite = 0, airtel = 0, unexplained = 0;
const unexplainedByD = new Map<number, number>();
const unexplainedByKind = new Map<string, number>();
const suppress = new Set<number>();
for (let i = 0; i < results.length; i++) {
  const r = results[i]!;
  if (r.status !== "break" || suppress.has(i)) continue;
  const p = parsed[i]!;
  const d = Math.abs(r.discrepancy);
  if (p.provider === "airtel_money" && (p.kind === "airtime" || p.kind === "bundle")) { airtel++; continue; }
  const loans = parsed.filter((x) => x.provider === p.provider && x.balanceAfter == null && (x.kind === "loan_draw" || x.kind === "loan_repay")
    && Math.abs(x.occurredAt - p.occurredAt) <= 300_000);
  const effects = loans.map((x) => x.kind === "loan_draw" ? (x.provider === "mpesa" ? x.amount : 0) : -(x.amount + (x.fee ?? 0))).filter((n) => n !== 0);
  let found = false;
  for (let mask = 1; mask < (1 << Math.min(effects.length, 12)) && !found; mask++) {
    let sum = 0;
    for (let k = 0; k < Math.min(effects.length, 12); k++) if (mask & (1 << k)) sum += effects[k]!;
    if (Math.abs(Math.abs(sum) - d) <= 1) found = true;
  }
  if (found) { fuliza++; continue; }
  let pair = false;
  for (let j = 0; j < results.length && !pair; j++) {
    if (j === i || results[j]!.status !== "break") continue;
    if (Math.abs(parsed[j]!.occurredAt - p.occurredAt) <= 1_800_000 && Math.abs(results[j]!.discrepancy + r.discrepancy) <= 1) {
      pair = true; suppress.add(i); suppress.add(j);
    }
  }
  if (pair) { opposite++; continue; }
  unexplained++;
  unexplainedByD.set(d, (unexplainedByD.get(d) ?? 0) + 1);
  const key = `${p.provider}:${p.kind}:${p.template}`;
  unexplainedByKind.set(key, (unexplainedByKind.get(key) ?? 0) + 1);
}
console.log(JSON.stringify({
  messages: raws.length, parsed: parsed.length,
  chain: { ok: results.filter((r) => r.status === "ok").length, break: results.filter((r) => r.status === "break").length },
  suppressed: { fuliza_reorder: fuliza, opposite_pair: opposite, airtel_model: airtel },
  prominent: unexplained,
  topDiscrepanciesKes: [...unexplainedByD.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => ({ kes: d / 100, n })),
  unexplainedByKind: [...unexplainedByKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ kind: k, n })),
}, null, 2));
