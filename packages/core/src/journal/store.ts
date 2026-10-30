/** Persistence + ledger loading for the decision journal. */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";
import { type DayStr, dayOf, dayStartMs, addDays } from "../expect/eat.js";
import { auditOutcome, buildDailySeries, ruleMetric, type OutcomeAudit } from "./audit.js";
import {
  evaluateJournalRule, mergeChecks, summariseAdherence, validateJournalRule,
  type Adherence, type CheckState, type JournalRule, type LedgerCoverage, type JournalLedgerTx,
} from "./rules.js";

export interface JournalEntry {
  id: number; decisionText: string; why: string | null;
  linkedTxId: number | null; linkedBudgetId: number | null; linkedObligationId: number | null;
  rule: JournalRule | null; baseline: unknown; startedOn: DayStr; endsOn: DayStr | null;
  status: "active" | "ended" | "abandoned"; createdAt: number; updatedAt: number;
}

export interface NewJournalEntry {
  decisionText: string; why?: string | null; linkedTxId?: number | null; linkedBudgetId?: number | null; linkedObligationId?: number | null;
  rule?: JournalRule | null; baseline?: unknown; startedOn?: DayStr; endsOn?: DayStr | null;
}

function rowToEntry(r: any): JournalEntry {
  return {
    id: r.id, decisionText: r.decision_text, why: r.why ?? null, linkedTxId: r.linked_tx_id ?? null, linkedBudgetId: r.linked_budget_id ?? null,
    linkedObligationId: r.linked_obligation_id ?? null, rule: r.rule_json ? JSON.parse(r.rule_json) : null, baseline: r.baseline_json ? JSON.parse(r.baseline_json) : null,
    startedOn: r.started_on, endsOn: r.ends_on ?? null, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createJournalEntry(db: DbAdapter, e: NewJournalEntry, now: number): number {
  if (!e.decisionText?.trim()) throw new Error("decision text required");
  if (e.rule != null && !validateJournalRule(e.rule)) throw new Error("invalid journal rule");
  const startedOn = e.startedOn ?? dayOf(now);
  if (e.endsOn && e.endsOn < startedOn) throw new Error("ends before it starts");
  const r = db.run(
    `INSERT INTO journal_entries (decision_text, why, linked_tx_id, linked_budget_id, linked_obligation_id, rule_json, baseline_json, started_on, ends_on, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [e.decisionText.trim(), e.why ?? null, e.linkedTxId ?? null, e.linkedBudgetId ?? null, e.linkedObligationId ?? null,
     e.rule ? JSON.stringify(e.rule) : null, e.baseline != null ? JSON.stringify(e.baseline) : null, startedOn, e.endsOn ?? null, now, now],
  );
  return lastInsertId(r);
}

export function getJournalEntry(db: DbAdapter, id: number): JournalEntry | null {
  const r = db.get(`SELECT * FROM journal_entries WHERE id = ?`, [id]);
  return r ? rowToEntry(r) : null;
}
export function listJournalEntries(db: DbAdapter, status?: JournalEntry["status"]): JournalEntry[] {
  const rows = status ? db.all(`SELECT * FROM journal_entries WHERE status = ? ORDER BY id`, [status]) : db.all(`SELECT * FROM journal_entries ORDER BY id`);
  return rows.map(rowToEntry);
}
export function setJournalStatus(db: DbAdapter, id: number, status: JournalEntry["status"], now: number): void {
  db.run(`UPDATE journal_entries SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
}

export function addManualCheck(db: DbAdapter, entryId: number, onDate: DayStr, state: CheckState, now: number, note?: string | null): void {
  db.run(
    `INSERT INTO journal_checks (entry_id, on_date, state, source, note, checked_at) VALUES (?,?,?,'manual',?,?)
     ON CONFLICT(entry_id, on_date) DO UPDATE SET state = excluded.state, source = 'manual', note = excluded.note, checked_at = excluded.checked_at`,
    [entryId, onDate, state, note ?? null, now],
  );
}

export interface StoredCheck { onDate: DayStr; state: CheckState; source: "auto" | "manual"; evidenceTxIds: number[]; detail: string | null; note: string | null }
export function listChecks(db: DbAdapter, entryId: number): StoredCheck[] {
  return db.all(`SELECT * FROM journal_checks WHERE entry_id = ? ORDER BY on_date`, [entryId]).map((r) => ({
    onDate: r.on_date, state: r.state, source: r.source, evidenceTxIds: JSON.parse(r.evidence_tx_ids ?? "[]"), detail: r.detail ?? null, note: r.note ?? null,
  }));
}

/** Ledger rows for journal evaluation. Fuliza draws are funding notices (not in tx_events), so they are read from `transactions`. */
export function loadLedger(db: DbAdapter, fromMs: number, toMs: number): JournalLedgerTx[] {
  const rows = db.all(
    `SELECT t.id, t.occurred_at, t.direction, t.amount, t.fee, t.flow_class, 0 AS is_draw,
            (SELECT label_id FROM tx_labels l WHERE l.tx_id = t.id ORDER BY (l.confirmed_at IS NULL), l.suggested_at DESC LIMIT 1) AS label_id
       FROM tx_events t WHERE t.occurred_at >= ? AND t.occurred_at < ?
     UNION ALL
     SELECT t.id, t.occurred_at, t.direction, t.amount, t.fee, t.flow_class, 1, NULL
       FROM transactions t WHERE t.template LIKE '%fuliza_draw%' AND t.occurred_at >= ? AND t.occurred_at < ?
     ORDER BY 2, 1`,
    [fromMs, toMs, fromMs, toMs],
  );
  return rows.map((r) => ({
    id: r.id, occurredAt: r.occurred_at, direction: r.direction, amountCents: r.amount, feeCents: r.fee ?? 0, flowClass: r.flow_class ?? null,
    isFulizaDraw: r.is_draw === 1, labelId: r.label_id ?? null,
  }));
}

/** Coverage = first ledger row to the latest of last ledger row or `syncedThroughMs` (caller knows when SMS capture last ran). */
export function ledgerCoverage(db: DbAdapter, syncedThroughMs?: number | null): LedgerCoverage | null {
  const r = db.get(`SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM transactions`);
  if (!r || r.lo == null) return null;
  return { fromMs: r.lo, throughMs: Math.max(r.hi, syncedThroughMs ?? 0) };
}

/** Re-evaluates an entry from the ledger and upserts auto checks. Manual check-ins are never overwritten. Idempotent. */
export function runJournalChecks(db: DbAdapter, entryId: number, nowMs: number, opts: { syncedThroughMs?: number | null } = {}): { written: number; adherence: Adherence } {
  const e = getJournalEntry(db, entryId);
  if (!e) throw new Error(`no journal entry ${entryId}`);
  if (!e.rule) return { written: 0, adherence: summariseAdherence(listChecks(db, entryId)) };
  const txs = loadLedger(db, dayStartMs(addDays(e.startedOn, -6)), nowMs);
  const checks = evaluateJournalRule(e.rule, txs, { startOn: e.startedOn, endOn: e.endsOn, coverage: ledgerCoverage(db, opts.syncedThroughMs), nowMs });
  let written = 0;
  for (const c of checks) {
    db.run(
      `INSERT INTO journal_checks (entry_id, on_date, state, source, evidence_tx_ids, detail, checked_at) VALUES (?,?,?,'auto',?,?,?)
       ON CONFLICT(entry_id, on_date) DO UPDATE SET state = excluded.state, evidence_tx_ids = excluded.evidence_tx_ids, detail = excluded.detail, checked_at = excluded.checked_at
       WHERE journal_checks.source = 'auto'`,
      [entryId, c.onDate, c.state, JSON.stringify(c.evidenceTxIds), c.detail, nowMs],
    );
    written++;
  }
  return { written, adherence: journalAdherence(db, entryId) };
}

export function journalAdherence(db: DbAdapter, entryId: number, minSample?: number): Adherence {
  const e = getJournalEntry(db, entryId);
  const stored = listChecks(db, entryId);
  const merged = mergeChecks([], stored.map((c) => ({ onDate: c.onDate, state: c.state })));
  const td = e?.rule?.kind === "no_fuliza_draw" ? e.rule.days ?? null : null;
  return summariseAdherence(merged, { minSample, targetDays: td });
}

/** Outcome audit of the entry's rule metric: baseline days before it started vs days since. */
export function auditJournalEntry(db: DbAdapter, entryId: number, nowMs: number, opts: { minPerSide?: number; baselineDays?: number } = {}): OutcomeAudit | null {
  const e = getJournalEntry(db, entryId);
  if (!e || !e.rule) return null;
  const cov = ledgerCoverage(db);
  if (!cov) return auditOutcome([], e.startedOn, opts);
  const baselineDays = opts.baselineDays ?? 56;
  const yesterday = addDays(dayOf(nowMs), -1);
  const toDay = e.endsOn && e.endsOn < yesterday ? e.endsOn : yesterday;
  const fromDay = addDays(e.startedOn, -baselineDays);
  const covFrom = dayOf(cov.fromMs);
  const txs = loadLedger(db, dayStartMs(fromDay), dayStartMs(addDays(toDay, 1)));
  // only days the ledger actually covers contribute; silence outside coverage is not a zero
  const lastCovered = dayOf(cov.throughMs - 86_400_000);
  const series = buildDailySeries(txs, fromDay < covFrom ? covFrom : fromDay, toDay < lastCovered ? toDay : lastCovered, ruleMetric(e.rule).valueOf, dayOf);
  return auditOutcome(series, e.startedOn, { betterWhen: "lower", endOn: e.endsOn, ...opts });
}
