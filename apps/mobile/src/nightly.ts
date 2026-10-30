import type { SQLiteDatabase } from "expo-sqlite";
import {
  gateFindings, persistFindings, profile, reconcileSecurity, rollup, runAllDetectors, stripPValues,
  type Bucket, type ConfirmedTx, type Finding, type LedgerTx, type ParsedSms, type ProfileResult, type TxScope,
} from "@yako/core";
import { asDbAdapter } from "./db/open";

const NIGHTLY_KEY = "nightly_last_run_at";
const NIGHTLY_INTERVAL_MS = 20 * 3_600_000;

export function nightlyDue(db: SQLiteDatabase, now = Date.now()): boolean {
  try {
    const row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [NIGHTLY_KEY]);
    const last = Number(row?.value ?? 0);
    return !Number.isFinite(last) || last <= 0 || now - last >= NIGHTLY_INTERVAL_MS;
  } catch { return true; }
}

function markNightly(db: SQLiteDatabase, now: number): void {
  try {
    db.runSync(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [NIGHTLY_KEY, String(now)],
    );
  } catch { /* optional */ }
}

/** One pass per ~20h, not on every cold start. Returns null when not due. */
export function runNightlyIfDue(db: SQLiteDatabase, now = Date.now()): NightlySummary | null {
  if (!nightlyDue(db, now)) return null;
  const r = runNightlyOnDevice(db, now);
  markNightly(db, now);
  return r;
}

export interface NightlySummary {
  ms: number;
  txs: number;
  findings: number;
  newFindings: number;
  proposals: number;
  applyProposals: number;
  sessions: number;
}

interface Row {
  id: number; smsId: number | null; provider: string; ref: string | null; kind: string; direction: string;
  amount: number; fee: number | null; balanceAfter: number | null; account: string | null;
  occurredAt: number; template: string; parserVersion: string; chainStatus: string; scope: string;
  cpKey: string | null; cpRaw: string | null; cpDisplay: string | null; label: string | null;
  balanceAfterCents: number | null;
  lat: number | null; lng: number | null; batteryPct: number | null; isCharging: number | null;
  stepDelta: number | null; circadianPhase: string | null;
  itemsJson: string | null; habitNamesJson: string | null; isCredit: number;
}

/**
 * G10: one deterministic nightly pass that is actually called by the app.
 * detectors -> persisted findings; confirmed history -> gated proposals; weekly/monthly -> sessions.
 * No model, no network. Safe to run after every ingest; ~200ms for a few hundred rows.
 */
export function runNightlyOnDevice(db: SQLiteDatabase, now = Date.now()): NightlySummary {
  const t0 = Date.now();
  const rows = db.getAllSync<Row>(
    `SELECT t.id, t.sms_id AS smsId, t.provider, t.ref, t.kind, t.direction, t.amount, t.fee,
            t.balance_after AS balanceAfter, t.account, t.occurred_at AS occurredAt, t.template,
            t.parser_version AS parserVersion, t.chain_status AS chainStatus, t.scope,
            t.balance_after AS balanceAfterCents,
            ctx.lat AS lat, ctx.lng AS lng, ctx.battery_pct AS batteryPct,
            ctx.is_charging AS isCharging, ctx.step_delta AS stepDelta, ctx.circadian_phase AS circadianPhase,
            c.key AS cpKey, c.raw_names AS cpRaw, c.display_name AS cpDisplay,
            l.name AS label,
            (SELECT json_group_array(i.name) FROM tx_items ti JOIN items i ON i.id = ti.item_id
              WHERE ti.tx_id = t.id AND ti.confirmed_at IS NOT NULL) AS itemsJson,
            (SELECT json_group_array(DISTINCT h.name) FROM tx_items ti JOIN items i ON i.id = ti.item_id
              JOIN habits h ON h.id = i.habit_id WHERE ti.tx_id = t.id AND ti.confirmed_at IS NOT NULL) AS habitNamesJson,
            EXISTS (SELECT 1 FROM transactions f WHERE f.role = 'funding_notice' AND f.ref = t.event_ref) AS isCredit
       FROM tx_events t
       LEFT JOIN tx_context ctx ON ctx.tx_id = t.id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN tx_labels tl ON tl.rowid = (
         SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id AND x.confirmed_at IS NOT NULL
          ORDER BY x.confirmed_at DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id`,
  );

  const txRows = rows.map((r) => ({ ...r, cpName: cpName(r.cpRaw, r.cpDisplay) }));
  // B6: Fuliza draws (and Okoa/Kopa notices) are funding notices, not wallet cash, so they are outside
  // tx_events. Debt analysis still needs them; give them one stable lender key so draws and repayments group.
  const loanNotices = db.getAllSync<{ id: number; provider: string; occurredAt: number; amount: number; fee: number | null; template: string; scope: string }>(
    `SELECT id, provider, occurred_at AS occurredAt, amount, fee, template, scope
       FROM transactions
      WHERE role = 'funding_notice'
        AND (template LIKE 'mpesa.fuliza_draw%' OR template LIKE 'telco.okoa%' OR template LIKE 'airtel.airtime_loan%' OR template LIKE 'airtel.kopa_repay%')`,
  );
  const loanKey = (template: string) => /fuliza/i.test(template) ? "n:fuliza" : /okoa/i.test(template) ? "n:okoa jahazi" : "n:airtel kopa";
  const loanName = (template: string) => /fuliza/i.test(template) ? "Fuliza" : /okoa/i.test(template) ? "Okoa Jahazi" : "Airtel Kopa";
  const loanLedger: LedgerTx[] = loanNotices.map((r) => ({
    id: String(r.id), occurredAt: r.occurredAt,
    direction: /repay/i.test(r.template) ? "out" : "in",
    amount: r.amount, counterpartyKey: loanKey(r.template), counterpartyName: loanName(r.template),
    kind: /repay/i.test(r.template) ? "loan_repay" : "loan_draw",
    fee: r.fee, label: null, scope: (r.scope as TxScope) ?? "unknown", provider: r.provider,
    balanceAfterCents: null,
  }));
  const ledger: LedgerTx[] = [...txRows.map((r) => ({
    id: String(r.id), occurredAt: r.occurredAt, direction: r.direction as LedgerTx["direction"],
    amount: r.amount,
    counterpartyKey: r.kind === "loan_repay" && /fuliza/i.test(r.template) ? "n:fuliza" : r.cpKey,
    counterpartyName: r.kind === "loan_repay" && /fuliza/i.test(r.template) ? "Fuliza" : r.cpName,
    kind: r.kind as LedgerTx["kind"],
    fee: r.fee, label: r.label, scope: (r.scope as TxScope) ?? "unknown", provider: r.provider,
    balanceAfterCents: r.balanceAfterCents,
    lat: r.lat, lng: r.lng, batteryPct: r.batteryPct,
    isCharging: r.isCharging == null ? null : Boolean(r.isCharging),
    stepDelta: r.stepDelta, circadianPhase: r.circadianPhase,
    items: (() => { try { const a = JSON.parse(r.itemsJson ?? "[]") as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })(),
    habits: (() => { try { const a = JSON.parse(r.habitNamesJson ?? "[]") as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; } })(),
    funding: r.isCredit ? ("credit" as const) : ("wallet" as const),
  })), ...loanLedger];
  const findings: Finding[] = gateFindings(runAllDetectors(ledger)).map((f) => ({ ...f, title: stripPValues(f.title) }));
  const adapter = asDbAdapter(db);
  const existing = new Set((db.getAllSync<{ id: string }>(`SELECT id FROM findings`)).map((r) => r.id));
  const saved = persistFindings(adapter, findings, now);

  const confirmed: ConfirmedTx[] = txRows.filter((r) => r.label).map((r) => ({
    parsed: reconstruct(r),
    label: r.label!,
    cpKey: r.cpKey,
  }));
  const prof: ProfileResult = profile(confirmed, { maxNewRules: 2 });

  let proposals = 0;
  let applyProposals = 0;
  for (const p of prof.proposals) {
    const v = prof.verdicts.get(p.id);
    const status = v?.verdict === "apply" ? "proposed" : "rejected";
    if (v?.verdict === "apply") applyProposals++;
    db.runSync(
      `INSERT OR REPLACE INTO proposals (id, origin, type, patch, rationale, evidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.origin, p.type, JSON.stringify(p.patch), p.rationale ?? null, JSON.stringify(v ?? null), status, p.createdAt],
    );
    proposals++;
  }

  const rollupRows = ledger.map((t) => ({
    occurredAt: t.occurredAt, direction: t.direction, amount: t.amount, fee: t.fee,
    kind: t.kind, label: t.label, cpKey: t.counterpartyKey, chainStatus: "unknown", provider: t.provider,
  }));
  const weekly = rollup(rollupRows, "weekly");
  const monthly = rollup(rollupRows, "monthly");
  for (const [cadence, buckets] of [["weekly", weekly], ["monthly", monthly]] as const) {
    for (const b of buckets.slice(0, 12)) {
      db.runSync(
        `INSERT INTO sessions (cadence, period_start, period_end, state, summary)
         VALUES (?, ?, ?, 'open', ?)
         ON CONFLICT(cadence, period_start) DO UPDATE SET period_end = excluded.period_end, summary = excluded.summary`,
        [cadence, b.periodStart, b.periodEnd, JSON.stringify(b)],
      );
    }
  }

  try { reconcileSecurity(adapter, now); } catch { /* non-fatal */ }

  return {
    ms: Date.now() - t0,
    txs: ledger.length,
    findings: findings.length,
    newFindings: saved.inserted,
    proposals,
    applyProposals,
    sessions: weekly.length + monthly.length,
  };
}

function cpName(raw: string | null, display: string | null): string | null {
  if (display) return display;
  if (!raw) return null;
  try { return (JSON.parse(raw) as string[])[0] ?? null; } catch { return null; }
}

function reconstruct(r: Row): ParsedSms {
  return {
    provider: r.provider as ParsedSms["provider"],
    ref: r.ref,
    kind: r.kind as ParsedSms["kind"],
    direction: r.direction as ParsedSms["direction"],
    amount: r.amount,
    fee: r.fee,
    balanceAfter: r.balanceAfter,
    counterpartyName: cpName(r.cpRaw, r.cpDisplay),
    counterpartyId: null,
    account: r.account,
    occurredAt: r.occurredAt,
    template: r.template,
    parserVersion: r.parserVersion,
  };
}

export function weeklyBuckets(db: SQLiteDatabase, limit = 8): Bucket[] {
  return db.getAllSync<{ summary: string }>(
    `SELECT summary FROM sessions WHERE cadence = 'weekly' ORDER BY period_start DESC LIMIT ?`, [limit],
  ).flatMap((r) => {
    try { return [JSON.parse(r.summary) as Bucket]; } catch { return []; }
  }).reverse();
}

export function storedProposals(db: SQLiteDatabase, limit = 20): Array<{ id: string; type: string; rationale: string | null; verdict: string; status: string }> {
  return db.getAllSync<{ id: string; type: string; rationale: string | null; evidence: string; status: string }>(
    `SELECT id, type, rationale, evidence, status FROM proposals ORDER BY created_at DESC LIMIT ?`, [limit],
  ).map((r) => {
    let verdict = "abstain";
    try { verdict = (JSON.parse(r.evidence) as { verdict?: string })?.verdict ?? "abstain"; } catch { /* keep */ }
    return { id: r.id, type: r.type, rationale: r.rationale, verdict, status: r.status };
  });
}
