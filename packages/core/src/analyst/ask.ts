/**
 * Ask pipeline: question -> deterministic router -> validated plan -> read-only SQL -> prose.
 * The model is optional and never trusted with SQL. Used by the Ask UI and by the Z1 tool server.
 */
import type { DbAdapter } from "../db/migrate.js";
import { compileEvidence, compilePlan, resolveRange, validatePlan, type EvidenceRow, type QueryPlan } from "./plan.js";
import { routeQuestion, type RouteResult } from "./router.js";
import { composeAnswer, composeSummary, type AnswerBundle, type PlanRow } from "./answer.js";

export interface AskContext {
  db: DbAdapter;
  now?: number;
  labels?: string[];
  tags?: string[];
  counterparties?: string[];
  items?: string[];
  habits?: string[];
}

export interface AskResult {
  ok: boolean;
  source: "rules" | "plan";
  question: string;
  plan?: QueryPlan;
  provenance: string;
  sql?: string;
  params?: (string | number)[];
  rows?: PlanRow[];
  evidence?: EvidenceRow[];
  matches?: number;
  comparisonRows?: PlanRow[] | null;
  answer?: AnswerBundle;
  needs?: RouteResult["needs"];
  error?: string;
}

export interface ExecutedPlan {
  rows: PlanRow[];
  comparisonRows: PlanRow[] | null;
  range: ReturnType<typeof resolveRange>;
  sql: string;
  params: (string | number)[];
  comparisonSql?: string;
  comparisonParams?: (string | number)[];
}

function mapRows(rows: any[], dims: number): PlanRow[] {
  return rows.map((r) => {
    if (dims > 1) return { ...r, k0: `${r.k0} / ${r.k1 ?? "?"}`, v: Number(r.v ?? 0) };
    return { ...r, k0: String(r.k0), v: Number(r.v ?? 0) };
  });
}

/** Execute a validated plan. The only function allowed to turn a plan into SQL. */
export function executePlan(db: DbAdapter, plan: QueryPlan, now = Date.now()): ExecutedPlan {
  const v = validatePlan(plan);
  if (!v.ok) throw new Error(`invalid plan: ${v.errors.join("; ")}`);
  const q = compilePlan(v.plan, now);
  const rows = mapRows(db.all(q.sql, q.params), plan.groupBy?.length ?? 0);
  let comparisonRows: PlanRow[] | null = null;
  if (q.comparison) comparisonRows = mapRows(db.all(q.comparison.sql, q.comparison.params), plan.groupBy?.length ?? 0);
  return { rows, comparisonRows, range: q.range, sql: q.sql, params: q.params, comparisonSql: q.comparison?.sql, comparisonParams: q.comparison?.params };
}

/** Ask a question. Never throws on a bad plan: returns an honest needs/error result instead. */
export function askQuestion(question: string, ctx: AskContext): AskResult {
  const now = ctx.now ?? Date.now();
  const vocab = loadVocab(ctx);
  const route = routeQuestion(question, now, vocab);
  if (!route.ok || !route.plan) {
    return {
      ok: false, source: "rules", question, provenance: route.explanation,
      needs: route.needs, error: route.needs ? undefined : "I could not understand that yet.",
    };
  }
  return askWithPlan(route.plan, question, ctx, route.summary);
}

/** Used by the UI for a plan the model proposed (it must still pass validatePlan). */
export function askWithPlan(plan: QueryPlan, question: string, ctx: AskContext, summary = false): AskResult {
  const now = ctx.now ?? Date.now();
  const v = validatePlan(plan);
  if (!v.ok) return { ok: false, source: "plan", question, provenance: "", error: v.errors.join("; ") };
  try {
    if (summary) return summarize(v.plan, question, ctx, now);
    const ex = executePlan(ctx.db, v.plan, now);
    const answer = composeAnswer(v.plan, ex.rows, ex.comparisonRows, ex.range);
    let evidence: EvidenceRow[] | undefined;
    let matches: number | undefined;
    try {
      const ev = compileEvidence(v.plan, now);
      evidence = ctx.db.all(ev.sql, ev.params) as EvidenceRow[];
      matches = Number((ctx.db.get(ev.countSql, ev.params) as { n?: number } | undefined)?.n ?? 0);
    } catch { /* evidence is an enhancement, never a reason to lose the answer */ }
    return {
      ok: true, source: "plan", question, plan: v.plan,
      provenance: provenance(v.plan, ex.range.label),
      sql: ex.sql, params: ex.params, rows: ex.rows, evidence, matches, comparisonRows: ex.comparisonRows, answer,
    };
  } catch (e) {
    return { ok: false, source: "plan", question, provenance: "", plan: v.plan, error: String(e).slice(0, 200) };
  }
}

function summarize(plan: QueryPlan, question: string, ctx: AskContext, now: number): AskResult {
  const baseFilters = { ...(plan.filters ?? {}) };
  const range = resolveRange(baseFilters.time, now);
  const common = { version: 1 as const };
  const at = (measure: QueryPlan["measure"], filters = baseFilters): QueryPlan => ({ ...common, measure, filters });
  const spend = executePlan(ctx.db, at("spend"), now);
  const income = executePlan(ctx.db, at("income"), now);
  const fees = executePlan(ctx.db, at("fees"), now);
  const count = executePlan(ctx.db, at("count"), now);
  const previous = executePlan(ctx.db, at("spend", { ...baseFilters, time: { kind: "absolute", fromMs: range.previous.from, toMs: range.previous.to } }), now);
  const topPlan: QueryPlan = { ...common, measure: "spend", groupBy: ["label"], filters: baseFilters, limit: 5 };
  const top = executePlan(ctx.db, topPlan, now);
  const total = (r: PlanRow[]) => r.reduce((s, x) => s + x.v, 0);
  const answer = composeSummary({
    range,
    spend: total(spend.rows),
    income: total(income.rows),
    fees: total(fees.rows),
    count: total(count.rows),
    previousSpend: total(previous.rows),
    top: top.rows.map((r) => ({ k0: r.k0, v: r.v })),
  });
  return {
    ok: true, source: "plan", question, plan,
    provenance: provenance(plan, range.label),
    sql: spend.sql, params: spend.params, rows: top.rows, comparisonRows: previous.rows, answer,
  };
}

function provenance(plan: QueryPlan, label: string): string {
  const bits: string[] = [plan.measure];
  if (plan.groupBy?.length) bits.push(`by ${plan.groupBy.join(" + ")}`);
  bits.push(`· ${label}`);
  if (plan.compare) bits.push("· compared with previous period");
  if (plan.filters?.tags?.length) bits.push(`· tag ${plan.filters.tags.join(", ")}`);
  if (plan.filters?.labels?.length) bits.push(`· ${plan.filters.labels.join(", ")}`);
  if (plan.filters?.counterparties?.length) bits.push(`· ${plan.filters.counterparties.join(", ")}`);
  if (plan.filters?.items?.length) bits.push(`· item ${plan.filters.items.join(", ")}`);
  if (plan.filters?.habits?.length) bits.push(`· habit ${plan.filters.habits.join(", ")}`);
  if (plan.filters?.funding) bits.push(`· ${plan.filters.funding}-funded`);
  return bits.join(" ");
}

/** Vocabulary used by the router; loaded from the phone, never from the network. */
export function loadVocab(ctx: Pick<AskContext, "db" | "labels" | "tags" | "counterparties" | "items" | "habits">): { labels?: string[]; tags?: string[]; counterparties?: string[]; items?: string[]; habits?: string[] } {
  const labels = ctx.labels ?? (ctx.db.all(`SELECT name FROM labels WHERE status = 'active' ORDER BY name`).map((r: { name: string }) => r.name) as string[]);
  const tags = ctx.tags ?? (ctx.db.all(`SELECT name FROM tags WHERE status = 'active' ORDER BY name`).map((r: { name: string }) => r.name) as string[]);
  const counterparties = ctx.counterparties ?? (ctx.db.all(
    `SELECT COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS name, COUNT(*) AS n
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      GROUP BY c.id ORDER BY n DESC LIMIT 80`,
  ).map((r: { name: string | null }) => r.name).filter(Boolean) as string[]);
  const items = ctx.items ?? (ctx.db.all(
    `SELECT i.name, COUNT(*) AS n FROM tx_items ti JOIN items i ON i.id = ti.item_id GROUP BY i.id ORDER BY n DESC LIMIT 80`,
  ).map((r: { name: string }) => r.name).filter(Boolean) as string[]);
  const habits = ctx.habits ?? (ctx.db.all(`SELECT name FROM habits WHERE status = 'active' ORDER BY name`).map((r: { name: string }) => r.name) as string[]);
  return { labels, tags, counterparties, items, habits };
}
