/**
 * Delivery gate (F-ALERTS delivery policy). Pure: candidates + history + prefs -> decisions.
 * Order per candidate: expiry, disabled, snooze, dismissal, cooldown (escalation bypasses the last two),
 * quiet hours, then caps applied in deterministic priority order. Safety alerts bypass everything but expiry.
 */
import { dayOf } from "../expect/eat.js";
import { DEFAULT_QUIET, inQuietHours, nextQuietEnd, type QuietHours } from "./quiet.js";
import { SEVERITIES, SEVERITY_RANK, type AlertCandidate, type AlertSeverity } from "./types.js";
import type { RuleStats } from "./stats.js";

export interface GateLogEntry {
  ruleId: string;
  id: string;
  dedupeKey: string;
  severity: AlertSeverity;
  deliveredAt: number;
  dismissedAt?: number | null;
  snoozeUntil?: number | null;
}

export interface GatePrefs {
  quiet: QuietHours;
  caps: { total: number; high: number; normal: number; low: number };
  disabledRules: string[];
  snoozedRules: Record<string, number>;
  /** a dismissed alert (same stable id) stays quiet this long unless it escalates */
  dismissalSuppressMs: number;
  /** lock screen shows amounts/names only when true */
  showDetailsOnLockScreen: boolean;
  demotedCooldownFactor: number;
}

export const DEFAULT_GATE_PREFS: GatePrefs = {
  quiet: DEFAULT_QUIET,
  caps: { total: 6, high: 4, normal: 4, low: 2 },
  disabledRules: [],
  snoozedRules: {},
  dismissalSuppressMs: 3 * 86_400_000,
  showDetailsOnLockScreen: true,
  demotedCooldownFactor: 3,
};

export interface GateState {
  log: GateLogEntry[];
  prefs?: Partial<GatePrefs>;
  ruleStats?: ReadonlyMap<string, RuleStats>;
}

export type GateReason =
  | "expired" | "disabled" | "snoozed" | "dismissed" | "cooldown" | "quiet_hours" | "cap_total" | "cap_severity" | "duplicate" | "ok";

export interface GateDecision {
  candidate: AlertCandidate;
  verdict: "deliver" | "suppress" | "defer";
  reason: GateReason;
  effectiveSeverity: AlertSeverity;
  escalated: boolean;
  demoted: boolean;
  /** for deferred items: first instant they may be delivered */
  deferUntilMs?: number;
  /** text to show on the lock screen */
  publicBody: string;
}

function demote(s: AlertSeverity): AlertSeverity {
  if (s === "safety") return s;
  return s === "high" ? "normal" : "low";
}

export function resolveGatePrefs(p?: Partial<GatePrefs>): GatePrefs {
  return { ...DEFAULT_GATE_PREFS, ...(p ?? {}), caps: { ...DEFAULT_GATE_PREFS.caps, ...(p?.caps ?? {}) }, quiet: { ...DEFAULT_GATE_PREFS.quiet, ...(p?.quiet ?? {}) } };
}

export function gateAlerts(candidates: AlertCandidate[], nowMs: number, state: GateState): GateDecision[] {
  const prefs = resolveGatePrefs(state.prefs);
  const today = dayOf(nowMs);

  // 1) collapse duplicates inside the run: same dedupeKey keeps the highest severity
  const byKey = new Map<string, AlertCandidate>();
  const dupes: AlertCandidate[] = [];
  for (const c of candidates) {
    const cur = byKey.get(c.dedupeKey);
    if (!cur) byKey.set(c.dedupeKey, c);
    else if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[cur.severity]) { dupes.push(cur); byKey.set(c.dedupeKey, c); }
    else dupes.push(c);
  }

  const decide = (c: AlertCandidate): GateDecision => {
    const stat = state.ruleStats?.get(c.ruleId);
    const demoted = !!stat?.demoted && c.severity !== "safety";
    const eff = demoted ? demote(c.severity) : c.severity;
    const publicBody = prefs.showDetailsOnLockScreen ? c.body : c.redactedBody;
    const base = { candidate: c, effectiveSeverity: eff, demoted, publicBody };
    const sameKey = state.log.filter((l) => l.dedupeKey === c.dedupeKey);
    const priorRank = sameKey.reduce((m, l) => Math.max(m, SEVERITY_RANK[l.severity]), 0);
    const escalated = priorRank > 0 && SEVERITY_RANK[eff] > priorRank;
    const out = (verdict: GateDecision["verdict"], reason: GateReason, extra: Partial<GateDecision> = {}): GateDecision =>
      ({ ...base, verdict, reason, escalated, ...extra });

    if (c.expiresAt <= nowMs) return out("suppress", "expired");
    if (eff === "safety") {
      // never gated by quiet hours, caps, snooze, disable or dismissal; only the exact same occurrence is not re-sent inside its cooldown
      const last = sameKey.reduce((m, l) => Math.max(m, l.deliveredAt), -Infinity);
      if (sameKey.length && !escalated && nowMs - last < c.cooldownMs) return out("suppress", "cooldown");
      return out("deliver", "ok");
    }
    if (prefs.disabledRules.includes(c.ruleId)) return out("suppress", "disabled");
    const snoozeRule = prefs.snoozedRules[c.ruleId];
    if (snoozeRule != null && snoozeRule > nowMs) return out("suppress", "snoozed");
    if (state.log.some((l) => (l.id === c.id) && l.snoozeUntil != null && l.snoozeUntil > nowMs)) return out("suppress", "snoozed");

    if (!escalated) {
      const dismissed = state.log.filter((l) => l.id === c.id && l.dismissedAt != null && nowMs - l.dismissedAt < prefs.dismissalSuppressMs);
      if (dismissed.length) return out("suppress", "dismissed");
      const factor = demoted ? prefs.demotedCooldownFactor : 1;
      const last = sameKey.reduce((m, l) => Math.max(m, l.deliveredAt), -Infinity);
      if (sameKey.length && nowMs - last < c.cooldownMs * factor) return out("suppress", "cooldown");
    }
    if (inQuietHours(nowMs, prefs.quiet)) {
      const until = nextQuietEnd(nowMs, prefs.quiet);
      if (until < c.expiresAt) return out("defer", "quiet_hours", { deferUntilMs: until });
      return out("suppress", "expired");
    }
    return out("deliver", "ok");
  };

  const decided = [...byKey.values()].map(decide);
  const dupeDecisions: GateDecision[] = dupes.map((c) => ({
    candidate: c, verdict: "suppress", reason: "duplicate", effectiveSeverity: c.severity, escalated: false, demoted: false,
    publicBody: prefs.showDetailsOnLockScreen ? c.body : c.redactedBody,
  }));

  // 2) caps in priority order: severity desc, nearest expiry, id
  const order = (d: GateDecision) => [-SEVERITY_RANK[d.effectiveSeverity], d.candidate.expiresAt] as const;
  const ready = decided.filter((d) => d.verdict === "deliver" && d.effectiveSeverity !== "safety")
    .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1] || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
  const sentToday = state.log.filter((l) => dayOf(l.deliveredAt) === today && l.severity !== "safety");
  const count: Record<string, number> = { low: 0, normal: 0, high: 0 };
  for (const l of sentToday) count[l.severity] = (count[l.severity] ?? 0) + 1;
  let total = sentToday.length;
  for (const d of ready) {
    const sv = d.effectiveSeverity as "low" | "normal" | "high";
    if (total >= prefs.caps.total) { d.verdict = "suppress"; d.reason = "cap_total"; continue; }
    if ((count[sv] ?? 0) >= prefs.caps[sv]) { d.verdict = "suppress"; d.reason = "cap_severity"; continue; }
    count[sv] = (count[sv] ?? 0) + 1; total++;
  }

  // deterministic output order: deliveries by priority first, then the rest by id
  const rank = (d: GateDecision) => (d.verdict === "deliver" ? 0 : d.verdict === "defer" ? 1 : 2);
  return [...decided, ...dupeDecisions].sort((a, b) =>
    rank(a) - rank(b) || SEVERITY_RANK[b.effectiveSeverity] - SEVERITY_RANK[a.effectiveSeverity] ||
    a.candidate.expiresAt - b.candidate.expiresAt || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0));
}

export { SEVERITIES };
