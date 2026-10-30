/** Persistence for alerts_log / alert_prefs. Thin: all decisions live in the pure modules. */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";
import { DAY_MS } from "../expect/eat.js";
import { DEFAULT_GATE_PREFS, gateAlerts, resolveGatePrefs, type GateDecision, type GateLogEntry, type GatePrefs, type GateState } from "./gate.js";
import { evaluateAlertRules, ALERT_RULES } from "./rules.js";
import { computeRuleStats, DEFAULT_DEMOTION, type AlertOutcomeRow, type DemotionPolicy, type RuleStats } from "./stats.js";
import type { AlertRule, AlertSnapshot } from "./types.js";

const GLOBAL = "*";

export function getAlertPrefs(db: DbAdapter): GatePrefs {
  const g = db.get(`SELECT prefs_json FROM alert_prefs WHERE rule_id = ?`, [GLOBAL]);
  const stored: Partial<GatePrefs> = g?.prefs_json ? JSON.parse(g.prefs_json) : {};
  const rows = db.all(`SELECT rule_id, enabled, snoozed_until FROM alert_prefs WHERE rule_id <> ?`, [GLOBAL]);
  const disabled = rows.filter((r) => r.enabled === 0).map((r) => String(r.rule_id));
  const snoozed: Record<string, number> = {};
  for (const r of rows) if (r.snoozed_until != null) snoozed[String(r.rule_id)] = Number(r.snoozed_until);
  return resolveGatePrefs({ ...stored, disabledRules: disabled, snoozedRules: snoozed });
}

export function setGlobalAlertPrefs(db: DbAdapter, patch: Partial<Omit<GatePrefs, "disabledRules" | "snoozedRules">>, now: number): void {
  const g = db.get(`SELECT prefs_json FROM alert_prefs WHERE rule_id = ?`, [GLOBAL]);
  const cur = g?.prefs_json ? JSON.parse(g.prefs_json) : {};
  const next = JSON.stringify({ ...cur, ...patch });
  db.run(`INSERT INTO alert_prefs (rule_id, prefs_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(rule_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`, [GLOBAL, next, now]);
}

function ensureRule(db: DbAdapter, ruleId: string, now: number): void {
  db.run(`INSERT OR IGNORE INTO alert_prefs (rule_id, updated_at) VALUES (?, ?)`, [ruleId, now]);
}

export function setRuleEnabled(db: DbAdapter, ruleId: string, enabled: boolean, now: number): void {
  ensureRule(db, ruleId, now);
  db.run(`UPDATE alert_prefs SET enabled = ?, updated_at = ? WHERE rule_id = ?`, [enabled ? 1 : 0, now, ruleId]);
}
export function snoozeRule(db: DbAdapter, ruleId: string, untilMs: number | null, now: number): void {
  ensureRule(db, ruleId, now);
  db.run(`UPDATE alert_prefs SET snoozed_until = ?, updated_at = ? WHERE rule_id = ?`, [untilMs, now, ruleId]);
}

export function logDelivered(db: DbAdapter, d: GateDecision, now: number): number {
  const c = d.candidate;
  const r = db.run(
    `INSERT INTO alerts_log (rule_id, alert_key, dedupe_key, severity, title, body, redacted_body, action_url, subject_ref, escalated, delivered_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [c.ruleId, c.id, c.dedupeKey, d.effectiveSeverity, c.title, c.body, c.redactedBody, c.action.url, c.subjectRef ?? null, d.escalated ? 1 : 0, now, c.expiresAt],
  );
  return lastInsertId(r);
}

export type AlertInteraction = "opened" | "acted" | "dismissed";
export function markAlert(db: DbAdapter, logId: number, what: AlertInteraction, now: number): void {
  const col = what === "opened" ? "opened_at" : what === "acted" ? "acted_at" : "dismissed_at";
  db.run(`UPDATE alerts_log SET ${col} = COALESCE(${col}, ?) WHERE id = ?`, [now, logId]);
  // acting or dismissing implies it was seen
  if (what !== "opened") db.run(`UPDATE alerts_log SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`, [now, logId]);
}
export function markAlertUseful(db: DbAdapter, logId: number, useful: boolean): void {
  db.run(`UPDATE alerts_log SET useful = ? WHERE id = ?`, [useful ? 1 : 0, logId]);
}
export function snoozeAlert(db: DbAdapter, logId: number, untilMs: number): void {
  db.run(`UPDATE alerts_log SET snooze_until = ? WHERE id = ?`, [untilMs, logId]);
}

/** History the gate needs: everything inside the longest window any rule or pref uses. */
export function loadGateLog(db: DbAdapter, now: number, lookbackMs = 45 * DAY_MS): GateLogEntry[] {
  return db.all(
    `SELECT rule_id, alert_key, dedupe_key, severity, delivered_at, dismissed_at, snooze_until FROM alerts_log WHERE delivered_at >= ? ORDER BY delivered_at`,
    [now - lookbackMs],
  ).map((r) => ({
    ruleId: String(r.rule_id), id: String(r.alert_key), dedupeKey: String(r.dedupe_key), severity: r.severity,
    deliveredAt: Number(r.delivered_at), dismissedAt: r.dismissed_at ?? null, snoozeUntil: r.snooze_until ?? null,
  }));
}

/** Recomputes per-rule counters from alerts_log into alert_prefs (idempotent) and returns the stats. */
export function recomputeRuleStats(db: DbAdapter, now: number, policy: DemotionPolicy = DEFAULT_DEMOTION, neverDemote: ReadonlySet<string> = SAFETY_RULE_IDS): Map<string, RuleStats> {
  const rows: AlertOutcomeRow[] = db.all(`SELECT rule_id, delivered_at, opened_at, acted_at, dismissed_at, useful FROM alerts_log`).map((r) => ({
    ruleId: String(r.rule_id), deliveredAt: Number(r.delivered_at), openedAt: r.opened_at, actedAt: r.acted_at, dismissedAt: r.dismissed_at, useful: r.useful,
  }));
  const stats = computeRuleStats(rows, now, policy, neverDemote);
  for (const s of stats.values()) {
    ensureRule(db, s.ruleId, now);
    db.run(
      `UPDATE alert_prefs SET delivered=?, opened=?, acted=?, dismissed=?, ignored=?, useful_yes=?, useful_no=?, demoted=?, stats_at=?, updated_at=? WHERE rule_id=?`,
      [s.delivered, s.opened, s.acted, s.dismissed, s.ignored, s.usefulYes, s.usefulNo, s.demoted ? 1 : 0, now, now, s.ruleId],
    );
  }
  return stats;
}

export const SAFETY_RULE_IDS: ReadonlySet<string> = new Set(["repeated_failed"]);

/** Rules the user should be told about: auto-demoted for low yield. */
export function listDemotedRules(db: DbAdapter): string[] {
  return db.all(`SELECT rule_id FROM alert_prefs WHERE demoted = 1 ORDER BY rule_id`).map((r) => String(r.rule_id));
}

/** One full pass: rules -> gate -> persist deliveries. Returns every decision (delivered, deferred, suppressed). */
export function runAlertCycle(db: DbAdapter, snapshot: AlertSnapshot, rules: AlertRule[] = ALERT_RULES): { decisions: GateDecision[]; errors: Array<{ ruleId: string; error: string }>; logIds: number[] } {
  const now = snapshot.nowMs;
  const stats = recomputeRuleStats(db, now);
  const { candidates, errors } = evaluateAlertRules(snapshot, rules);
  const state: GateState = { log: loadGateLog(db, now), prefs: getAlertPrefs(db), ruleStats: stats };
  const decisions = gateAlerts(candidates, now, state);
  const logIds: number[] = [];
  for (const d of decisions) if (d.verdict === "deliver") logIds.push(logDelivered(db, d, now));
  return { decisions, errors, logIds };
}

export { DEFAULT_GATE_PREFS };
