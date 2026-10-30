/** Offline gate for Ask stage 1 (WS8.4). Synthetic questions only; no ledger and no network. */
import { readFileSync } from "node:fs";
import { routeQuestion } from "../../packages/core/src/analyst/router.js";
import { SEED_LABELS } from "../../packages/core/src/labels/taxonomy.js";

interface Case {
  q: string;
  ok?: boolean;
  measure?: string;
  time?: unknown;
  labels?: string[];
  items?: string[];
  habits?: string[];
  funding?: string;
  hourWindow?: { startMin: number; endMin: number };
  weekdays?: number[];
  group?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  text?: string;
}

const NOW = Date.UTC(2026, 9, 30, 9, 0);
const vocab = {
  labels: SEED_LABELS.map((l) => l.name),
  items: ["cigarette", "bread", "milk", "sugar", "flour", "egg", "tomato", "chapo", "snack", "soda", "kale"],
  habits: ["takeaway", "late-night food", "cigarettes"],
  counterparties: ["NAIVAS", "KPLC", "SHELL", "Mama Mboga"],
};
const cases = readFileSync(new URL("./ask-heldout.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const misses: string[] = [];
let passed = 0;

for (const c of cases) {
  const r = routeQuestion(c.q, NOW, vocab);
  const why: string[] = [];
  if (c.ok === false) {
    if (r.ok) why.push(`expected clarification, got ${r.plan?.measure}`);
    if (r.ok) misses.push(`${c.q} :: expected clarification`), 0;
    if (!r.ok) passed++;
    continue;
  }
  if (!r.ok) { misses.push(`${c.q} :: no plan`); continue; }
  const p = r.plan!;
  if (p.measure !== c.measure) why.push(`measure ${p.measure} != ${c.measure}`);
  if (c.time !== undefined && !same(p.filters?.time, c.time)) why.push(`time ${JSON.stringify(p.filters?.time)} != ${JSON.stringify(c.time)}`);
  for (const l of c.labels ?? []) if (!(p.filters?.labels ?? []).includes(l)) why.push(`missing label ${l}`);
  for (const i of c.items ?? []) if (!(p.filters?.items ?? []).includes(i)) why.push(`missing item ${i}`);
  for (const h of c.habits ?? []) if (!(p.filters?.habits ?? []).includes(h)) why.push(`missing habit ${h}`);
  if (c.funding !== undefined && p.filters?.funding !== c.funding) why.push(`funding ${p.filters?.funding} != ${c.funding}`);
  if (c.hourWindow !== undefined && !same(p.filters?.hourWindow, c.hourWindow)) why.push(`hourWindow ${JSON.stringify(p.filters?.hourWindow)} != ${JSON.stringify(c.hourWindow)}`);
  if (c.weekdays !== undefined && !same(p.filters?.weekdays, c.weekdays)) why.push(`weekdays ${JSON.stringify(p.filters?.weekdays)} != ${JSON.stringify(c.weekdays)}`);
  if (c.group !== undefined && p.groupBy?.[0] !== c.group) why.push(`group ${JSON.stringify(p.groupBy)} != ${c.group}`);
  if (c.minAmountCents !== undefined && p.filters?.minAmountCents !== c.minAmountCents) why.push(`min ${p.filters?.minAmountCents} != ${c.minAmountCents}`);
  if (c.maxAmountCents !== undefined && p.filters?.maxAmountCents !== c.maxAmountCents) why.push(`max ${p.filters?.maxAmountCents} != ${c.maxAmountCents}`);
  if (c.text === undefined && p.filters?.text !== undefined) why.push(`unexpected text "${p.filters.text}"`);
  if (c.text !== undefined && p.filters?.text !== c.text) why.push(`text ${JSON.stringify(p.filters?.text)} != ${JSON.stringify(c.text)}`);
  if (why.length) misses.push(`${c.q} :: ${why.join("; ")}`);
  else passed++;
}

const total = cases.length;
const rate = passed / total;
console.log(`ask-heldout: ${passed}/${total} = ${(rate * 100).toFixed(1)}%`);
for (const m of misses.slice(0, 40)) console.log(`  ✖ ${m}`);
if (misses.length > 40) console.log(`  … ${misses.length - 40} more`);
process.exitCode = rate >= 0.9 ? 0 : 1;
