import test from "node:test";
import assert from "node:assert/strict";
import {
  captureCopy, captureStepId, channelHealth, CHANNELS, diffSchedule, elapsedSteps, IMPORTANCE, parseDeepLink, planCaptureSteps,
  planDigest, planStale, txLink, STALE_ID, type CaptureItem, type PlannedNotification,
} from "../src/index.js";
import { at } from "./fixtures.js";

const H = 3_600_000;
const item = (o: Partial<CaptureItem> = {}): CaptureItem => ({
  txId: 1, tier: "full", materiality: 0.5, counterpartyKey: "jane", amountCents: 50_000, createdAt: at(2026, 10, 26, 10),
  stepsSent: 1, resolvedAt: null, snoozeUntil: null, lastPromptAt: null, staleEscalatedAt: null, ...o,
});

test("deep links: tx, plan, screens, garbage", () => {
  assert.deepEqual(parseDeepLink("yako://tx/42"), { kind: "tx", txId: 42, capture: null });
  assert.deepEqual(parseDeepLink(txLink(7, "photo")), { kind: "tx", txId: 7, capture: "photo" });
  assert.deepEqual(parseDeepLink("yako://plan/due/9"), { kind: "plan", section: "due", id: 9 });
  assert.deepEqual(parseDeepLink("yako://plan/9"), { kind: "plan", section: "due", id: 9 });
  assert.deepEqual(parseDeepLink("yako://plan/budgets/3"), { kind: "plan", section: "budgets", id: 3 });
  assert.deepEqual(parseDeepLink("yako://plan/fuliza"), { kind: "plan", section: "fuliza", id: null });
  assert.deepEqual(parseDeepLink("yako://today/float"), { kind: "screen", screen: "today", rest: ["float"] });
  assert.equal(parseDeepLink("yako://tx/abc").kind, "unknown");
  assert.equal(parseDeepLink("https://x/tx/1").kind, "unknown");
  assert.equal(parseDeepLink(null).kind, "unknown");
});

test("channel health: downgrade, off, missing, ok", () => {
  assert.equal(channelHealth("alerts", IMPORTANCE.high).ok, true);
  assert.match(channelHealth("alerts", IMPORTANCE.default).guidance!, /turned down/);
  assert.match(channelHealth("digest", IMPORTANCE.none).guidance!, /switched off/);
  assert.match(channelHealth("capture", null).guidance!, /missing/);
  assert.match(channelHealth("capture", IMPORTANCE.default).guidance!, /turned down/);
  assert.equal(channelHealth("capture", IMPORTANCE.high).ok, true); // as loud as asked, or louder
  assert.ok(new Set(Object.values(CHANNELS).map((c) => c.id)).size === 4);
});

test("full ladder: +2h, 08:00 next morning scheduled; stale is not per-item", () => {
  const it = item({ createdAt: at(2026, 10, 26, 10) });
  const plan = planCaptureSteps([it], at(2026, 10, 26, 10));
  assert.deepEqual(plan.map((p) => p.step), ["followup", "morning"]);
  assert.equal(plan[0]!.atMs, at(2026, 10, 26, 12));
  assert.equal(plan[1]!.atMs, at(2026, 10, 27, 8));
  assert.equal(plan[0]!.id, captureStepId(1, 1));
});

test("resolved / none / snoozed / sent steps", () => {
  const now = at(2026, 10, 26, 10);
  assert.equal(planCaptureSteps([item({ resolvedAt: now })], now).length, 0);
  assert.equal(planCaptureSteps([item({ tier: "none" })], now).length, 0);
  const sn = planCaptureSteps([item({ snoozeUntil: at(2026, 10, 26, 15) })], now);
  assert.equal(sn[0]!.atMs, at(2026, 10, 26, 15));
  assert.equal(planCaptureSteps([item({ stepsSent: 2 })], now).map((p) => p.step).join(), "morning");
});

test("late-evening transaction: followup collapses into the morning", () => {
  const it = item({ createdAt: at(2026, 10, 26, 21) + 30 * 60_000 });
  const plan = planCaptureSteps([it], it.createdAt);
  assert.ok(plan.every((p) => p.atMs >= at(2026, 10, 27, 7)));
});

test("elapsedSteps marks passed steps sent and flags stale once", () => {
  const it = item();
  const r = elapsedSteps([it], at(2026, 10, 27, 9));
  assert.deepEqual(r, [{ txId: 1, stepsSent: 3, stale: false }]);
  const r2 = elapsedSteps([it], at(2026, 10, 28, 11));
  assert.equal(r2[0]!.stale, true);
  assert.equal(elapsedSteps([item({ stepsSent: 4, staleEscalatedAt: 5 })], at(2026, 10, 29, 11)).length, 0);
  assert.equal(elapsedSteps([item({ stepsSent: 3, staleEscalatedAt: 5 })], at(2026, 10, 29, 11))[0]!.stale, false);
  assert.equal(elapsedSteps([it], at(2026, 10, 26, 10)).length, 0);
});

test("stale summary: earliest crossing, grouped, once", () => {
  const a = item({ txId: 1 }), b = item({ txId: 2, createdAt: at(2026, 10, 26, 11) }), c = item({ txId: 3, createdAt: at(2026, 10, 26, 20), tier: "batch" });
  const p = planStale([a, b, c], at(2026, 10, 26, 12))!;
  assert.equal(p.id, STALE_ID);
  assert.equal(p.atMs, at(2026, 10, 28, 10));
  assert.deepEqual(p.txIds, [1, 2]);
  assert.equal(planStale([item({ staleEscalatedAt: 1 })], at(2026, 10, 26, 12)), null);
  assert.equal(planStale([item()], at(2026, 10, 29, 12)), null);
});

test("digest at 19:00 EAT for batch items only", () => {
  const b = item({ txId: 5, tier: "batch", amountCents: 2000 });
  const p = planDigest([b, item({ txId: 6 })], at(2026, 10, 26, 10))!;
  assert.equal(p.atMs, at(2026, 10, 26, 19));
  assert.deepEqual(p.txIds, [5]);
  assert.equal(planDigest([item()], at(2026, 10, 26, 10)), null);
  assert.equal(planDigest([item({ tier: "batch", lastPromptAt: 1 })], at(2026, 10, 26, 10)), null);
  assert.equal(planDigest([b], at(2026, 10, 26, 20))!.atMs, at(2026, 10, 27, 19));
});

test("diffSchedule is idempotent and only touches owned ids", () => {
  const d: PlannedNotification[] = [{ id: "cap:1:1", atMs: 1000 * H, kind: "capture_step", channel: "capture", txIds: [1] }];
  const first = diffSchedule(d, [{ id: "cap:9:1", atMs: 5 }, { id: "foreign", atMs: 1 }]);
  assert.deepEqual(first.cancel, ["cap:9:1"]);
  assert.equal(first.schedule.length, 1);
  assert.deepEqual(diffSchedule(d, [{ id: "cap:1:1", atMs: 1000 * H + 5000 }]), { schedule: [], cancel: [] });
  assert.equal(diffSchedule(d, [{ id: "cap:1:1", atMs: 1000 * H + 3 * H }]).schedule.length, 1); // moved
});

test("redacted copy never carries amounts or names", () => {
  for (const k of ["first", "followup", "morning", "stale", "digest"] as const) {
    const c = captureCopy(k, { details: "KES 500 to JANE", count: 3, showDetails: false });
    assert.doesNotMatch(c.title + c.body, /KES|JANE|\d{3}/);
  }
  assert.match(captureCopy("first", { details: "KES 500 to JANE", showDetails: true }).title, /JANE/);
});
