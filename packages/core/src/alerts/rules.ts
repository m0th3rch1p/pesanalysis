/** Alert rule registry. Each rule is a pure function over a snapshot returning candidate alerts. */
import { DAY_MS, dayOf, diffDays, dayStartMs, addDays } from "../expect/eat.js";
import { HOUR_MS, endOfDayEat } from "./quiet.js";
import type { AlertCandidate, AlertConfig, AlertRule, AlertSeverity, AlertSnapshot } from "./types.js";

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  lowFloatCents: 20_000,
  dueSoonDays: 3,
  daysToZeroWithin: 3,
  budgetLevels: [50, 80, 100],
  fulizaAgeDays: { low: 2, normal: 4, high: 7 },
  tariffMinSavingCents: 1_000,
  tariffMaxAmountGiveUpFraction: 0.1,
  failedWindowMs: 30 * 60_000,
  failedMinCount: 3,
  bundleLowFraction: 0.2,
  bundleVeryLowFraction: 0.1,
  unusualTxMultiple: 2,
  unusualDayMultiple: 1.5,
  unusualMinSample: 20,
  unusualMinCents: 50_000,
  feeDragShare: 0.03,
  feeDragMinCents: 30_000,
};

export function fmtKes(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}KES ${w}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

const link = (path: string) => ({ kind: "deeplink" as const, url: `yako://${path}` });

function mk(c: Omit<AlertCandidate, "action"> & { path: string; evidencePath?: string }): AlertCandidate {
  const { path, evidencePath, ...rest } = c;
  const action = link(path);
  const evidenceUrl = action.url;
  return {
    ...rest, action, evidenceUrl,
    what: rest.what ?? rest.title,
    when: rest.when ?? "now",
    stake: rest.stake ?? rest.body,
    actions: rest.actions ?? [{ kind: "open", label: "Open", url: action.url }],
  };
}

const lowFloat: AlertRule = {
  id: "low_float", description: "Free float is below the floor or negative", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const f = s.float;
    if (!f || f.quality === "unknown" || f.freeFloatCents == null) return [];
    const day = dayOf(s.nowMs);
    const free = f.freeFloatCents;
    let level: "negative" | "low" | null = null;
    if (free < 0) level = "negative"; else if (free < cfg.lowFloatCents) level = "low";
    if (!level) return [];
    const severity: AlertSeverity = level === "negative" ? "high" : "normal";
    return [mk({
      ruleId: "low_float", id: "low_float", severity, subjectRef: "float",
      title: level === "negative" ? "Committed money exceeds what you have" : "Free float is low",
      body: level === "negative"
        ? `Balance minus what is due and set aside is ${fmtKes(free)}.`
        : `Only ${fmtKes(free)} is free after dues and set-asides.`,
      redactedBody: "Your available money needs attention.",
      dedupeKey: `low_float:${day}:${level}`, cooldownMs: 12 * HOUR_MS, expiresAt: endOfDayEat(s.nowMs), path: "today/float",
    })];
  },
};

const daysToZero: AlertRule = {
  id: "days_to_zero", description: "Projected balance reaches zero within a few days", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const f = s.float;
    if (!f || f.quality === "unknown") return [];
    const e = f.daysToZeroExpected, p = f.daysToZeroPessimistic;
    let severity: AlertSeverity | null = null; let d: number | null = null;
    if (e != null && e <= cfg.daysToZeroWithin) { severity = "high"; d = e; }
    else if (p != null && p <= cfg.daysToZeroWithin) { severity = "normal"; d = p; }
    if (!severity || d == null) return [];
    const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
    return [mk({
      ruleId: "days_to_zero", id: "days_to_zero", severity, subjectRef: "float",
      title: "Money may run out soon",
      body: `At the ${severity === "high" ? "usual" : "pessimistic"} spending pace the balance reaches zero ${when}.`,
      redactedBody: "Your balance may run out soon.",
      dedupeKey: `days_to_zero:${dayOf(s.nowMs)}`, cooldownMs: 12 * HOUR_MS, expiresAt: endOfDayEat(s.nowMs), path: "today/float",
    })];
  },
};

const obligationDue: AlertRule = {
  id: "obligation_due_soon", description: "An obligation is due within a few days", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const today = dayOf(s.nowMs);
    const out: AlertCandidate[] = [];
    for (const o of s.obligations ?? []) {
      if (o.remainingCents <= 0) continue;
      const d = diffDays(o.dueOn, today);
      if (d < 0 || d > cfg.dueSoonDays) continue;
      const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
      out.push(mk({
        ruleId: "obligation_due_soon", id: `obl:${o.id}`, severity: d === 0 ? "high" : "normal", subjectRef: `obligation:${o.id}`,
        title: `${o.name} due ${when}`, body: `${fmtKes(o.remainingCents)} is due ${when} (${o.dueOn}).`,
        redactedBody: "A payment is coming due.",
        dedupeKey: `obl_due:${o.id}:${o.dueOn}`, cooldownMs: 20 * HOUR_MS, expiresAt: dayStartMs(addDays(o.dueOn, 1)),
        path: `plan/due/${o.id}`,
      }));
    }
    return out;
  },
};

const obligationAtRisk: AlertRule = {
  id: "obligation_at_risk", description: "Projected money before a known bill is below what the bill needs", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const f = s.float;
    if (!f || f.balanceCents == null) return [];
    const today = dayOf(s.nowMs);
    const out: AlertCandidate[] = [];
    for (const o of s.obligations ?? []) {
      const d = diffDays(o.dueOn, today);
      if (d < 0 || d > Math.max(7, cfg.dueSoonDays)) continue;
      const prior = (s.obligations ?? []).filter((x) => x.id !== o.id && x.dueOn <= o.dueOn).reduce((a, x) => a + x.remainingCents, 0);
      const inflow = (s.income ?? []).filter((i) => i.dueOn <= o.dueOn && (i.state === "upcoming" || i.state === "matched" || i.state === "partial")).reduce((a, i) => a + i.expectedCents, 0);
      const projected = f.balanceCents + inflow - prior;
      if (projected >= o.remainingCents) continue;
      const short = o.remainingCents - projected;
      const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
      out.push(mk({
        ruleId: "obligation_at_risk", id: `obl_risk:${o.id}`, severity: d <= 2 ? "high" : "normal", subjectRef: `obligation:${o.id}`,
        title: `${o.name} may be short`,
        body: `${o.name} is ${fmtKes(o.remainingCents)} and due ${when}. You have ${fmtKes(f.balanceCents)} now${inflow ? ` and expect ${fmtKes(inflow)} first` : ""}; that leaves you about ${fmtKes(short)} short.`,
        redactedBody: "A bill may be short.",
        what: `${o.name} may be short`, when, stake: `${fmtKes(short)} short`,
        dedupeKey: `obl_risk:${o.id}:${o.dueOn}`, cooldownMs: 24 * HOUR_MS, expiresAt: dayStartMs(addDays(o.dueOn, 1)),
        path: `plan/due/${o.id}`,
      }));
    }
    return out;
  },
};

const obligationOverdue: AlertRule = {
  id: "obligation_overdue", description: "An obligation is past its due date", defaultSeverity: "normal",
  evaluate(s) {
    const today = dayOf(s.nowMs);
    const out: AlertCandidate[] = [];
    for (const o of s.obligations ?? []) {
      if (o.remainingCents <= 0) continue;
      const late = diffDays(today, o.dueOn);
      if (late < 1) continue;
      out.push(mk({
        ruleId: "obligation_overdue", id: `obl:${o.id}`, severity: late >= 3 ? "high" : "normal", subjectRef: `obligation:${o.id}`,
        title: `${o.name} is overdue`, body: `${fmtKes(o.remainingCents)} was due ${o.dueOn} (${late} day${late === 1 ? "" : "s"} ago).`,
        redactedBody: "A payment is overdue.",
        dedupeKey: `obl_over:${o.id}:${o.dueOn}`, cooldownMs: 20 * HOUR_MS, expiresAt: s.nowMs + 3 * DAY_MS,
        path: `plan/due/${o.id}`,
      }));
    }
    return out;
  },
};

const incomeLate: AlertRule = {
  id: "income_late", description: "Expected income has not arrived", defaultSeverity: "normal",
  evaluate(s) {
    const out: AlertCandidate[] = [];
    for (const i of s.income ?? []) {
      if (i.state !== "late" && i.state !== "missed") continue;
      out.push(mk({
        ruleId: "income_late", id: `income:${i.id}`, severity: i.state === "missed" ? "high" : "normal", subjectRef: `income:${i.id}`,
        title: `${i.name} ${i.state === "missed" ? "has not arrived" : "is late"}`,
        body: `Expected ${fmtKes(i.expectedCents)} on ${i.dueOn}; nothing matching has been received.`,
        redactedBody: "Expected money has not arrived.",
        dedupeKey: `income_late:${i.id}:${i.dueOn}`, cooldownMs: 24 * HOUR_MS, expiresAt: s.nowMs + 3 * DAY_MS,
        path: `plan/due/${i.id}`,
      }));
    }
    return out;
  },
};

const budgetPace: AlertRule = {
  id: "budget_pace", description: "Budget spend crossed 50/80/100% or is projected to overrun", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const out: AlertCandidate[] = [];
    const levels = [...cfg.budgetLevels].sort((a, b) => a - b);
    for (const b of s.budgets ?? []) {
      if (b.limitCents <= 0) continue;
      const pct = (b.spentCents / b.limitCents) * 100;
      let crossed: number | null = null;
      for (const l of levels) if (pct >= l) crossed = l;
      const expires = dayStartMs(b.periodEndDay);
      const cooldown = 40 * DAY_MS;
      if (crossed != null) {
        const top = crossed >= 100;
        const severity: AlertSeverity = top ? "high" : crossed >= 80 ? "normal" : "low";
        out.push(mk({
          ruleId: "budget_pace", id: `budget:${b.id}`, severity, subjectRef: `budget:${b.id}`,
          title: `${b.name}: ${crossed}% of budget used`,
          body: `${fmtKes(b.spentCents)} of ${fmtKes(b.limitCents)} spent (${Math.floor(pct)}%).`,
          redactedBody: "A budget threshold was reached.",
          dedupeKey: `budget:${b.id}:${b.periodStartDay}:${crossed}`, cooldownMs: cooldown, expiresAt: expires, path: `plan/budgets/${b.id}`,
        }));
        continue;
      }
      if (b.projectedCents != null && b.projectedCents > b.limitCents && b.elapsedFraction >= 0.25) {
        out.push(mk({
          ruleId: "budget_pace", id: `budget:${b.id}`, severity: "normal", subjectRef: `budget:${b.id}`,
          title: `${b.name}: on pace to overspend`,
          body: `Projected ${fmtKes(b.projectedCents)} against a ${fmtKes(b.limitCents)} limit.`,
          redactedBody: "A budget is on pace to overrun.",
          dedupeKey: `budget:${b.id}:${b.periodStartDay}:proj`, cooldownMs: cooldown, expiresAt: expires, path: `plan/budgets/${b.id}`,
        }));
      }
    }
    return out;
  },
};

const fulizaOutstanding: AlertRule = {
  id: "fuliza_outstanding", description: "Fuliza has been outstanding for days", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const f = s.fuliza;
    if (!f || f.outstandingCents <= 0 || f.oldestDrawAt == null) return [];
    const age = Math.floor((s.nowMs - f.oldestDrawAt) / DAY_MS);
    const t = cfg.fulizaAgeDays;
    const severity: AlertSeverity | null = age >= t.high ? "high" : age >= t.normal ? "normal" : age >= t.low ? "low" : null;
    if (!severity) return [];
    return [mk({
      ruleId: "fuliza_outstanding", id: "fuliza", severity, subjectRef: "fuliza",
      title: "Fuliza is still outstanding",
      body: `${fmtKes(f.outstandingCents)} has been outstanding for ${age} days. Fuliza is designed for short-term use (about 4-7 days).`,
      redactedBody: "An overdraft balance needs attention.",
      dedupeKey: `fuliza:${dayOf(f.oldestDrawAt)}`, cooldownMs: 24 * HOUR_MS, expiresAt: s.nowMs + 2 * DAY_MS, path: "plan/fuliza",
    })];
  },
};

const fulizaSweep: AlertRule = {
  id: "fuliza_sweep", description: "Incoming money will first repay Fuliza", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const f = s.fuliza;
    if (!f || f.outstandingCents <= 0 || f.sweepAbsorbedCents <= 0 || !f.nextInflowDueOn) return [];
    const d = diffDays(f.nextInflowDueOn, dayOf(s.nowMs));
    if (d > cfg.dueSoonDays) return [];
    return [mk({
      ruleId: "fuliza_sweep", id: "fuliza_sweep", severity: "normal", subjectRef: "fuliza",
      title: "Next income will repay Fuliza first",
      body: `About ${fmtKes(f.sweepAbsorbedCents)} of the expected income on ${f.nextInflowDueOn} will be swept to Fuliza before you can spend it.`,
      redactedBody: "Incoming money will be partly used for an overdraft.",
      dedupeKey: `fuliza_sweep:${f.nextInflowDueOn}`, cooldownMs: 24 * HOUR_MS, expiresAt: dayStartMs(addDays(f.nextInflowDueOn, 1)), path: "plan/fuliza",
    })];
  },
};

const tariffCliff: AlertRule = {
  id: "tariff_cliff", description: "A slightly smaller send drops into a cheaper fee band", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const p = s.pendingSend;
    if (!p || p.cheaperAmountCents == null || p.cheaperFeeCents == null) return [];
    const saving = p.feeCents - p.cheaperFeeCents;
    const giveUp = p.amountCents - p.cheaperAmountCents;
    if (saving < cfg.tariffMinSavingCents || giveUp <= 0 || giveUp > p.amountCents * cfg.tariffMaxAmountGiveUpFraction) return [];
    return [mk({
      ruleId: "tariff_cliff", id: "tariff_cliff", severity: "normal", subjectRef: "pending_send",
      title: "A cheaper way to send",
      body: `Sending ${fmtKes(p.cheaperAmountCents)} instead of ${fmtKes(p.amountCents)} saves ${fmtKes(saving)} in fees.`,
      redactedBody: "You could save on a transfer fee.",
      dedupeKey: `tariff_cliff:${p.amountCents}:${p.counterpartyKey ?? ""}`, cooldownMs: 5 * 60_000, expiresAt: s.nowMs + 10 * 60_000, path: "send/fee-check",
    })];
  },
};

const repeatedFailed: AlertRule = {
  id: "repeated_failed", description: "Several failed attempts in a short window (possible fraud)", defaultSeverity: "safety",
  evaluate(s, cfg) {
    const out: AlertCandidate[] = [];
    for (const f of s.failedAttempts ?? []) {
      const inWin = f.atMs.filter((t) => t <= s.nowMs && t > s.nowMs - cfg.failedWindowMs).sort((a, b) => a - b);
      if (inWin.length < cfg.failedMinCount) continue;
      const key = `${f.kind}:${f.counterpartyKey ?? "any"}`;
      out.push(mk({
        ruleId: "repeated_failed", id: `failed:${key}`, severity: "safety", subjectRef: `failed:${key}`,
        title: "Repeated failed attempts",
        body: `${inWin.length} failed ${f.kind} attempts in the last ${Math.round(cfg.failedWindowMs / 60_000)} minutes. If this was not you, contact your provider.`,
        redactedBody: "Unusual activity on your account. Open to review.",
        dedupeKey: `failed:${key}:${inWin[0]}`, cooldownMs: 30 * 60_000, expiresAt: s.nowMs + 6 * HOUR_MS, path: "security/attempts",
      }));
    }
    return out;
  },
};

const bundleDepletion: AlertRule = {
  id: "bundle_depletion", description: "A data/voice/SMS bundle is nearly used up or expiring", defaultSeverity: "low",
  evaluate(s, cfg) {
    const out: AlertCandidate[] = [];
    for (const b of s.bundles ?? []) {
      if (b.initial <= 0) continue;
      const frac = b.remaining / b.initial;
      const expiring = b.expiresAt != null && b.expiresAt > s.nowMs && b.expiresAt - s.nowMs <= DAY_MS && frac > cfg.bundleLowFraction;
      let severity: AlertSeverity | null = null; let why = "";
      if (frac <= cfg.bundleVeryLowFraction) { severity = "normal"; why = "almost used up"; }
      else if (frac <= cfg.bundleLowFraction) { severity = "low"; why = "running low"; }
      else if (expiring) { severity = "low"; why = "expiring within a day"; }
      if (!severity) continue;
      out.push(mk({
        ruleId: "bundle_depletion", id: `bundle:${b.id}`, severity, subjectRef: `bundle:${b.id}`,
        title: `${b.label} ${why}`, body: `${Math.max(0, Math.round(frac * 100))}% of the ${b.kind} bundle is left.`,
        redactedBody: "A bundle is running low.",
        dedupeKey: `bundle:${b.id}:${why}`, cooldownMs: 12 * HOUR_MS, expiresAt: b.expiresAt ?? s.nowMs + DAY_MS, path: "more/bundles",
      }));
    }
    return out;
  },
};

const unusualSpend: AlertRule = {
  id: "unusual_spend", description: "A payment or a day's spend is far above your typical", defaultSeverity: "normal",
  evaluate(s, cfg) {
    const sp = s.spend;
    if (!sp || sp.sampleN < cfg.unusualMinSample) return [];
    const out: AlertCandidate[] = [];
    if (sp.txP95Cents != null) {
      for (const t of sp.recent) {
        if (t.amountCents >= cfg.unusualMinCents && t.amountCents > sp.txP95Cents * cfg.unusualTxMultiple) {
          out.push(mk({
            ruleId: "unusual_spend", id: `unusual:${t.txId}`, severity: "normal", subjectRef: `tx:${t.txId}`,
            title: "Unusually large payment", body: `${fmtKes(t.amountCents)} is well above your usual payments.`,
            redactedBody: "A payment looks unusual.",
            dedupeKey: `unusual:${t.txId}`, cooldownMs: 7 * DAY_MS, expiresAt: s.nowMs + DAY_MS, path: `tx/${t.txId}`,
          }));
        }
      }
    }
    if (sp.dailyP90Cents != null && sp.todayCents >= cfg.unusualMinCents && sp.todayCents > sp.dailyP90Cents * cfg.unusualDayMultiple) {
      out.push(mk({
        ruleId: "unusual_spend", id: "unusual_day", severity: "low", subjectRef: "day",
        title: "Heavy spending day", body: `${fmtKes(sp.todayCents)} spent today, above your usual busy day.`,
        redactedBody: "Today's spending is above your usual.",
        dedupeKey: `unusual_day:${dayOf(s.nowMs)}`, cooldownMs: 12 * HOUR_MS, expiresAt: endOfDayEat(s.nowMs), path: "today/spend",
      }));
    }
    return out;
  },
};

const feeDrag: AlertRule = {
  id: "fee_drag", description: "Transaction fees are a large share of outflow", defaultSeverity: "low",
  evaluate(s, cfg) {
    const f = s.fees;
    if (!f) return [];
    const total = f.spendCents30d + f.feeCents30d;
    if (total <= 0 || f.feeCents30d < cfg.feeDragMinCents) return [];
    const share = f.feeCents30d / total;
    if (share < cfg.feeDragShare) return [];
    const month = dayOf(s.nowMs).slice(0, 7);
    return [mk({
      ruleId: "fee_drag", id: "fee_drag", severity: "low", subjectRef: "fees",
      title: "Fees are adding up",
      body: `${fmtKes(f.feeCents30d)} in fees over 30 days (${(share * 100).toFixed(1)}% of outflow).`,
      redactedBody: "Fees are adding up. Open for tips.",
      dedupeKey: `fee_drag:${month}`, cooldownMs: 7 * DAY_MS, expiresAt: s.nowMs + 7 * DAY_MS, path: "analysis/fees",
    })];
  },
};

export const ALERT_RULES: AlertRule[] = [
  lowFloat, daysToZero, obligationDue, obligationAtRisk, obligationOverdue, incomeLate, budgetPace,
  fulizaOutstanding, fulizaSweep, tariffCliff, repeatedFailed, bundleDepletion, unusualSpend, feeDrag,
];

export function alertConfig(s: AlertSnapshot): AlertConfig {
  const c = s.config ?? {};
  return { ...DEFAULT_ALERT_CONFIG, ...c, fulizaAgeDays: { ...DEFAULT_ALERT_CONFIG.fulizaAgeDays, ...(c.fulizaAgeDays ?? {}) } };
}

/** Runs the registry. A throwing rule is isolated and reported, never fatal. */
export function evaluateAlertRules(s: AlertSnapshot, rules: AlertRule[] = ALERT_RULES): { candidates: AlertCandidate[]; errors: Array<{ ruleId: string; error: string }> } {
  const cfg = alertConfig(s);
  const candidates: AlertCandidate[] = [];
  const errors: Array<{ ruleId: string; error: string }> = [];
  for (const r of rules) {
    try { candidates.push(...r.evaluate(s, cfg)); } catch (e) { errors.push({ ruleId: r.id, error: (e as Error).message }); }
  }
  return { candidates, errors };
}
