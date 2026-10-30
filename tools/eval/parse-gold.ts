/**
 * Note-parser acceptance (WS3.4). Reads the founder's gold export locally and prints
 * aggregate agreement only. Never writes or prints message text.
 *   npx tsx tools/eval/parse-gold.ts [data/private/gold.events.jsonl]
 */
import { readFileSync } from "node:fs";
import { parseNote } from "../../packages/core/src/items/parse.js";

interface Event {
  amount: number; direction: "in" | "out" | "neutral"; kind: string; category: string;
  primaryLabel?: string; rawLabels?: string[]; detail?: string;
  counterparty?: { name?: string };
}
const path = process.argv[2] ?? "data/private/gold.events.jsonl";
const events = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event);
// Emulate the user lexicon learned from prior confirmations (token -> category).
const votes = new Map<string, Map<string, number>>();
for (const e of events) {
  for (const w of (e.detail ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const m = votes.get(w) ?? new Map<string, number>();
    m.set(e.category, (m.get(e.category) ?? 0) + 1);
    votes.set(w, m);
  }
}
const lexicon: Record<string, string> = {};
for (const [w, m] of votes) {
  const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (best[1] / [...m.values()].reduce((a, b) => a + b, 0) >= 0.8) lexicon[w] = best[0];
}
let compared = 0, categoryOk = 0, itemNotes = 0, itemExtracted = 0;
const misses: Array<{ label: string; gold: string; got: string | null; items: number }> = [];
for (const e of events) {
  const label = e.primaryLabel?.trim();
  if (!label) continue;
  compared++;
  const parsed = parseNote(label, {
    direction: e.direction, txAmountCents: e.amount,
    interpretCtx: { direction: e.direction, kind: e.kind, counterpartyName: e.counterparty?.name },
    lexicon,
  });
  if (parsed.category === e.category) categoryOk++;
  else misses.push({ label, gold: e.category, got: parsed.category, items: parsed.items.length });
  if (/^(shop|supermarket|food)[-\s]/i.test(label)) {
    itemNotes++;
    if (parsed.items.length > 0) itemExtracted++;
  }
}
console.log(JSON.stringify({
  events: events.length, compared,
  categoryAccuracy: compared ? +(categoryOk / compared).toFixed(3) : 0,
  itemNotes, itemExtracted,
  itemCoverage: itemNotes ? +(itemExtracted / itemNotes).toFixed(3) : 0,
  misses: misses.slice(0, 12),
}, null, 2));
