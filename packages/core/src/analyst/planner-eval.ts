import type { QueryPlan } from "./plan.js";

/**
 * S1/S8 evaluation set: one hand-written question with the required semantic
 * plan fields. The same cases feed the Node rules eval and the on-device model
 * eval so both are measured against one source of truth.
 */
export interface PlannerEvalCase {
  q: string;
  measure: QueryPlan["measure"];
  group?: QueryPlan["groupBy"];
  time?: boolean;
  expect?: {
    labels?: string[];
    tags?: string[];
    counterparties?: string[];
    text?: string;
  };
}

export const PLANNER_EVAL_CASES: PlannerEvalCase[] = [
  { q: "How much did I spend this month?", measure: "spend", time: true },
  { q: "How much did I spend last month?", measure: "spend", time: true },
  { q: "How much income came in this month?", measure: "income", time: true },
  { q: "What is my net this month?", measure: "net", time: true },
  { q: "How much did I pay in fees this month?", measure: "fees", time: true },
  { q: "How many payments did I make this month?", measure: "count", time: true },
  { q: "What is my average spend last week?", measure: "avg", time: true },
  { q: "What was my largest payment this month?", measure: "max", time: true },
  { q: "Top merchants this month", measure: "spend", group: ["counterparty"], time: true },
  { q: "Top categories this month", measure: "spend", group: ["label"], time: true },
  { q: "Spending by category last month", measure: "spend", group: ["label"], time: true },
  { q: "Spending by week this year", measure: "spend", group: ["week"], time: true },
  { q: "Spending by month this year", measure: "spend", group: ["month"], time: true },
  { q: "Spending by provider this year", measure: "spend", group: ["provider"], time: true },
  { q: "Spending by scope this month", measure: "spend", group: ["scope"], time: true },
  { q: "Spending by hour last month", measure: "spend", group: ["hour"], time: true },
  { q: "Spending by weekday this year", measure: "spend", group: ["weekday"], time: true },
  { q: "Where did I spend this month?", measure: "spend", group: ["place"], time: true },
  { q: "Top 5 people I paid this month", measure: "spend", group: ["counterparty"], time: true },
  { q: "How much did I spend on fuel last month?", measure: "spend", time: true, expect: { labels: ["Fuel"] } },
  { q: "How much did I spend on groceries this month?", measure: "spend", time: true, expect: { labels: ["Groceries"] } },
  { q: "How much rent did I pay this month?", measure: "spend", time: true, expect: { labels: ["Rent"] } },
  { q: "How much did I pay for school fees this year?", measure: "spend", time: true, expect: { labels: ["School fees"] } },
  { q: "How much did I spend on health last month?", measure: "spend", time: true, expect: { labels: ["Health"] } },
  { q: "How much did I spend on entertainment this month?", measure: "spend", time: true, expect: { labels: ["Entertainment"] } },
  { q: "How much did I spend on airtime this month?", measure: "spend", time: true, expect: { labels: ["Airtime & data"] } },
  { q: "How much did I spend on utilities last month?", measure: "spend", time: true, expect: { labels: ["Utilities"] } },
  { q: "Income by category this month", measure: "income", group: ["label"], time: true },
  { q: "Income by month this year", measure: "income", group: ["month"], time: true },
  { q: "Fees by month this year", measure: "fees", group: ["month"], time: true },
  { q: "Count by merchant this month", measure: "count", group: ["counterparty"], time: true },
  { q: "Top 3 categories this month", measure: "spend", group: ["label"], time: true },
  { q: "Compare spending this month with last month", measure: "spend", time: true },
  { q: "How am I doing this month?", measure: "net", group: ["label"], time: true },
  { q: "Money in versus money out this month", measure: "net", time: true },
  { q: "How much did I spend in the last 30 days?", measure: "spend", time: true },
  { q: "How much did I spend in the last 90 days?", measure: "spend", time: true },
  { q: "How much did I spend today?", measure: "spend", time: true },
  { q: "How much did I spend yesterday?", measure: "spend", time: true },
  { q: "How much did I spend this week?", measure: "spend", time: true },
  { q: "How much did I spend last week?", measure: "spend", time: true },
  { q: "How much income did I get this year?", measure: "income", time: true },
  { q: "How much did I spend in September?", measure: "spend", time: true },
  { q: "Payments between 500 and 2000 this month", measure: "spend", time: true },
  { q: "Payments over 1000 this month", measure: "spend", time: true },
  { q: "Payments under 500 this month", measure: "spend", time: true },
  { q: "How much did I spend at Naivas this month?", measure: "spend", time: true, expect: { counterparties: ["NAIVAS"] } },
  { q: "How much did I spend at KPLC this month?", measure: "spend", time: true, expect: { counterparties: ["KPLC"] } },
  { q: "How much did I receive from my employer this year?", measure: "income", time: true, expect: { counterparties: ["EMPLOYER"] } },
  { q: "Spending tagged Mama mboga this month", measure: "spend", time: true, expect: { tags: ["Mama mboga"] } },
  { q: "How are my ventures doing this month?", measure: "spend", group: ["venture"], time: true },
  { q: "Business versus personal spending this month", measure: "spend", group: ["scope"], time: true },
  { q: "How much did I pay KPLC in fees this month?", measure: "fees", time: true, expect: { counterparties: ["KPLC"] } },
  { q: "Biggest payment this month", measure: "max", time: true },
  { q: "Average payment this month", measure: "avg", time: true },
  { q: "Share of fees this month", measure: "share", time: true },
  { q: "How many transactions last month?", measure: "count", time: true },
  { q: "Spending by role this year", measure: "spend", group: ["role"], time: true },
  { q: "How much did I save this month?", measure: "net", time: true },
  { q: "How many payments did I make this week?", measure: "count", time: true },
];

/** Exact semantic score, independent of JSON formatting or extra harmless fields. */
export function scorePlannerCase(c: PlannerEvalCase, plan: QueryPlan | null | undefined): { ok: boolean; reasons: string[] } {
  if (!plan) return { ok: false, reasons: ["no valid plan"] };
  const reasons: string[] = [];
  if (plan.measure !== c.measure) reasons.push(`measure ${plan.measure} != ${c.measure}`);
  const gotGroup = plan.groupBy ?? [];
  const wantGroup = c.group ?? [];
  if (JSON.stringify(gotGroup) !== JSON.stringify(wantGroup)) reasons.push(`group ${JSON.stringify(gotGroup)} != ${JSON.stringify(wantGroup)}`);
  const gotTime = !!plan.filters?.time;
  const wantTime = !!c.time;
  if (gotTime !== wantTime) reasons.push(`time ${gotTime} != ${wantTime}`);
  const f = plan.filters ?? {};
  for (const label of c.expect?.labels ?? []) if (!(f.labels ?? []).includes(label)) reasons.push(`missing label ${label}`);
  for (const tag of c.expect?.tags ?? []) if (!(f.tags ?? []).includes(tag)) reasons.push(`missing tag ${tag}`);
  for (const counterparty of c.expect?.counterparties ?? []) if (!(f.counterparties ?? []).includes(counterparty)) reasons.push(`missing counterparty ${counterparty}`);
  if (c.expect?.text && !(f.text ?? "").toLowerCase().includes(c.expect.text.toLowerCase())) reasons.push(`missing text ${c.expect.text}`);
  return { ok: reasons.length === 0, reasons };
}
