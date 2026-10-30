import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  classifyOutcome, computeRuleStats, DEFAULT_QUIET, gateAlerts, inQuietHours, isNoisy, listDemotedRules, loadGateLog, logDelivered, markAlert,
  markAlertUseful, minuteOfDayEat, nextQuietEnd, recomputeRuleStats, runAlertCycle, setGlobalAlertPrefs, setRuleEnabled, snoozeAlert, snoozeRule,
  getAlertPrefs, type AlertCandidate, type AlertSeverity, type GateLogEntry, type AlertSnapshot,
} from "../src/alerts/index.js";
import { migrate } from "../src/db/migrate.js";
import { adapter, at } from "./fixtures.js";

const NOON = at(2026, 10, 26, 12);
const H = 3_600_000, D = 86_400_000;
const cand = (o: Partial<AlertCandidate> = {}): AlertCandidate => ({
  ruleId: "r1", id: "s1", severity: "normal", title: "t", body: "KES 100 to Jane", redactedBody: "Something needs attention.",
  action: { kind: "deeplink", url: "yako://x" }, dedupeKey: "k1", cooldownMs: 6 * H, expiresAt: NOON + D, ...o,
});
const entry = (o: Partial<GateLogEntry> = {}): GateLogEntry => ({ ruleId: "r1", id: "s1", dedupeKey: "k1", severity: "normal", deliveredAt: NOON - H, ...o });
const one = (c: AlertCandidate, now = NOON, state: Parameters<typeof gateAlerts>[2] = { log: [] }) => gateAlerts([c], now, state)[0]!;

test("quiet hours: Africa/Nairobi, wraps midnight, boundaries", () => {
  assert.equal(minuteOfDayEat(at(2026, 10, 26, 0)), 0);
  assert.equal(inQuietHours(at(2026, 10, 26, 22)), true);
  assert.equal(inQuietHours(at(2026, 10, 26, 21) + 59 * 60_000), false);
  assert.equal(inQuietHours(at(2026, 10, 27, 6) + 59 * 60_000), true);
  assert.equal(inQuietHours(at(2026, 10, 27, 7)), false);
  assert.equal(inQuietHours(at(2026, 10, 26, 3)), true);
  // UTC 19:00 = 22:00 EAT
  assert.equal(inQuietHours(Date.UTC(2026, 9, 26, 19, 0)), true);
  assert.equal(inQuietHours(Date.UTC(2026, 9, 26, 18, 59)), false);
  assert.equal(nextQuietEnd(at(2026, 10, 26, 23)), at(2026, 10, 27, 7));
  assert.equal(nextQuietEnd(at(2026, 10, 27, 2)), at(2026, 10, 27, 7));
  assert.equal(nextQuietEnd(NOON), NOON);
  assert.equal(inQuietHours(NOON, { startMin: 600, endMin: 600 }), false);
  assert.equal(nextQuietEnd(at(2026, 10, 26, 13), { startMin: 12 * 60, endMin: 14 * 60 }), at(2026, 10, 26, 14)); // non-wrapping
});

test("alerts show details by default (D108) and can be redacted", () => {
  const d = one(cand());
  assert.deepEqual([d.verdict, d.reason], ["deliver", "ok"]);
  assert.equal(d.publicBody, "KES 100 to Jane");
  assert.equal(one(cand(), NOON, { log: [], prefs: { showDetailsOnLockScreen: false } }).publicBody, "Something needs attention.");
});

test("expired, disabled, snoozed (rule + alert), cooldown", () => {
  assert.equal(one(cand({ expiresAt: NOON })).reason, "expired");
  assert.equal(one(cand(), NOON, { log: [], prefs: { disabledRules: ["r1"] } }).reason, "disabled");
  assert.equal(one(cand(), NOON, { log: [], prefs: { snoozedRules: { r1: NOON + 1 } } }).reason, "snoozed");
  assert.equal(one(cand(), NOON, { log: [], prefs: { snoozedRules: { r1: NOON } } }).verdict, "deliver"); // snooze ended
  assert.equal(one(cand(), NOON, { log: [entry({ snoozeUntil: NOON + H, dedupeKey: "old" })] }).reason, "snoozed");
  assert.equal(one(cand(), NOON, { log: [entry()] }).reason, "cooldown");
  assert.equal(one(cand(), NOON, { log: [entry({ deliveredAt: NOON - 6 * H })] }).verdict, "deliver"); // cooldown elapsed exactly
  assert.equal(one(cand(), NOON, { log: [entry({ dedupeKey: "other", deliveredAt: NOON - H })] }).verdict, "deliver"); // different occurrence
});

test("dismissal suppresses repeats of the same subject for the window, even with a new dedupe key", () => {
  const dismissed = entry({ dedupeKey: "k0", deliveredAt: NOON - 2 * D, dismissedAt: NOON - 2 * D + H });
  assert.equal(one(cand(), NOON, { log: [dismissed] }).reason, "dismissed");
  const old = entry({ dedupeKey: "k0", deliveredAt: NOON - 9 * D, dismissedAt: NOON - 9 * D });
  assert.equal(one(cand(), NOON, { log: [old] }).verdict, "deliver");
  assert.equal(one(cand({ id: "other" }), NOON, { log: [dismissed] }).verdict, "deliver"); // other subject unaffected
});

test("escalation: higher severity bypasses cooldown and dismissal, same severity does not", () => {
  const prior = entry({ severity: "normal", dismissedAt: NOON - H });
  const esc = one(cand({ severity: "high" }), NOON, { log: [prior] });
  assert.deepEqual([esc.verdict, esc.escalated], ["deliver", true]);
  assert.equal(one(cand({ severity: "normal" }), NOON, { log: [prior] }).verdict, "suppress");
  // after escalation delivered, a repeat of the same high is in cooldown
  const log = [prior, entry({ severity: "high", deliveredAt: NOON - 1000 })];
  assert.equal(one(cand({ severity: "high" }), NOON, { log }).reason, "dismissed");
  assert.equal(one(cand({ severity: "high" }), NOON, { log: [log[1]!] }).reason, "cooldown");
  // does not bypass a snooze
  assert.equal(one(cand({ severity: "high" }), NOON, { log: [prior], prefs: { snoozedRules: { r1: NOON + H } } }).reason, "snoozed");
});

test("quiet hours defer (with the exact release time); expiry before release suppresses", () => {
  const night = at(2026, 10, 26, 23);
  const d = one(cand({ expiresAt: night + 12 * H }), night);
  assert.deepEqual([d.verdict, d.reason, d.deferUntilMs], ["defer", "quiet_hours", at(2026, 10, 27, 7)]);
  const d2 = one(cand({ expiresAt: night + 2 * H }), night);
  assert.deepEqual([d2.verdict, d2.reason], ["suppress", "expired"]);
  const high = one(cand({ severity: "high", expiresAt: night + 12 * H }), night);
  assert.equal(high.verdict, "defer"); // high is not safety
  const custom = one(cand(), night, { log: [], prefs: { quiet: { startMin: 0, endMin: 0 } } });
  assert.equal(custom.verdict, "deliver");
});

test("safety alerts bypass quiet hours, caps, disable, snooze, dismissal; only exact repeats in cooldown are held", () => {
  const night = at(2026, 10, 27, 3);
  const s = cand({ ruleId: "safe", id: "f1", dedupeKey: "f:1", severity: "safety", cooldownMs: 30 * 60_000, expiresAt: night + 6 * H });
  const hostile = { log: [entry({ ruleId: "safe", id: "f1", dedupeKey: "older", severity: "safety", deliveredAt: night - 5 * H, dismissedAt: night - 4 * H })],
    prefs: { disabledRules: ["safe"], snoozedRules: { safe: night + D }, caps: { total: 0, high: 0, normal: 0, low: 0 } } };
  assert.equal(one(s, night, hostile).verdict, "deliver");
  const spent = Array.from({ length: 20 }, (_, i) => entry({ dedupeKey: `x${i}`, id: `x${i}`, deliveredAt: night - H }));
  assert.equal(one(s, at(2026, 10, 27, 3), { log: spent }).verdict, "deliver");
  assert.equal(one(s, night, { log: [entry({ ruleId: "safe", id: "f1", dedupeKey: "f:1", severity: "safety", deliveredAt: night - 60_000 })] }).reason, "cooldown");
  assert.equal(one(s, night, { log: [], prefs: {} }).effectiveSeverity, "safety");
  // safety is never demoted
  const stats = new Map([["safe", { ruleId: "safe", demoted: true } as any]]);
  assert.equal(one(s, night, { log: [], ruleStats: stats }).effectiveSeverity, "safety");
});

test("caps: per severity, total, safety excluded, priority order decides who is cut", () => {
  const mk = (n: number, severity: AlertSeverity, extra: Partial<AlertCandidate> = {}) =>
    Array.from({ length: n }, (_, i) => cand({ id: `${severity}${i}`, dedupeKey: `${severity}${i}`, severity, ...extra }));
  const out = gateAlerts([...mk(5, "low"), ...mk(5, "normal"), ...mk(5, "high")], NOON, { log: [] });
  const delivered = out.filter((d) => d.verdict === "deliver");
  assert.equal(delivered.length, 6); // total cap 6
  assert.deepEqual(delivered.map((d) => d.effectiveSeverity), ["high", "high", "high", "high", "normal", "normal"]); // high cap 4 then normal
  assert.ok(out.filter((d) => d.reason === "cap_total").length >= 1);
  const capped = gateAlerts(mk(3, "low"), NOON, { log: [] });
  assert.equal(capped.filter((d) => d.verdict === "deliver").length, 2);
  assert.equal(capped.find((d) => d.verdict === "suppress")?.reason, "cap_severity");
  // earlier deliveries today count; yesterday's do not
  const today = [entry({ id: "a", dedupeKey: "a", severity: "low", deliveredAt: NOON - 3 * H }), entry({ id: "b", dedupeKey: "b", severity: "low", deliveredAt: NOON - 2 * H })];
  const y = [entry({ id: "c", dedupeKey: "c", severity: "low", deliveredAt: NOON - D }), entry({ id: "d", dedupeKey: "d", severity: "low", deliveredAt: NOON - D })];
  assert.equal(gateAlerts(mk(3, "low"), NOON, { log: today }).filter((d) => d.verdict === "deliver").length, 0);
  assert.equal(gateAlerts(mk(3, "low"), NOON, { log: y }).filter((d) => d.verdict === "deliver").length, 2);
  // safety doesn't consume the cap
  const saf = [entry({ id: "s", dedupeKey: "s", severity: "safety", deliveredAt: NOON - H })];
  assert.equal(gateAlerts(mk(2, "low"), NOON, { log: saf }).filter((d) => d.verdict === "deliver").length, 2);
  // custom caps
  assert.equal(gateAlerts(mk(5, "normal"), NOON, { log: [], prefs: { caps: { total: 2, high: 1, normal: 1, low: 1 } } }).filter((d) => d.verdict === "deliver").length, 1);
});

test("same-run duplicates keep the highest severity; ordering is deterministic", () => {
  const out = gateAlerts([cand({ severity: "low" }), cand({ severity: "high" }), cand({ id: "z", dedupeKey: "kz" }), cand({ id: "a", dedupeKey: "ka" })], NOON, { log: [] });
  assert.equal(out.filter((d) => d.reason === "duplicate").length, 1);
  assert.equal(out[0]!.effectiveSeverity, "high");
  const again = gateAlerts([cand({ id: "a", dedupeKey: "ka" }), cand({ id: "z", dedupeKey: "kz" }), cand({ severity: "high" }), cand({ severity: "low" })], NOON, { log: [] });
  assert.deepEqual(out.map((d) => d.candidate.dedupeKey + d.verdict), again.map((d) => d.candidate.dedupeKey + d.verdict));
});

test("counter-metrics: outcome classification and rates", () => {
  const T = NOON;
  assert.equal(classifyOutcome({ ruleId: "r", deliveredAt: T - H }, T), "pending");
  assert.equal(classifyOutcome({ ruleId: "r", deliveredAt: T - 3 * D }, T), "ignored");
  assert.equal(classifyOutcome({ ruleId: "r", deliveredAt: T - 3 * D, openedAt: T - 3 * D }, T), "opened");
  assert.equal(classifyOutcome({ ruleId: "r", deliveredAt: T - 3 * D, openedAt: 1, dismissedAt: 2 }, T), "dismissed");
  assert.equal(classifyOutcome({ ruleId: "r", deliveredAt: T - 3 * D, dismissedAt: 1, actedAt: 2 }, T), "acted");
  const rows = [
    ...Array.from({ length: 2 }, () => ({ ruleId: "good", deliveredAt: T - 5 * D, actedAt: T - 5 * D + 1 })),
    { ruleId: "good", deliveredAt: T - 5 * D, dismissedAt: T }, { ruleId: "good", deliveredAt: T - H, useful: 1 }, { ruleId: "good", deliveredAt: T - 5 * D, useful: 0 },
  ];
  const s = computeRuleStats(rows, T).get("good")!;
  assert.deepEqual([s.delivered, s.acted, s.dismissed, s.ignored, s.pending, s.resolved], [5, 2, 1, 1, 1, 4]);
  assert.equal(s.actedRate, 0.5); assert.equal(s.dismissedRate, 0.25); assert.equal(s.ignoredRate, 0.25);
  assert.deepEqual([s.usefulYes, s.usefulNo], [1, 1]);
  assert.equal(s.demoted, false);
});

test("auto-demotion: only with enough evidence, never safety, reversible, and it changes gating", () => {
  const T = NOON;
  const noisy = (n: number, acted = 0) => Array.from({ length: n }, (_, i) => ({ ruleId: "noisy", deliveredAt: T - 10 * D, ...(i < acted ? { actedAt: T - 9 * D } : { dismissedAt: T - 9 * D }) }));
  assert.equal(computeRuleStats(noisy(9), T).get("noisy")!.demoted, false); // under min sample
  assert.equal(computeRuleStats(noisy(10), T).get("noisy")!.demoted, true);
  assert.equal(computeRuleStats(noisy(10, 1), T).get("noisy")!.demoted, true); // 10% acted is still the ceiling
  assert.equal(computeRuleStats(noisy(10, 2), T).get("noisy")!.demoted, false);
  assert.equal(computeRuleStats(noisy(10), T, undefined, new Set(["noisy"])).get("noisy")!.demoted, false);
  assert.equal(isNoisy({ ruleId: "x", delivered: 20, acted: 0, dismissed: 0, opened: 20, ignored: 0, pending: 0, usefulYes: 0, usefulNo: 0, resolved: 20, actedRate: 0, dismissedRate: 0, ignoredRate: 0, demoted: false }), false); // opened but not acted is not "noise"
  // gating effect: severity one lower, cooldown x3
  const stats = computeRuleStats(noisy(10), T);
  const d = one(cand({ ruleId: "noisy", severity: "high", cooldownMs: 2 * H }), T, { log: [], ruleStats: stats });
  assert.deepEqual([d.demoted, d.effectiveSeverity], [true, "normal"]);
  assert.equal(one(cand({ ruleId: "noisy", severity: "low" }), T, { log: [], ruleStats: stats }).effectiveSeverity, "low");
  const held = one(cand({ ruleId: "noisy", cooldownMs: 2 * H }), T, { log: [entry({ ruleId: "noisy", deliveredAt: T - 4 * H })], ruleStats: stats });
  assert.equal(held.reason, "cooldown"); // 4h < 2h*3
  const free = one(cand({ ruleId: "noisy", cooldownMs: 2 * H }), T, { log: [entry({ ruleId: "noisy", deliveredAt: T - 4 * H })] });
  assert.equal(free.verdict, "deliver");
  // reversible: new acted history lifts the flag
  assert.equal(computeRuleStats([...noisy(10), ...Array.from({ length: 10 }, () => ({ ruleId: "noisy", deliveredAt: T - 8 * D, actedAt: T - 8 * D }))], T).get("noisy")!.demoted, false);
});

function db() {
  const raw = new DatabaseSync(":memory:");
  const a = adapter(raw); migrate(a);
  return { raw, a };
}

test("store: log, interactions, usefulness counters, demoted listing, prefs", () => {
  const { a } = db();
  const d = one(cand({ ruleId: "noisy" }));
  const ids = Array.from({ length: 10 }, (_, i) => logDelivered(a, { ...d, candidate: { ...d.candidate, id: `n${i}`, dedupeKey: `n${i}` } }, NOON - 10 * D));
  for (const id of ids) markAlert(a, id, "dismissed", NOON - 9 * D);
  const okId = logDelivered(a, d, NOON - H);
  markAlert(a, okId, "acted", NOON);
  markAlertUseful(a, okId, true);
  const row = a.get(`SELECT * FROM alerts_log WHERE id = ?`, [okId]);
  assert.ok(row.acted_at && row.opened_at, "acting implies opened");
  markAlert(a, okId, "acted", NOON + 99);
  assert.equal(a.get(`SELECT acted_at FROM alerts_log WHERE id = ?`, [okId]).acted_at, NOON, "first timestamp wins");
  const stats = recomputeRuleStats(a, NOON);
  const n = stats.get("noisy")!;
  assert.deepEqual([n.delivered, n.acted, n.dismissed, n.demoted], [11, 1, 10, true]); // acted 1/11 <= 10%, noise 10/11
  assert.deepEqual(listDemotedRules(a), ["noisy"]);
  const p = a.get(`SELECT * FROM alert_prefs WHERE rule_id = 'noisy'`);
  assert.deepEqual([p.delivered, p.acted, p.dismissed, p.useful_yes, p.demoted], [11, 1, 10, 1, 1]);
  assert.equal(recomputeRuleStats(a, NOON).get("noisy")!.delivered, 11, "idempotent"); 
  // safety rule ids are never demoted even with bad history
  const sd = one(cand({ ruleId: "repeated_failed", severity: "safety", id: "f", dedupeKey: "f" }));
  for (let i = 0; i < 12; i++) { const id = logDelivered(a, { ...sd, candidate: { ...sd.candidate, id: `f${i}`, dedupeKey: `f${i}` } }, NOON - 10 * D); markAlert(a, id, "dismissed", NOON - 9 * D); }
  assert.equal(recomputeRuleStats(a, NOON).get("repeated_failed")!.demoted, false);
  assert.equal(a.get(`SELECT useful FROM alerts_log WHERE id = ?`, [okId]).useful, 1);
  snoozeAlert(a, okId, NOON + H);
  assert.ok(loadGateLog(a, NOON).some((l) => l.snoozeUntil === NOON + H));
  assert.equal(loadGateLog(a, NOON, H).length, 1, "lookback window");
});

test("store prefs: global quiet/caps, per-rule enable and snooze round-trip into the gate", () => {
  const { a } = db();
  assert.deepEqual(getAlertPrefs(a).quiet, DEFAULT_QUIET);
  setGlobalAlertPrefs(a, { quiet: { startMin: 23 * 60, endMin: 6 * 60 }, caps: { total: 3, high: 2, normal: 2, low: 1 }, showDetailsOnLockScreen: true }, NOON);
  setGlobalAlertPrefs(a, { dismissalSuppressMs: D }, NOON);
  setRuleEnabled(a, "low_float", false, NOON);
  snoozeRule(a, "fee_drag", NOON + H, NOON);
  const p = getAlertPrefs(a);
  assert.deepEqual([p.quiet.startMin, p.caps.total, p.showDetailsOnLockScreen, p.dismissalSuppressMs], [23 * 60, 3, true, D]);
  assert.deepEqual(p.disabledRules, ["low_float"]);
  assert.equal(p.snoozedRules.fee_drag, NOON + H);
  snoozeRule(a, "fee_drag", null, NOON);
  assert.equal(getAlertPrefs(a).snoozedRules.fee_drag, undefined);
  setRuleEnabled(a, "low_float", true, NOON);
  assert.deepEqual(getAlertPrefs(a).disabledRules, []);
});

test("runAlertCycle end to end: delivers once, then cooldown; dismissal sticks; night defers", () => {
  const { a } = db();
  const snap = (nowMs: number): AlertSnapshot => ({ nowMs, float: { balanceCents: 1000, freeFloatCents: -5_000, daysToZeroExpected: null, daysToZeroPessimistic: null, quality: "ok" } });
  const r1 = runAlertCycle(a, snap(NOON));
  assert.equal(r1.logIds.length, 1);
  assert.equal(r1.decisions.find((d) => d.verdict === "deliver")!.candidate.ruleId, "low_float");
  const r2 = runAlertCycle(a, snap(NOON + H));
  assert.equal(r2.logIds.length, 0);
  assert.equal(r2.decisions[0]!.reason, "cooldown");
  markAlert(a, r1.logIds[0]!, "dismissed", NOON + 2 * H);
  const r3 = runAlertCycle(a, snap(NOON + 13 * H - 1)); // next cooldown window but still same day key
  assert.equal(r3.logIds.length, 0);
  const night = runAlertCycle(a, snap(at(2026, 10, 28, 23)));
  assert.deepEqual(night.decisions.map((d) => d.verdict), ["suppress"]); // dismissed 2 days earlier, within 3-day window
  const fresh = db().a;
  const expiring = runAlertCycle(fresh, snap(at(2026, 10, 26, 23)));
  assert.deepEqual([expiring.decisions[0]!.verdict, expiring.decisions[0]!.reason], ["suppress", "expired"]); // a today-only alert dies in the night
  const n = runAlertCycle(fresh, { nowMs: at(2026, 10, 26, 23), obligations: [{ id: 1, name: "Rent", dueOn: "2026-10-20", remainingCents: 100 }] });
  assert.deepEqual([n.decisions[0]!.verdict, n.decisions[0]!.deferUntilMs], ["defer", at(2026, 10, 27, 7)]);
  assert.equal(fresh.get(`SELECT COUNT(*) c FROM alerts_log`).c, 0, "deferred items are not logged as delivered");
});
