/**
 * Store API for expected flows, occurrences, savings and budgets. Thin: validation and SQL only; the logic lives
 * in the pure engines next to this file. Money = integer cents. Dates = Africa/Nairobi days.
 */
import { type DbAdapter, lastInsertId } from "../db/migrate.js";
import { type DayStr, DAY_MS, addDays, dayOf, dayStartMs } from "./eat.js";
import { type ExpectCadence, type HolidayPolicy, generateOccurrences, validateCadence } from "./occurrences.js";
import { type DelayStats, type MatchTx, type OccState, delayStats, matchFlow, needCents } from "./matcher.js";
import { type BudgetPeriod, type BudgetRule, type PaceResult, type SpendEvent, budgetReserve, pace, periodBounds, rolloverCarry } from "./budget.js";
import { type DueItem, type FloatResult, computeFloat } from "./float.js";
import { type DueNotice, obligationFromNotice } from "./auto-obligations.js";
import { type GoalProgress, goalProgress } from "./savings.js";
import { fulizaState } from "../ledger/accounts.js";

// ======================= expected flows =======================

export type FlowDirection = "in" | "out";
export type FlowSource = "user" | "sms" | "detected";
export type FlowStatus = "active" | "suggested" | "paused" | "ended" | "dismissed";

export interface NewFlow {
  direction: FlowDirection;
  name: string;
  counterpartyHint?: string | null;
  amountMinCents?: number | null;
  amountTypCents?: number | null;
  amountMaxCents?: number | null;
  cadence: ExpectCadence;
  dayOfMonth?: number | null;
  weekday?: number | null;
  intervalDays?: number | null;
  anchorOn?: DayStr | null;
  holidayPolicy?: HolidayPolicy;
  graceDays?: number;
  missedAfterDays?: number;
  earlyDays?: number;
  source?: FlowSource;
  sourceRef?: string | null;
  debtId?: number | null;
  startsOn?: DayStr | null;
  endsOn?: DayStr | null;
  status?: FlowStatus;
}

export interface FlowRow extends Required<Omit<NewFlow, "counterpartyHint" | "amountMinCents" | "amountTypCents" | "amountMaxCents" | "dayOfMonth" | "weekday" | "intervalDays" | "anchorOn" | "sourceRef" | "debtId" | "startsOn" | "endsOn">> {
  id: number;
  counterpartyHint: string | null;
  amountMinCents: number | null; amountTypCents: number | null; amountMaxCents: number | null;
  dayOfMonth: number | null; weekday: number | null; intervalDays: number | null; anchorOn: DayStr | null;
  sourceRef: string | null; debtId: number | null; startsOn: DayStr | null; endsOn: DayStr | null;
  createdAt: number; updatedAt: number;
}

function toFlow(r: any): FlowRow {
  return {
    id: r.id, direction: r.direction, name: r.name, counterpartyHint: r.counterparty_hint,
    amountMinCents: r.amount_min_cents, amountTypCents: r.amount_typ_cents, amountMaxCents: r.amount_max_cents,
    cadence: r.cadence, dayOfMonth: r.day_of_month, weekday: r.weekday, intervalDays: r.interval_days, anchorOn: r.anchor_on,
    holidayPolicy: r.holiday_policy, graceDays: r.grace_days, missedAfterDays: r.missed_after_days, earlyDays: r.early_days,
    source: r.source, sourceRef: r.source_ref, debtId: r.debt_id, startsOn: r.starts_on, endsOn: r.ends_on,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function checkAmounts(f: Pick<NewFlow, "amountMinCents" | "amountTypCents" | "amountMaxCents">): void {
  const vals = [f.amountMinCents, f.amountTypCents, f.amountMaxCents];
  for (const v of vals) if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error("amounts must be non-negative integer cents");
  const { amountMinCents: lo, amountTypCents: t, amountMaxCents: hi } = f;
  if (lo != null && hi != null && lo > hi) throw new Error("amountMin > amountMax");
  if (t != null && lo != null && t < lo) throw new Error("amountTyp < amountMin");
  if (t != null && hi != null && t > hi) throw new Error("amountTyp > amountMax");
}

/** Fill the range from whatever was given: a single amount means min = typ = max. */
function normaliseAmounts(f: NewFlow): Pick<NewFlow, "amountMinCents" | "amountTypCents" | "amountMaxCents"> {
  let { amountMinCents: lo = null, amountTypCents: t = null, amountMaxCents: hi = null } = f;
  if (lo == null && hi == null && t != null) { lo = t; hi = t; }
  if (t == null && lo != null && hi != null) t = Math.round((lo + hi) / 2);
  if (t == null) t = lo ?? hi;
  if (lo == null && hi != null) lo = hi;
  if (hi == null && lo != null) hi = lo;
  return { amountMinCents: lo, amountTypCents: t, amountMaxCents: hi };
}

/**
 * Creates a flow. A second flow with the same (source, sourceRef) is not created; the existing id is returned
 * (idempotent for sms/detected suggestions).
 */
export function createFlow(db: DbAdapter, f: NewFlow, now = Date.now()): number {
  if (!f.name?.trim()) throw new Error("name required");
  const bad = validateCadence({ cadence: f.cadence, dayOfMonth: f.dayOfMonth, weekday: f.weekday, intervalDays: f.intervalDays, anchorOn: f.anchorOn });
  if (bad) throw new Error(bad);
  const amt = normaliseAmounts(f);
  checkAmounts(amt);
  const source = f.source ?? "user";
  if (f.sourceRef) {
    const ex = db.get(`SELECT id FROM expected_flows WHERE source = ? AND source_ref = ?`, [source, f.sourceRef]);
    if (ex) return ex.id;
  }
  const grace = f.graceDays ?? 1, missed = f.missedAfterDays ?? 7;
  if (grace < 0 || missed < grace) throw new Error("need 0 <= graceDays <= missedAfterDays");
  const r = db.run(
    `INSERT INTO expected_flows (direction, name, counterparty_hint, amount_min_cents, amount_typ_cents, amount_max_cents, cadence,
       day_of_month, weekday, interval_days, anchor_on, holiday_policy, grace_days, missed_after_days, early_days, source, source_ref,
       debt_id, starts_on, ends_on, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [f.direction, f.name.trim(), f.counterpartyHint?.trim() || null, amt.amountMinCents, amt.amountTypCents, amt.amountMaxCents, f.cadence,
      f.dayOfMonth ?? null, f.weekday ?? null, f.intervalDays ?? null, f.anchorOn ?? null, f.holidayPolicy ?? "none", grace, missed,
      f.earlyDays ?? 3, source, f.sourceRef ?? null, f.debtId ?? null, f.startsOn ?? null, f.endsOn ?? null, f.status ?? "active", now, now],
  );
  return lastInsertId(r);
}

export function getFlow(db: DbAdapter, id: number): FlowRow | null {
  const r = db.get(`SELECT * FROM expected_flows WHERE id = ?`, [id]);
  return r ? toFlow(r) : null;
}

export function listFlows(db: DbAdapter, f: { status?: FlowStatus[]; direction?: FlowDirection } = {}): FlowRow[] {
  const where: string[] = [], p: unknown[] = [];
  if (f.status?.length) { where.push(`status IN (${f.status.map(() => "?").join(",")})`); p.push(...f.status); }
  if (f.direction) { where.push(`direction = ?`); p.push(f.direction); }
  return db.all(`SELECT * FROM expected_flows ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`, p).map(toFlow);
}

export function updateFlow(db: DbAdapter, id: number, patch: Partial<NewFlow>, now = Date.now()): FlowRow {
  const cur = getFlow(db, id);
  if (!cur) throw new Error(`no flow ${id}`);
  const merged: NewFlow = { ...cur, ...patch };
  const bad = validateCadence(merged);
  if (bad) throw new Error(bad);
  const amt = patch.amountMinCents !== undefined || patch.amountTypCents !== undefined || patch.amountMaxCents !== undefined
    ? normaliseAmounts({ ...merged, amountMinCents: patch.amountMinCents ?? null, amountTypCents: patch.amountTypCents ?? null, amountMaxCents: patch.amountMaxCents ?? null })
    : { amountMinCents: cur.amountMinCents, amountTypCents: cur.amountTypCents, amountMaxCents: cur.amountMaxCents };
  checkAmounts(amt);
  const grace = merged.graceDays ?? 1, missed = merged.missedAfterDays ?? 7;
  if (grace < 0 || missed < grace) throw new Error("need 0 <= graceDays <= missedAfterDays");
  db.run(
    `UPDATE expected_flows SET direction=?, name=?, counterparty_hint=?, amount_min_cents=?, amount_typ_cents=?, amount_max_cents=?, cadence=?,
       day_of_month=?, weekday=?, interval_days=?, anchor_on=?, holiday_policy=?, grace_days=?, missed_after_days=?, early_days=?,
       starts_on=?, ends_on=?, status=?, updated_at=? WHERE id=?`,
    [merged.direction, merged.name, merged.counterpartyHint ?? null, amt.amountMinCents, amt.amountTypCents, amt.amountMaxCents, merged.cadence,
      merged.dayOfMonth ?? null, merged.weekday ?? null, merged.intervalDays ?? null, merged.anchorOn ?? null, merged.holidayPolicy ?? "none",
      grace, missed, merged.earlyDays ?? 3, merged.startsOn ?? null, merged.endsOn ?? null, merged.status ?? "active", now, id],
  );
  return getFlow(db, id)!;
}

export function setFlowStatus(db: DbAdapter, id: number, status: FlowStatus, now = Date.now()): void {
  db.run(`UPDATE expected_flows SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
}

/** Deletes the flow and (cascade) its occurrences. */
export function deleteFlow(db: DbAdapter, id: number): void {
  db.run(`DELETE FROM expected_occurrences WHERE flow_id = ?`, [id]);
  db.run(`DELETE FROM expected_flows WHERE id = ?`, [id]);
}

/**
 * Auto-create (or refresh) an obligation from a lender due-date notice. Returns the flow id, or null when the notice is unusable.
 * Re-sending the same notice never duplicates. A newer due date for the same lender replaces older, unpaid auto-created
 * flows (Fuliza's due date moves when you borrow more). If the same due date reports a new outstanding, the amount is updated.
 */
export function ingestDueNotice(db: DbAdapter, n: DueNotice, now = Date.now()): number | null {
  const f = obligationFromNotice(n);
  if (!f) return null;
  const existing = db.get(`SELECT id, status FROM expected_flows WHERE source = 'sms' AND source_ref = ?`, [f.sourceRef]);
  if (existing) {
    if (existing.status === "dismissed") return existing.id;
    db.run(`UPDATE expected_flows SET amount_min_cents = ?, amount_typ_cents = ?, amount_max_cents = ?, updated_at = ? WHERE id = ?`,
      [f.amountMinCents, f.amountTypCents, f.amountMaxCents, now, existing.id]);
    return existing.id;
  }
  const prefix = (f.sourceRef as string).split(":").slice(0, 2).join(":") + ":";
  const olds = db.all(`SELECT id FROM expected_flows WHERE source = 'sms' AND source_ref LIKE ? AND status IN ('active','suggested')`, [prefix + "%"]);
  for (const o of olds) {
    const hit = db.get(`SELECT COUNT(*) AS n FROM expected_occurrences WHERE flow_id = ? AND (received_cents > 0 OR pinned_tx_ids != '[]')`, [o.id]);
    if (!hit || Number(hit.n) === 0) deleteFlow(db, o.id);
    else setFlowStatus(db, o.id, "ended", now);
  }
  return createFlow(db, f, now);
}

/**
 * Read the Fuliza account (kept current by ingest) and create/refresh/close its obligation.
 * Outstanding 0 or null closes unpaid auto-created Fuliza flows. Returns the flow id when one is live.
 */
export function syncFulizaObligation(db: DbAdapter, now = Date.now()): number | null {
  const a = db.get(`SELECT outstanding_cents, due_at FROM accounts WHERE kind = 'credit' AND name LIKE '%uliza%' ORDER BY id LIMIT 1`);
  if (!a || !(Number(a.outstanding_cents) > 0) || a.due_at == null) {
    for (const o of db.all(`SELECT id FROM expected_flows WHERE source = 'sms' AND source_ref LIKE 'fuliza:%' AND status IN ('active','suggested')`)) {
      const hit = db.get(`SELECT COUNT(*) AS n FROM expected_occurrences WHERE flow_id = ? AND received_cents > 0`, [o.id]);
      if (Number(hit?.n ?? 0) === 0) deleteFlow(db, o.id); else setFlowStatus(db, o.id, "ended", now);
    }
    return null;
  }
  return ingestDueNotice(db, { kind: "fuliza", dueAt: Number(a.due_at), outstandingCents: Number(a.outstanding_cents) }, now);
}

// ======================= occurrences =======================

export interface OccurrenceRow {
  id: number; flowId: number; nominalOn: DayStr; dueOn: DayStr; dueMs: number; state: OccState;
  matchedTxIds: number[]; pinnedTxIds: number[]; rejectedTxIds: number[];
  receivedCents: number; expectedCents: number | null; delayDays: number | null; resolvedAt: number | null; updatedAt: number;
}

function jsonIds(s: unknown): number[] {
  try { const a = JSON.parse(String(s ?? "[]")); return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : []; } catch { return []; }
}

function toOcc(r: any): OccurrenceRow {
  return {
    id: r.id, flowId: r.flow_id, nominalOn: r.nominal_on, dueOn: r.due_on, dueMs: r.due_ms, state: r.state,
    matchedTxIds: jsonIds(r.matched_tx_ids), pinnedTxIds: jsonIds(r.pinned_tx_ids), rejectedTxIds: jsonIds(r.rejected_tx_ids),
    receivedCents: r.received_cents, expectedCents: r.expected_cents, delayDays: r.delay_days, resolvedAt: r.resolved_at, updatedAt: r.updated_at,
  };
}

export function listOccurrences(db: DbAdapter, f: { flowId?: number; fromDay?: DayStr; toDay?: DayStr; states?: OccState[] } = {}): OccurrenceRow[] {
  const where: string[] = [], p: unknown[] = [];
  if (f.flowId != null) { where.push("flow_id = ?"); p.push(f.flowId); }
  if (f.fromDay) { where.push("due_on >= ?"); p.push(f.fromDay); }
  if (f.toDay) { where.push("due_on <= ?"); p.push(f.toDay); }
  if (f.states?.length) { where.push(`state IN (${f.states.map(() => "?").join(",")})`); p.push(...f.states); }
  return db.all(`SELECT * FROM expected_occurrences ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY due_on, id`, p).map(toOcc);
}

/** Waive an occurrence ("skipped this month"). Sticky until unwaived. */
export function waiveOccurrence(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE expected_occurrences SET state = 'waived', matched_tx_ids = '[]', received_cents = 0, delay_days = NULL, resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
}

/** Re-open a waived occurrence; the next refresh recomputes its state. */
export function unwaiveOccurrence(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE expected_occurrences SET state = 'upcoming', resolved_at = NULL, updated_at = ? WHERE id = ? AND state = 'waived'`, [now, id]);
}

function mutateIds(db: DbAdapter, occId: number, col: "pinned_tx_ids" | "rejected_tx_ids", other: "pinned_tx_ids" | "rejected_tx_ids", txId: number, add: boolean, now: number): void {
  const r = db.get(`SELECT ${col} AS a, ${other} AS b FROM expected_occurrences WHERE id = ?`, [occId]);
  if (!r) throw new Error(`no occurrence ${occId}`);
  const a = new Set(jsonIds(r.a)), b = new Set(jsonIds(r.b));
  if (add) { a.add(txId); b.delete(txId); } else a.delete(txId);
  db.run(`UPDATE expected_occurrences SET ${col} = ?, ${other} = ?, updated_at = ? WHERE id = ?`, [JSON.stringify([...a]), JSON.stringify([...b]), now, occId]);
}

/** Manual "this is it": always wins over automatic matching. Takes effect at the next refreshOccurrences. */
export function pinTransaction(db: DbAdapter, occId: number, txId: number, now = Date.now()): void {
  // a transaction pinned here is released from any other occurrence's pins
  for (const o of db.all(`SELECT id FROM expected_occurrences WHERE id != ? AND pinned_tx_ids LIKE ?`, [occId, `%${txId}%`])) mutateIds(db, o.id, "pinned_tx_ids", "rejected_tx_ids", txId, false, now);
  mutateIds(db, occId, "pinned_tx_ids", "rejected_tx_ids", txId, true, now);
}
/** Manual "not this": the transaction is never matched to this occurrence again. */
export function rejectTransaction(db: DbAdapter, occId: number, txId: number, now = Date.now()): void {
  mutateIds(db, occId, "rejected_tx_ids", "pinned_tx_ids", txId, true, now);
}
export function clearTransactionOverride(db: DbAdapter, occId: number, txId: number, now = Date.now()): void {
  mutateIds(db, occId, "pinned_tx_ids", "rejected_tx_ids", txId, false, now);
  mutateIds(db, occId, "rejected_tx_ids", "pinned_tx_ids", txId, false, now);
}

export interface RefreshOptions {
  /** Days ahead to generate occurrences. Default 90. */
  horizonDays?: number;
  /** Days back that are (re)generated and re-matched. Default 120. */
  lookbackDays?: number;
  tolerance?: number;
}
export interface RefreshSummary { created: number; updated: number; removed: number; flows: number; matched: number; late: number; missed: number; partial: number }

const OUT_CLASSES = new Set(["spend", "fee", "debt_repay", "transfer_own"]);

function loadMatchTxs(db: DbAdapter, fromMs: number, toMs: number): MatchTx[] {
  const rows = db.all(
    `SELECT t.id, t.direction, t.amount, t.occurred_at, t.template, t.account, t.kind, t.flow_class,
            cp.display_name AS cp_name, cp.raw_names AS cp_raw
       FROM transactions t LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
      WHERE t.role = 'transaction' AND t.direction IN ('in','out') AND t.occurred_at >= ? AND t.occurred_at < ?
        AND (t.id IN (SELECT id FROM tx_events) OR t.kind = 'loan_repay')`,
    [fromMs, toMs],
  );
  const out: MatchTx[] = [];
  for (const r of rows) {
    const cls: string | null = r.flow_class ?? null;
    if (r.direction === "in") { if (cls != null && cls !== "income") continue; if (r.kind === "loan_draw") continue; }
    else if (cls != null && !OUT_CLASSES.has(cls)) continue;
    let raw = "";
    try { const a = JSON.parse(String(r.cp_raw ?? "[]")); if (Array.isArray(a)) raw = a.join(" "); } catch { /* ignore */ }
    out.push({ id: r.id, direction: r.direction, amountCents: r.amount, occurredAt: r.occurred_at, text: [r.cp_name, raw, r.account, r.template].filter(Boolean).join(" ") });
  }
  return out;
}

/**
 * Idempotent: generates occurrences for [today - lookback, today + horizon], removes stale unmatched future ones of
 * inactive flows, re-solves matching for everything in the lookback, and updates only rows whose state changed.
 * `now` is epoch ms. Running it twice with the same inputs changes nothing the second time.
 */
export function refreshOccurrences(db: DbAdapter, now = Date.now(), opts: RefreshOptions = {}): RefreshSummary {
  const horizon = opts.horizonDays ?? 90, lookback = opts.lookbackDays ?? 120;
  const today = dayOf(now);
  const from = addDays(today, -lookback), to = addDays(today, horizon);
  const sum: RefreshSummary = { created: 0, updated: 0, removed: 0, flows: 0, matched: 0, late: 0, missed: 0, partial: 0 };

  // 1. generation
  const all = listFlows(db);
  for (const f of all) {
    if (f.status !== "active" && f.status !== "suggested") {
      const r = db.run(`DELETE FROM expected_occurrences WHERE flow_id = ? AND due_on > ? AND received_cents = 0 AND pinned_tx_ids = '[]' AND state IN ('upcoming')`, [f.id, today]);
      sum.removed += Number((r as { changes?: number }).changes ?? 0);
      continue;
    }
    sum.flows++;
    const gen = generateOccurrences(f, from, to);
    const need = needCents({ minCents: f.amountMinCents, typCents: f.amountTypCents, maxCents: f.amountMaxCents });
    for (const g of gen) {
      const ex = db.get(`SELECT id, due_on, state, expected_cents FROM expected_occurrences WHERE flow_id = ? AND nominal_on = ?`, [f.id, g.nominalOn]);
      if (!ex) {
        db.run(`INSERT INTO expected_occurrences (flow_id, nominal_on, due_on, due_ms, state, expected_cents, updated_at) VALUES (?,?,?,?, 'upcoming', ?, ?)`,
          [f.id, g.nominalOn, g.dueOn, dayStartMs(g.dueOn), need, now]);
        sum.created++;
      } else if (ex.due_on !== g.dueOn || ex.expected_cents !== need) {
        db.run(`UPDATE expected_occurrences SET due_on = ?, due_ms = ?, expected_cents = ?, updated_at = ? WHERE id = ?`, [g.dueOn, dayStartMs(g.dueOn), need, now, ex.id]);
        sum.updated++;
      }
    }
    // occurrences no longer produced by the rule (edited cadence): drop only if untouched and in the future
    const keep = new Set(gen.map((g) => g.nominalOn));
    for (const r of db.all(`SELECT id, nominal_on FROM expected_occurrences WHERE flow_id = ? AND due_on > ? AND state = 'upcoming' AND received_cents = 0 AND pinned_tx_ids = '[]'`, [f.id, today])) {
      if (!keep.has(r.nominal_on)) { db.run(`DELETE FROM expected_occurrences WHERE id = ?`, [r.id]); sum.removed++; }
    }
  }

  // 2. matching
  const fromMs = dayStartMs(addDays(from, -30));
  const txs = loadMatchTxs(db, fromMs, now + 1);
  const used = new Set<number>();
  for (const f of all) {
    if (f.status !== "active" && f.status !== "suggested") continue;
    const rows = listOccurrences(db, { flowId: f.id, fromDay: from, toDay: to });
    if (!rows.length) continue;
    const results = matchFlow(
      { direction: f.direction, hint: f.counterpartyHint, minCents: f.amountMinCents, typCents: f.amountTypCents, maxCents: f.amountMaxCents,
        graceDays: f.graceDays, missedAfterDays: f.missedAfterDays, earlyDays: f.earlyDays },
      rows.map((o) => ({ id: o.id, dueOn: o.dueOn, waived: o.state === "waived", pinned: o.pinnedTxIds, rejected: o.rejectedTxIds })),
      txs, now, { tolerance: opts.tolerance, usedTxIds: used },
    );
    const byId = new Map(rows.map((o) => [o.id, o]));
    for (const r of results) {
      for (const id of r.matchedTxIds) used.add(id);
      const o = byId.get(r.id)!;
      if (r.state === "matched") sum.matched++; else if (r.state === "late") sum.late++; else if (r.state === "missed") sum.missed++; else if (r.state === "partial") sum.partial++;
      if (o.state === "waived") continue;
      const same = o.state === r.state && o.receivedCents === r.receivedCents && o.delayDays === r.delayDays && o.expectedCents === r.expectedCents
        && JSON.stringify(o.matchedTxIds) === JSON.stringify(r.matchedTxIds) && o.resolvedAt === r.resolvedAt;
      if (same) continue;
      db.run(`UPDATE expected_occurrences SET state = ?, matched_tx_ids = ?, received_cents = ?, expected_cents = ?, delay_days = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
        [r.state, JSON.stringify(r.matchedTxIds), r.receivedCents, r.expectedCents, r.delayDays, r.resolvedAt, now, r.id]);
      sum.updated++;
    }
  }
  return sum;
}

/** Delay statistics for one flow (waived and upcoming excluded from rates). */
export function flowStats(db: DbAdapter, flowId: number): DelayStats {
  const f = getFlow(db, flowId);
  const rows = listOccurrences(db, { flowId });
  return delayStats(rows.map((o) => ({ state: o.state, delayDays: o.delayDays, receivedCents: o.receivedCents, expectedCents: o.expectedCents })), f?.graceDays ?? 1);
}

// ======================= savings =======================

export type SavingsRail = "mshwari" | "kcb_mpesa" | "bank" | "mmf" | "sacco" | "mpesa_pot" | "cash" | "other";
export interface SavingsLocation { id: number; name: string; rail: SavingsRail; isVirtual: boolean; balanceCents: number; balanceAt: number | null; accountId: number | null; status: "active" | "closed" }
export interface SavingsGoal { id: number; locationId: number | null; name: string; horizon: "short" | "long"; targetCents: number; savedCents: number; targetOn: DayStr | null; status: "active" | "achieved" | "paused" | "dropped" }

const toLoc = (r: any): SavingsLocation => ({ id: r.id, name: r.name, rail: r.rail, isVirtual: !!r.is_virtual, balanceCents: r.balance_cents, balanceAt: r.balance_at, accountId: r.account_id, status: r.status });
const toGoal = (r: any): SavingsGoal => ({ id: r.id, locationId: r.location_id, name: r.name, horizon: r.horizon, targetCents: r.target_cents, savedCents: r.saved_cents, targetOn: r.target_on, status: r.status });

/** `isVirtual` defaults to true for rail "mpesa_pot" (a bookkeeping boundary inside the wallet), false otherwise. */
export function createSavingsLocation(db: DbAdapter, l: { name: string; rail: SavingsRail; isVirtual?: boolean; balanceCents?: number; accountId?: number | null }, now = Date.now()): number {
  if (!l.name.trim()) throw new Error("name required");
  const bal = l.balanceCents ?? 0;
  if (!Number.isInteger(bal) || bal < 0) throw new Error("balance must be non-negative integer cents");
  const r = db.run(`INSERT INTO savings_locations (name, rail, is_virtual, balance_cents, balance_at, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [l.name.trim(), l.rail, (l.isVirtual ?? l.rail === "mpesa_pot") ? 1 : 0, bal, bal ? now : null, l.accountId ?? null, now, now]);
  return lastInsertId(r);
}
export function listSavingsLocations(db: DbAdapter, includeClosed = false): SavingsLocation[] {
  return db.all(`SELECT * FROM savings_locations ${includeClosed ? "" : "WHERE status = 'active'"} ORDER BY id`).map(toLoc);
}
/** Set an observed balance (statement or SMS balance line). */
export function setLocationBalance(db: DbAdapter, id: number, balanceCents: number, now = Date.now()): void {
  if (!Number.isInteger(balanceCents) || balanceCents < 0) throw new Error("balance must be non-negative integer cents");
  db.run(`UPDATE savings_locations SET balance_cents = ?, balance_at = ?, updated_at = ? WHERE id = ?`, [balanceCents, now, now, id]);
}
/** Deposit (+) or withdraw (-) on a location. Refuses to go negative. Returns the new balance. */
export function adjustLocation(db: DbAdapter, id: number, deltaCents: number, now = Date.now()): number {
  if (!Number.isInteger(deltaCents)) throw new Error("delta must be integer cents");
  const r = db.get(`SELECT balance_cents FROM savings_locations WHERE id = ?`, [id]);
  if (!r) throw new Error(`no location ${id}`);
  const next = r.balance_cents + deltaCents;
  if (next < 0) throw new Error("withdrawal exceeds balance");
  setLocationBalance(db, id, next, now);
  return next;
}
export function closeSavingsLocation(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE savings_locations SET status = 'closed', updated_at = ? WHERE id = ?`, [now, id]);
}
/** Earmarked money still inside the wallet: the sum of active virtual pots. Real savings accounts are outside the wallet. */
export function virtualPotsTotal(db: DbAdapter): number {
  return Number(db.get(`SELECT COALESCE(SUM(balance_cents), 0) AS n FROM savings_locations WHERE is_virtual = 1 AND status = 'active'`)?.n ?? 0);
}

export function createSavingsGoal(db: DbAdapter, g: { name: string; targetCents: number; locationId?: number | null; horizon?: "short" | "long"; targetOn?: DayStr | null; savedCents?: number }, now = Date.now()): number {
  if (!g.name.trim()) throw new Error("name required");
  if (!Number.isInteger(g.targetCents) || g.targetCents <= 0) throw new Error("target must be positive integer cents");
  const r = db.run(`INSERT INTO savings_goals (location_id, name, horizon, target_cents, saved_cents, target_on, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [g.locationId ?? null, g.name.trim(), g.horizon ?? "short", g.targetCents, g.savedCents ?? 0, g.targetOn ?? null, now, now]);
  return lastInsertId(r);
}
export function listSavingsGoals(db: DbAdapter, includeInactive = false): SavingsGoal[] {
  return db.all(`SELECT * FROM savings_goals ${includeInactive ? "" : "WHERE status = 'active'"} ORDER BY id`).map(toGoal);
}
/** Add (+) or remove (-) saved money on a goal; marks it achieved at target. Does not touch the location balance. */
export function adjustGoal(db: DbAdapter, id: number, deltaCents: number, now = Date.now()): SavingsGoal {
  const r = db.get(`SELECT * FROM savings_goals WHERE id = ?`, [id]);
  if (!r) throw new Error(`no goal ${id}`);
  const saved = Math.max(0, r.saved_cents + deltaCents);
  const status = r.status === "active" && saved >= r.target_cents ? "achieved" : r.status === "achieved" && saved < r.target_cents ? "active" : r.status;
  db.run(`UPDATE savings_goals SET saved_cents = ?, status = ?, updated_at = ? WHERE id = ?`, [saved, status, now, id]);
  return toGoal(db.get(`SELECT * FROM savings_goals WHERE id = ?`, [id]));
}
export function goalProgressFor(g: SavingsGoal, nowMs: number, monthlyRateCents: number | null = null): GoalProgress {
  return goalProgress(g, nowMs, monthlyRateCents);
}

// ======================= budgets =======================

export interface NewBudget {
  name: string; period: BudgetPeriod; limitCents: number;
  anchor?: number | null; periodDays?: number | null; anchorOn?: DayStr | null;
  labelId?: number | null; tagId?: number | null; rollover?: boolean;
}
export interface BudgetRow extends BudgetRule {
  id: number; name: string; labelId: number | null; tagId: number | null; status: "active" | "paused" | "archived";
}
const toBudget = (r: any): BudgetRow => ({
  id: r.id, name: r.name, period: r.period, anchor: r.anchor, periodDays: r.period_days, anchorOn: r.anchor_on,
  labelId: r.label_id, tagId: r.tag_id, limitCents: r.limit_cents, rollover: !!r.rollover, status: r.status,
});

export function createBudget(db: DbAdapter, b: NewBudget, now = Date.now()): number {
  if (!b.name.trim()) throw new Error("name required");
  if (!Number.isInteger(b.limitCents) || b.limitCents <= 0) throw new Error("limit must be positive integer cents");
  periodBounds({ period: b.period, anchor: b.anchor, periodDays: b.periodDays, anchorOn: b.anchorOn, limitCents: b.limitCents }, now); // validates
  const r = db.run(`INSERT INTO budgets (name, period, anchor, period_days, anchor_on, label_id, tag_id, limit_cents, rollover, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name.trim(), b.period, b.anchor ?? null, b.periodDays ?? null, b.anchorOn ?? null, b.labelId ?? null, b.tagId ?? null, b.limitCents, b.rollover ? 1 : 0, now, now]);
  return lastInsertId(r);
}
export function listBudgets(db: DbAdapter, includeInactive = false): BudgetRow[] {
  return db.all(`SELECT * FROM budgets ${includeInactive ? "" : "WHERE status = 'active'"} ORDER BY id`).map(toBudget);
}
export function getBudget(db: DbAdapter, id: number): BudgetRow | null {
  const r = db.get(`SELECT * FROM budgets WHERE id = ?`, [id]);
  return r ? toBudget(r) : null;
}
export function updateBudget(db: DbAdapter, id: number, patch: Partial<NewBudget> & { status?: BudgetRow["status"] }, now = Date.now()): BudgetRow {
  const cur = getBudget(db, id);
  if (!cur) throw new Error(`no budget ${id}`);
  const m = { ...cur, ...patch } as BudgetRow;
  if (!Number.isInteger(m.limitCents) || m.limitCents <= 0) throw new Error("limit must be positive integer cents");
  periodBounds(m, now);
  db.run(`UPDATE budgets SET name=?, period=?, anchor=?, period_days=?, anchor_on=?, label_id=?, tag_id=?, limit_cents=?, rollover=?, status=?, updated_at=? WHERE id=?`,
    [m.name, m.period, m.anchor ?? null, m.periodDays ?? null, m.anchorOn ?? null, m.labelId ?? null, m.tagId ?? null, m.limitCents, m.rollover ? 1 : 0, m.status, now, id]);
  return getBudget(db, id)!;
}
export function deleteBudget(db: DbAdapter, id: number): void { db.run(`DELETE FROM budgets WHERE id = ?`, [id]); }

/** Spend events (flow_class spend|fee, direction out, fees included) inside [fromMs, toMs) that fall in the budget's scope. */
export function budgetSpendEvents(db: DbAdapter, b: Pick<BudgetRow, "labelId" | "tagId">, fromMs: number, toMs: number): SpendEvent[] {
  const where = [`t.occurred_at >= ? AND t.occurred_at < ?`, `t.direction = 'out'`, `t.flow_class IN ('spend','fee')`];
  const p: unknown[] = [fromMs, toMs];
  if (b.labelId != null) {
    where.push(`EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND (l.id = ? OR l.parent_id = ?))`);
    p.push(b.labelId, b.labelId);
  }
  if (b.tagId != null) { where.push(`EXISTS (SELECT 1 FROM tx_tags tt WHERE tt.tx_id = t.id AND tt.tag_id = ?)`); p.push(b.tagId); }
  return db.all(`SELECT t.occurred_at, t.amount, t.fee, t.flow_class FROM tx_events t WHERE ${where.join(" AND ")}`, p)
    .map((r) => ({ occurredAt: r.occurred_at, amountCents: r.flow_class === "fee" ? r.amount : r.amount + (r.fee ?? 0) }));
}

/** Weekday weights (mean 1, index 0 = Sunday) from spend history; null when there is too little history to trust. */
export function weekdayWeightsFromHistory(spend: SpendEvent[]): number[] | null {
  if (spend.length < 20) return null;
  const sums = [0, 0, 0, 0, 0, 0, 0];
  for (const e of spend) { const d = new Date(e.occurredAt + 3 * 3_600_000).getUTCDay(); sums[d] = (sums[d] ?? 0) + e.amountCents; }
  const total = sums.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  // shrink toward uniform: half the evidence, half the prior
  return sums.map((s) => 0.5 * ((s / total) * 7) + 0.5);
}

export function budgetPace(db: DbAdapter, id: number, now = Date.now()): PaceResult & { budgetId: number } {
  const b = getBudget(db, id);
  if (!b) throw new Error(`no budget ${id}`);
  const cur = periodBounds(b, now);
  const histFrom = Math.min(cur.startMs, now - 90 * DAY_MS);
  const rolloverFrom = b.rollover ? now - 400 * DAY_MS : cur.startMs;
  const events = budgetSpendEvents(db, b, Math.min(histFrom, rolloverFrom), cur.endMs);
  const hist = events.filter((e) => e.occurredAt < cur.startMs && e.occurredAt >= now - 90 * DAY_MS);
  const carry = rolloverCarry(b, events, now);
  return { budgetId: id, ...pace(b, events, now, { carryCents: carry, weekdayWeights: weekdayWeightsFromHistory(hist) ?? undefined }) };
}

// ======================= float snapshot =======================

export interface FloatSnapshotOptions {
  horizonDays?: number; dailySpendP50Cents?: number; dailySpendP90Cents?: number; staleAfterHours?: number; projectionDays?: number;
}

/** Wires the store into the float engine: wallet balance, pots, open obligations, expected income, budgets, Fuliza. */
export function floatSnapshot(db: DbAdapter, now = Date.now(), o: FloatSnapshotOptions = {}): FloatResult {
  const horizon = o.horizonDays ?? 7;
  const wallet = db.get(`SELECT last_balance_cents AS b, last_balance_at AS at FROM accounts WHERE kind = 'wallet' AND last_balance_cents IS NOT NULL ORDER BY (provider = 'mpesa') DESC, last_balance_at DESC LIMIT 1`);
  // Same normalised snapshot as the Home Fuliza card: never let the float and the card disagree (D102).
  const fz = fulizaState(db)?.outstandingCents ?? 0;
  const flows = new Map(listFlows(db, { status: ["active", "suggested"] }).map((f) => [f.id, f]));
  const open = listOccurrences(db, { states: ["upcoming", "late", "partial"] });
  const obligations: DueItem[] = [], income: DueItem[] = [];
  const rel = new Map<number, number>();
  for (const occ of open) {
    const f = flows.get(occ.flowId);
    if (!f) continue;
    const remaining = Math.max(0, (occ.expectedCents ?? f.amountTypCents ?? 0) - occ.receivedCents);
    if (remaining <= 0) continue;
    if (f.direction === "out") obligations.push({ name: f.name, dueOn: occ.dueOn, cents: remaining });
    else {
      if (!rel.has(f.id)) rel.set(f.id, flowStats(db, f.id).reliability ?? 0.8);
      income.push({ name: f.name, dueOn: occ.dueOn, cents: f.amountTypCents ?? remaining, reliability: rel.get(f.id) });
    }
  }
  const paces = listBudgets(db).map((b) => budgetPace(db, b.id, now));
  return computeFloat({
    nowMs: now, balanceCents: wallet ? Number(wallet.b) : null, balanceAsOf: wallet ? Number(wallet.at) : null,
    potsCents: virtualPotsTotal(db), obligations, expectedIncome: income,
    budgetReserveCents: budgetReserve(paces, now, horizon), horizonDays: horizon,
    dailySpendP50Cents: o.dailySpendP50Cents, dailySpendP90Cents: o.dailySpendP90Cents,
    fulizaOutstandingCents: fz, staleAfterHours: o.staleAfterHours, projectionDays: o.projectionDays,
  });
}
