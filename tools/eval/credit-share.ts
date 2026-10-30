/** WS5.5 acceptance on the private gold export: aggregates only. */
import { readFileSync } from "node:fs";
interface E { direction: string; category: string; funding?: { source?: string } | null }
const events = readFileSync(process.argv[2] ?? "data/private/gold.events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as E);
const out = events.filter((e) => e.direction === "out");
const credit = out.filter((e) => !!e.funding);
const grocery = out.filter((e) => e.category === "Groceries");
const groceryCredit = grocery.filter((e) => !!e.funding);
const pct = (n: number, d: number) => d ? +(n / d).toFixed(3) : 0;
console.log(JSON.stringify({
  outflows: out.length, creditFunded: credit.length, share: pct(credit.length, out.length),
  groceries: grocery.length, groceryCreditFunded: groceryCredit.length, groceryShare: pct(groceryCredit.length, grocery.length),
  bySource: credit.reduce((m, e) => { const s = e.funding?.source ?? "unknown"; m[s] = (m[s] ?? 0) + 1; return m; }, {} as Record<string, number>),
}, null, 2));
