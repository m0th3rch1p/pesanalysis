import type { SQLiteDatabase } from "expo-sqlite";
import {
  type BudgetRow, type DelayStats, type FlowRow, type FlowSuggestion, type FloatResult, type OccurrenceRow, type PaceResult,
  type SavingsGoal, type SavingsLocation, type StripDay,
  addDays, budgetPace, budgetSpendEvents, dailySpendQuantiles, dayOf, dayStartMs, flowStats, floatSnapshot, listBudgets, listFlows,
  listLabelsFull, listOccurrences, listSavingsGoals, listSavingsLocations, refreshOccurrences, suggestRecurring, syncFulizaObligation,
  upcomingStrip, createFlow, type PatternTx,
} from "@yako/core";
import { asDbAdapter } from "../db/open";

export interface FlowView {
  flow: FlowRow;
  stats: DelayStats;
  occurrences: OccurrenceRow[];
  /** next open occurrence (upcoming/late/partial), if any */
  next: OccurrenceRow | null;
}
export interface BudgetView { budget: BudgetRow; pace: PaceResult; labelName: string | null }
export interface PlanData {
  now: number;
  today: string;
  float: FloatResult;
  spendEnough: boolean;
  flows: FlowView[];
  /** sms-derived (Fuliza/Okoa/lender) suggestions awaiting accept/dismiss */
  noticeSuggestions: FlowRow[];
  patternSuggestions: FlowSuggestion[];
  strip: StripDay[];
  locations: SavingsLocation[];
  goals: SavingsGoal[];
  budgets: BudgetView[];
  labels: Array<{ id: number; name: string }>;
}

/** Everything the Plan tab shows, in one synchronous pass (the ledger is local SQLite). Each part degrades independently. */
export function loadPlan(db: SQLiteDatabase, now = Date.now()): PlanData {
  const a = asDbAdapter(db);
  try { syncFulizaObligation(a, now); } catch { /* no Fuliza account */ }
  refreshOccurrences(a, now);
  const today = dayOf(now);

  const spend = budgetSpendEvents(a, { labelId: null, tagId: null }, now - 62 * 86_400_000, now + 1)
    .map((e) => ({ occurredAt: e.occurredAt, amountCents: e.amountCents }));
  const q = dailySpendQuantiles(spend, now, 60);
  const float = floatSnapshot(a, now, q.enough ? { dailySpendP50Cents: q.p50Cents, dailySpendP90Cents: q.p90Cents } : {});

  const allFlows = listFlows(a, { status: ["active", "suggested"] });
  const from = addDays(today, -45), to = addDays(today, 45);
  const occ = listOccurrences(a, { fromDay: from, toDay: to });
  const byFlow = new Map<number, OccurrenceRow[]>();
  for (const o of occ) (byFlow.get(o.flowId) ?? byFlow.set(o.flowId, []).get(o.flowId)!).push(o);
  const views: FlowView[] = allFlows.filter((f) => f.status === "active").map((f) => {
    const os = byFlow.get(f.id) ?? [];
    return { flow: f, stats: flowStats(a, f.id), occurrences: os, next: os.find((o) => o.state === "late" || o.state === "partial" || o.state === "upcoming") ?? null };
  });
  const nameOf = new Map(allFlows.map((f) => [f.id, f]));
  const strip = upcomingStrip(
    occ.filter((o) => nameOf.get(o.flowId)?.status === "active").map((o) => ({
      dueOn: o.dueOn, state: o.state, expectedCents: o.expectedCents, receivedCents: o.receivedCents,
      name: nameOf.get(o.flowId)!.name, direction: nameOf.get(o.flowId)!.direction,
    })), today, 30);

  const labels = listLabelsFull(a).slice(0, 24).map((l) => ({ id: l.id, name: l.name }));
  const labelName = new Map(labels.map((l) => [l.id, l.name]));
  const budgets: BudgetView[] = [];
  for (const b of listBudgets(a)) {
    try { budgets.push({ budget: b, pace: budgetPace(a, b.id, now), labelName: b.labelId != null ? labelName.get(b.labelId) ?? "label" : null }); } catch { /* invalid period */ }
  }

  let patternSuggestions: FlowSuggestion[] = [];
  try { patternSuggestions = detectPatterns(db, now); } catch { patternSuggestions = []; }

  return {
    now, today, float, spendEnough: q.enough, flows: views,
    noticeSuggestions: allFlows.filter((f) => f.status === "suggested" && f.source === "sms"),
    patternSuggestions, strip,
    locations: listSavingsLocations(a), goals: listSavingsGoals(a), budgets, labels,
  };
}

function detectPatterns(db: SQLiteDatabase, now: number): FlowSuggestion[] {
  const a = asDbAdapter(db);
  const rows = db.getAllSync<{ occurredAt: number; direction: string; amount: number; cpKey: string | null; cpName: string | null }>(
    `SELECT t.occurred_at AS occurredAt, t.direction, t.amount, c.key AS cpKey, c.display_name AS cpName
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.occurred_at >= ? AND t.direction IN ('in','out')
        AND (t.flow_class IS NULL OR t.flow_class IN ('income','spend','debt_repay'))`,
    [now - 220 * 86_400_000],
  );
  const txs: PatternTx[] = rows.filter((r) => r.cpKey).map((r) => ({
    occurredAt: r.occurredAt, direction: r.direction as "in" | "out", amountCents: r.amount, key: r.cpKey!, name: r.cpName ?? r.cpKey!,
  }));
  // already tracked, or answered before (accepted/dismissed suggestions keep their sourceRef)
  const skip = new Set<string>();
  for (const f of listFlows(a)) {
    if (f.sourceRef?.startsWith("detected:")) skip.add(f.sourceRef.split(":")[1] ?? "");
    if (f.counterpartyHint) skip.add(f.counterpartyHint);
  }
  return suggestRecurring(txs, now, skip).slice(0, 4);
}

export function acceptPattern(db: SQLiteDatabase, s: FlowSuggestion, answer: "active" | "dismissed"): void {
  createFlow(asDbAdapter(db), {
    direction: s.direction, name: s.name, counterpartyHint: s.key,
    amountMinCents: s.minCents, amountTypCents: s.typCents, amountMaxCents: s.maxCents,
    cadence: s.cadence, dayOfMonth: s.dayOfMonth, weekday: s.weekday,
    holidayPolicy: s.direction === "in" ? "before" : "none", graceDays: 2, missedAfterDays: 10,
    source: "detected", sourceRef: `detected:${s.key}:${s.direction}`, status: answer,
  });
}

export interface Candidate { id: number; amountCents: number; occurredAt: number; who: string; linked: boolean }

/** Transactions near an occurrence's due date, in the right direction, for "this is it" / "not this". */
export function candidatesFor(db: SQLiteDatabase, flow: FlowRow, occ: OccurrenceRow): Candidate[] {
  const from = dayStartMs(addDays(occ.dueOn, -12)), to = dayStartMs(addDays(occ.dueOn, 20));
  const rows = db.getAllSync<{ id: number; amount: number; occurredAt: number; who: string | null }>(
    `SELECT t.id, t.amount, t.occurred_at AS occurredAt, c.display_name AS who
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = ? AND t.occurred_at >= ? AND t.occurred_at < ?
      ORDER BY ABS(t.occurred_at - ?) LIMIT 10`,
    [flow.direction, from, to, occ.dueMs],
  );
  const linked = new Set([...occ.matchedTxIds, ...occ.pinnedTxIds]);
  return rows.map((r) => ({ id: r.id, amountCents: r.amount, occurredAt: r.occurredAt, who: r.who ?? "Unknown", linked: linked.has(r.id) }));
}
