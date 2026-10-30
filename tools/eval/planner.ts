/**
 * S1 offline planner eval (rules router, no model).
 * The cases and exact semantic scorer are shared with the on-device S8 eval.
 * This checks measure, grouping, time and filter intent; it is not a private-data eval.
 */
import { PLANNER_EVAL_CASES, routeQuestion, scorePlannerCase, SEED_LABELS } from "../../packages/core/src/index.js";

const NOW = Date.UTC(2026, 9, 26, 9, 0);
const vocab = {
  labels: SEED_LABELS.map((l) => l.name),
  tags: ["Mama mboga"],
  counterparties: ["NAIVAS", "KPLC", "SHELL", "EMPLOYER"],
};

let exact = 0;
const misses: string[] = [];
for (const item of PLANNER_EVAL_CASES) {
  const r = routeQuestion(item.q, NOW, vocab);
  const score = scorePlannerCase(item, r.plan);
  if (r.ok && score.ok) exact++;
  else misses.push(`${item.q}\n  want ${item.measure} ${JSON.stringify(item.group ?? [])}${item.time ? " +time" : ""}${item.expect ? ` +${JSON.stringify(item.expect)}` : ""}\n  got  ${r.ok ? `${r.plan?.measure} ${JSON.stringify(r.plan?.groupBy ?? [])} ${JSON.stringify(r.plan?.filters ?? {})}` : `needs: ${r.needs?.question}`}\n  score ${score.reasons.join("; ")}`);
}
const pct = (exact / PLANNER_EVAL_CASES.length) * 100;
console.log(`S1 rules planner: ${exact}/${PLANNER_EVAL_CASES.length} exact = ${pct.toFixed(1)}%`);
for (const m of misses) console.log(`\nMISS ${m}`);
if (pct < 85) process.exitCode = 1;
