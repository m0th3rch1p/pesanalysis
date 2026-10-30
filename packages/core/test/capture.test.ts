import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  amountPercentile, assessMateriality, batchDigest, buildLadder, buildNeedsYouQueue, decidePrompt, detailCompleteness, feeIsAnomalous, isStale,
  listOpenCaptures, markDigestSent, nextCaptureStep, nextDigestAt, noDetails, recordPromptSent, registerCapture, resolveCapture, snoozeCapture,
  staleEscalations, summariseMoments, updateCompleteness, DETAIL_FIELDS, DETAIL_WEIGHTS, STALE_AFTER_MS, type CaptureItem, type CaptureTx,
} from "../src/capture/index.js";
import { migrate } from "../src/db/migrate.js";
import { adapter, at } from "./fixtures.js";

const H = 3_600_000, D = 86_400_000;
const NOON = at(2026, 10, 26, 12);
const hist = Array.from({ length: 100 }, (_, i) => (i + 1) * 1_000); // 1k..100k cents, uniform
const tx = (o: Partial<CaptureTx> = {}): CaptureTx => ({
  id: 1, amountCents: 20_000, feeCents: 0, direction: "out", occurredAt: NOON, counterpartyKey: "n:shop", counterpartyPriorCount: 1,
  labelId: null, labelConfidence: 0, labelSource: "none", businessProb: 0, expectedFeeCents: null, details: {}, ...o,
});
const autoFiled = (o: Partial<CaptureTx> = {}) => tx({ labelId: 5, labelConfidence: 0.95, labelSource: "auto", ...o });

test("percentile: mid-rank ties, short history -> null", () => {
  assert.equal(amountPercentile(50_500, hist), 0.5);
  assert.equal(amountPercentile(100_000, hist), 0.995);
  assert.equal(amountPercentile(1, hist), 0);
  assert.equal(amountPercentile(5, hist.slice(0, 19)), null);
  assert.equal(amountPercentile(5, [7, 7, 7, 7], 2), 0);
  assert.equal(amountPercentile(7, [7, 7, 7, 7], 2), 0.5);
});

test("fee anomaly: needs a known expectation, ratio and absolute excess", () => {
  assert.equal(feeIsAnomalous(2_500, 1_300), true);
  assert.equal(feeIsAnomalous(1_300, 1_300), false);
  assert.equal(feeIsAnomalous(1_700, 1_300), false); // +400 < 500
  assert.equal(feeIsAnomalous(1_900, 1_300), false); // ratio < 1.5
  assert.equal(feeIsAnomalous(2_000, null), false);
  assert.equal(feeIsAnomalous(600, 0), true);
});

test("materiality tiers", () => {
  // large for the user -> full ladder
  const big = assessMateriality(tx({ amountCents: 90_000 }), hist);
  assert.equal(big.tier, "full"); assert.ok(big.reasons.includes("large_for_you")); assert.equal(big.percentile, 0.895);
  // middling, known counterparty, unlabelled -> single
  assert.equal(assessMateriality(tx({ amountCents: 40_000 }), hist).tier, "single");
  // small auto-filed high-confidence -> batch
  const small = assessMateriality(autoFiled({ amountCents: 2_000 }), hist);
  assert.equal(small.tier, "batch"); assert.ok(small.reasons.includes("small_auto_filed"));
  // large auto-filed still full
  assert.equal(assessMateriality(autoFiled({ amountCents: 90_000 }), hist).tier, "full");
  // low-confidence auto label never batches
  assert.equal(assessMateriality(autoFiled({ amountCents: 2_000, labelConfidence: 0.5 }), hist).tier, "full");
  // novel counterparty with non-trivial amount -> full; novel tiny + unlabelled -> single
  assert.equal(assessMateriality(tx({ amountCents: 60_000, counterpartyPriorCount: 0 }), hist).tier, "full");
  assert.equal(assessMateriality(tx({ amountCents: 2_000, counterpartyPriorCount: 0 }), hist).tier, "single");
  assert.equal(assessMateriality(autoFiled({ amountCents: 2_000, counterpartyPriorCount: 0 }), hist).tier, "single"); // novel never batches
  // unlabelled recurring -> full even if tiny
  const rec = assessMateriality(tx({ amountCents: 2_000, counterpartyPriorCount: 3 }), hist);
  assert.equal(rec.tier, "full"); assert.ok(rec.reasons.includes("unlabelled_recurring"));
  assert.equal(assessMateriality(tx({ amountCents: 2_000, counterpartyPriorCount: 2 }), hist).tier, "single");
  // business-likely -> full; boundary 0.5
  assert.equal(assessMateriality(autoFiled({ amountCents: 2_000, businessProb: 0.5 }), hist).tier, "full");
  assert.equal(assessMateriality(autoFiled({ amountCents: 2_000, businessProb: 0.49 }), hist).tier, "batch");
  // fee anomaly -> full
  const fee = assessMateriality(autoFiled({ amountCents: 2_000, feeCents: 2_500, expectedFeeCents: 1_300 }), hist);
  assert.equal(fee.tier, "full"); assert.ok(fee.reasons.includes("fee_anomaly"));
  // user-set label, small, user source -> single (not auto-filed), not batch
  assert.equal(assessMateriality(tx({ amountCents: 2_000, labelId: 3, labelSource: "user", labelConfidence: 1 }), hist).tier, "single");
  // already complete -> none
  const done = assessMateriality(tx({ details: { label: true, note: true } }), hist);
  assert.deepEqual([done.tier, done.reasons], ["none", ["already_complete"]]);
  assert.equal(assessMateriality(tx({ details: { label: true } }), hist).tier !== "none", true); // label alone is not submitted
});

test("materiality: short history falls back to absolute thresholds; score ordering", () => {
  assert.equal(assessMateriality(tx({ amountCents: 150_000 }), []).tier, "full");
  assert.equal(assessMateriality(autoFiled({ amountCents: 5_000 }), []).tier, "batch");
  assert.equal(assessMateriality(tx({ amountCents: 50_000 }), []).tier, "single");
  assert.equal(assessMateriality(tx({ amountCents: 50_000 }), [], { fallbackFullCents: 40_000 }).tier, "full"); // tunable
  const a = assessMateriality(tx({ amountCents: 90_000, counterpartyPriorCount: 0, businessProb: 0.9 }), hist).score;
  const b = assessMateriality(tx({ amountCents: 40_000 }), hist).score;
  const c = assessMateriality(autoFiled({ amountCents: 2_000 }), hist).score;
  assert.ok(a > b && b > c && a <= 1 && c >= 0);
});

test("decidePrompt: now / defer for quiet hours / batch to digest / none", () => {
  const big = tx({ amountCents: 90_000 });
  assert.deepEqual([decidePrompt(big, hist, NOON).action, decidePrompt(big, hist, NOON).promptAtMs], ["prompt_now", NOON]);
  const night = at(2026, 10, 26, 23);
  // D109 default: the user is awake and transacting, so ask now; "hold" defers to morning.
  assert.equal(decidePrompt(big, hist, night).action, "prompt_now");
  const d = decidePrompt(big, hist, night, { quietPolicy: "hold" });
  assert.deepEqual([d.action, d.promptAtMs], ["defer", at(2026, 10, 27, 7)]);
  const b = decidePrompt(autoFiled({ amountCents: 2_000 }), hist, NOON);
  assert.deepEqual([b.action, b.promptAtMs], ["batch", at(2026, 10, 26, 19)]);
  assert.equal(nextDigestAt(at(2026, 10, 26, 20)), at(2026, 10, 27, 19));
  assert.equal(nextDigestAt(at(2026, 10, 26, 19)), at(2026, 10, 27, 19));
  assert.equal(decidePrompt(tx({ details: { label: true, photo: true } }), hist, NOON).action, "none");
  // batch items at night still batch (digest is outside quiet hours)
  assert.equal(decidePrompt(autoFiled({ amountCents: 2_000 }), hist, night).action, "batch");
});

test("ladder: full = first, +2h, next morning 08:00, stale at 48h", () => {
  const t0 = at(2026, 10, 26, 10);
  const l = buildLadder(t0, "full");
  assert.deepEqual(l.map((s) => [s.kind, s.atMs]), [["first", t0], ["followup", t0 + 2 * H], ["morning", at(2026, 10, 27, 8)], ["stale", t0 + 48 * H]]);
  assert.deepEqual(buildLadder(t0, "single").map((s) => s.kind), ["first", "morning", "stale"]);
  assert.deepEqual(buildLadder(t0, "batch").map((s) => s.kind), ["stale"]);
  assert.deepEqual(buildLadder(t0, "none"), []);
  assert.deepEqual(l.map((s) => s.index), [0, 1, 2, 3]);
});

test("ladder: quiet hours shift steps; collapsed steps drop; stale is never dropped", () => {
  const t0 = at(2026, 10, 26, 20); // +2h = 22:00 quiet -> 07:00; morning 08:00 stays
  const l = buildLadder(t0, "full");
  assert.deepEqual(l.map((s) => [s.kind, s.atMs]), [["first", t0], ["followup", at(2026, 10, 27, 7)], ["morning", at(2026, 10, 27, 8)], ["stale", t0 + 48 * H]]);
  const late = buildLadder(at(2026, 10, 26, 23), "full"); // first shifts to 07:00 on the 27th; +2h->07:00; morning 08:00 next day = 27th 08:00
  assert.ok(late.every((s, i) => i === 0 || s.atMs > late[i - 1]!.atMs), "strictly increasing");
  assert.equal(late[late.length - 1]!.kind, "stale");
  assert.ok(late.every((s) => { const m = (s.atMs + 3 * H) % D / 60000; return m >= 7 * 60 && m < 22 * 60; }), "no step in quiet hours");
  // stale lands in quiet hours -> shifted, still present
  const t1 = at(2026, 10, 26, 23, ); const s = buildLadder(t1, "batch");
  assert.equal(s[0]!.kind, "stale"); assert.equal(s[0]!.atMs, at(2026, 10, 28, 23) + 8 * H);
});

const item = (o: Partial<CaptureItem> = {}): CaptureItem => ({ txId: 1, tier: "full", materiality: 0.6, counterpartyKey: "n:a", amountCents: 50_000, createdAt: at(2026, 10, 26, 10), stepsSent: 0, resolvedAt: null, snoozeUntil: null, lastPromptAt: null, staleEscalatedAt: null, ...o });

test("nextCaptureStep: walks the ladder, waits between, catches up with one prompt, escalates stale once", () => {
  const t0 = at(2026, 10, 26, 10);
  let n = nextCaptureStep(item(), t0);
  assert.deepEqual([n.action, (n as any).step.kind], ["prompt", "first"]);
  n = nextCaptureStep(item({ stepsSent: 1 }), t0 + H);
  assert.deepEqual([n.action, (n as any).untilMs], ["wait", t0 + 2 * H]);
  n = nextCaptureStep(item({ stepsSent: 1 }), t0 + 2 * H);
  assert.equal((n as any).step.kind, "followup");
  n = nextCaptureStep(item({ stepsSent: 2 }), at(2026, 10, 27, 8));
  assert.equal((n as any).step.kind, "morning");
  n = nextCaptureStep(item({ stepsSent: 3 }), t0 + 47 * H);
  assert.deepEqual([n.action, (n as any).untilMs], ["wait", t0 + 48 * H]);
  n = nextCaptureStep(item({ stepsSent: 3 }), t0 + 48 * H);
  assert.deepEqual([n.action, (n as any).step.kind, (n as any).skipped], ["stale_escalate", "stale", 0]);
  // phone was off for three days: only the latest due step fires, earlier ones are reported skipped
  n = nextCaptureStep(item({ stepsSent: 0 }), t0 + 3 * D);
  assert.deepEqual([n.action, (n as any).skipped], ["stale_escalate", 3]);
  // after the last step nothing more fires
  assert.equal(nextCaptureStep(item({ stepsSent: 4 }), t0 + 9 * D).action, "wait");
  // escalated once only
  assert.equal(nextCaptureStep(item({ stepsSent: 3, staleEscalatedAt: t0 + 48 * H }), t0 + 60 * H).action, "wait");
  // resolved / none
  assert.equal(nextCaptureStep(item({ resolvedAt: t0 }), t0 + D).action, "done");
  assert.equal(nextCaptureStep(item({ tier: "none" }), t0 + D).action, "done");
});

test("nextCaptureStep: snooze and quiet hours both hold the prompt", () => {
  const t0 = at(2026, 10, 26, 10);
  const sn = nextCaptureStep(item({ snoozeUntil: t0 + 5 * H }), t0 + H);
  assert.deepEqual([sn.action, (sn as any).untilMs], ["wait", t0 + 5 * H]);
  assert.equal(nextCaptureStep(item({ snoozeUntil: t0 + 5 * H }), t0 + 6 * H).action, "prompt");
  const q = nextCaptureStep(item({ stepsSent: 3 }), at(2026, 10, 28, 23) - 0 + 0); // stale due at 10:00 on 28th; now 23:00 = quiet
  assert.deepEqual([q.action, (q as any).untilMs], ["wait", at(2026, 10, 29, 7)]);
});

test("2-day rule: nothing is silently lost; queue ordering; escalation grouped by counterparty", () => {
  const t0 = at(2026, 10, 26, 10);
  const items = [
    item({ txId: 1, counterpartyKey: "n:a", amountCents: 1_000, tier: "batch", materiality: 0.1, createdAt: t0 - 3 * D }),
    item({ txId: 2, counterpartyKey: "n:a", amountCents: 2_000, tier: "single", materiality: 0.3, createdAt: t0 - 3 * D }),
    item({ txId: 3, counterpartyKey: "n:b", amountCents: 90_000, tier: "full", materiality: 0.9, createdAt: t0 - 49 * H }),
    item({ txId: 4, counterpartyKey: "n:c", amountCents: 90_000, tier: "full", materiality: 0.95, createdAt: t0 - H }),
    item({ txId: 5, resolvedAt: t0, createdAt: t0 - 5 * D }),
    item({ txId: 6, tier: "none", createdAt: t0 - 5 * D }),
    item({ txId: 7, counterpartyKey: "n:z", tier: "batch", materiality: 0.05, createdAt: t0 - 47 * H }),
  ];
  assert.equal(isStale(items[2]!, t0), true);
  assert.equal(isStale(items[6]!, t0), false);
  assert.equal(isStale(items[4]!, t0), false);
  assert.equal(STALE_AFTER_MS, 48 * H);
  const q = buildNeedsYouQueue(items, t0);
  assert.deepEqual(q.map((e) => e.item.txId), [3, 2, 1, 4, 7]); // stale first (by materiality), then open by materiality
  assert.deepEqual(q.map((e) => e.stale), [true, true, true, false, false]);
  assert.equal(q.some((e) => [5, 6].includes(e.item.txId)), false);
  const esc = staleEscalations(items, t0);
  assert.deepEqual(esc.map((g) => [g.counterpartyKey, g.count, g.totalCents, g.txIds]), [["n:a", 2, 3_000, [1, 2]], ["n:b", 1, 90_000, [3]]]);
  assert.match(esc[0]!.copy, /add detail or mark done/);
  assert.equal(staleEscalations(items.map((i) => ({ ...i, staleEscalatedAt: t0 })), t0).length, 0);
  // an item crossing the line one hour later is picked up
  assert.equal(staleEscalations(items, t0 + H).some((g) => g.txIds.includes(7)), true);
});

test("batch digest: small auto-filed items grouped per counterparty, once", () => {
  const t0 = at(2026, 10, 26, 10);
  const items = [
    item({ txId: 1, tier: "batch", counterpartyKey: "n:air", amountCents: 2_000 }), item({ txId: 2, tier: "batch", counterpartyKey: "n:air", amountCents: 2_000 }),
    item({ txId: 3, tier: "batch", counterpartyKey: "n:kplc", amountCents: 5_000 }), item({ txId: 4, tier: "full" }),
    item({ txId: 5, tier: "batch", lastPromptAt: t0 }), item({ txId: 6, tier: "batch", resolvedAt: t0 }),
  ];
  const g = batchDigest(items);
  assert.deepEqual(g.map((x) => [x.counterpartyKey, x.count, x.totalCents]), [["n:air", 2, 4_000], ["n:kplc", 1, 5_000]]);
  assert.equal(batchDigest([]).length, 0);
});

test("completeness: weights sum to 100, submitted rule, levels, monotonic", () => {
  assert.equal(DETAIL_FIELDS.reduce((a, f) => a + DETAIL_WEIGHTS[f], 0), 100);
  const e = detailCompleteness(noDetails());
  assert.deepEqual([e.score, e.level, e.submitted, e.next], [0, "empty", false, "label"]);
  assert.deepEqual([detailCompleteness({ label: true }).submitted, detailCompleteness({ label: true }).level], [false, "partial"]);
  assert.equal(detailCompleteness({ note: true, photo: true }).submitted, false); // no category
  for (const f of ["note", "tag", "photo", "voice"] as const) assert.equal(detailCompleteness({ label: true, [f]: true }).submitted, true, f);
  assert.equal(detailCompleteness({ label: true, note: true }).level, "filed");
  assert.equal(detailCompleteness({ label: true, note: true, photo: true }).level, "detailed"); // 60
  const full = detailCompleteness({ label: true, note: true, tag: true, photo: true, voice: true, place: true, counterpartyRole: true });
  assert.deepEqual([full.score, full.level, full.next, full.missing], [100, "rich", null, []]);
  assert.equal(detailCompleteness({ label: true, note: true, photo: true, voice: true, place: true }).level, "rich"); // 85
  // monotonic: adding any field never lowers the score
  const base: any = {};
  let prev = 0;
  for (const f of DETAIL_FIELDS) { base[f] = true; const s = detailCompleteness(base).score; assert.ok(s > prev); prev = s; }
  assert.equal(detailCompleteness({ label: true, note: true }).next, "photo");
});

test("moments summary: completeness, not streaks", () => {
  const s = summariseMoments([
    { txId: 1, details: { label: true, note: true, photo: true } }, { txId: 2, details: { label: true } }, { txId: 3, details: {} },
    { txId: 4, details: { label: true, tag: true } },
  ]);
  assert.deepEqual([s.n, s.submitted, s.submittedShare, s.levels.detailed, s.levels.filed, s.levels.partial, s.levels.empty], [4, 2, 0.5, 1, 1, 1, 1]);
  assert.equal(s.avgScore, 31.3); // 125 / 4 rounded to 1 dp
  assert.equal(s.missingByField[0]!.field, "voice");
  assert.deepEqual(Object.keys(s).includes("streak"), false);
  const none = summariseMoments([]);
  assert.deepEqual([none.n, none.avgScore, none.submittedShare], [0, null, null]);
});

test("store: register is idempotent, ladder state persists, resolve/snooze/digest, completeness only rises", () => {
  const raw = new DatabaseSync(":memory:"); const a = adapter(raw); migrate(a);
  const t = { id: 7, amountCents: 90_000, counterpartyKey: "n:a", details: {} };
  const dec = decidePrompt(tx({ id: 7, amountCents: 90_000 }), hist, NOON);
  assert.equal(registerCapture(a, t, dec, NOON), true);
  assert.equal(registerCapture(a, t, dec, NOON + H), false);
  assert.equal(registerCapture(a, { ...t, id: 8 }, { ...dec, tier: "none" }, NOON), false);
  let [it] = listOpenCaptures(a);
  assert.deepEqual([it!.txId, it!.tier, it!.createdAt, it!.stepsSent], [7, "full", NOON, 0]);
  recordPromptSent(a, 7, 1, NOON); recordPromptSent(a, 7, 0, NOON + 1); // never moves backwards
  assert.equal(listOpenCaptures(a)[0]!.stepsSent, 1);
  recordPromptSent(a, 7, 4, NOON + 48 * H, true);
  it = listOpenCaptures(a)[0]!;
  assert.deepEqual([it.stepsSent, it.staleEscalatedAt], [4, NOON + 48 * H]);
  recordPromptSent(a, 7, 4, NOON + 50 * H, true);
  assert.equal(listOpenCaptures(a)[0]!.staleEscalatedAt, NOON + 48 * H, "escalated once");
  snoozeCapture(a, 7, NOON + 99); assert.equal(listOpenCaptures(a)[0]!.snoozeUntil, NOON + 99);
  markDigestSent(a, [7], NOON + 5); assert.equal(listOpenCaptures(a)[0]!.lastPromptAt, NOON + 5);
  assert.equal(updateCompleteness(a, 7, { label: true, note: true }), 45);
  updateCompleteness(a, 7, { label: true });
  assert.equal(a.get(`SELECT completeness c FROM capture_prompts WHERE tx_id = 7`).c, 45);
  resolveCapture(a, 7, "submitted", NOON + 1); resolveCapture(a, 7, "done", NOON + 2);
  assert.equal(listOpenCaptures(a).length, 0);
  assert.deepEqual(Object.values(a.get(`SELECT resolution, resolved_at FROM capture_prompts WHERE tx_id = 7`)), ["submitted", NOON + 1]);
});
