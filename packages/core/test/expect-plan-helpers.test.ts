import test from "node:test";
import assert from "node:assert/strict";
import { centsToInput, dailySpendQuantiles, dayLabel, delayPhrase, parseKesToCents, suggestRecurring, upcomingStrip } from "../src/expect/plan-helpers.js";
import { delayStats } from "../src/expect/matcher.js";
import { at } from "./fixtures.js";

const NOW = at(2026, 10, 29, 12);
const DAY = 86_400_000;

test("dailySpendQuantiles counts zero days and excludes today", () => {
  const ev = [];
  for (let i = 1; i <= 20; i++) if (i % 2 === 0) ev.push({ occurredAt: NOW - i * DAY, amountCents: 10_000 });
  ev.push({ occurredAt: NOW, amountCents: 999_999 });
  const q = dailySpendQuantiles(ev, NOW, 60);
  assert.equal(q.observedDays, 20);
  assert.equal(q.enough, true);
  assert.equal(q.p50Cents, 5_000);
  assert.equal(q.p90Cents, 10_000);
  assert.equal(dailySpendQuantiles([], NOW).enough, false);
  assert.equal(dailySpendQuantiles([{ occurredAt: NOW - 3 * DAY, amountCents: 1 }], NOW).enough, false);
});

test("suggestRecurring finds monthly salary, skips noise and tracked keys", () => {
  const sal = [at(2026, 7, 28, 9), at(2026, 8, 28, 9), at(2026, 9, 28, 10), at(2026, 10, 28, 9)]
    .map((t) => ({ occurredAt: t, direction: "in" as const, amountCents: 5_000_000, key: "acme", name: "Acme Ltd" }));
  const noise = [1, 5, 40, 41].map((d) => ({ occurredAt: NOW - d * DAY, direction: "out" as const, amountCents: 100, key: "shop", name: "Shop" }));
  const r = suggestRecurring([...sal, ...noise], NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.cadence, "monthly");
  assert.equal(r[0]!.dayOfMonth, 28);
  assert.equal(r[0]!.typCents, 5_000_000);
  assert.equal(suggestRecurring(sal, NOW, new Set(["acme"])).length, 0);
  assert.equal(suggestRecurring(sal, at(2027, 3, 1, 9)).length, 0); // stale
});

test("delayPhrase", () => {
  const rows = [2, 2, 3].map((d) => ({ state: "matched" as const, delayDays: d, receivedCents: 1, expectedCents: 1 }));
  assert.equal(delayPhrase(delayStats(rows)), "Usually arrives 2 days late");
  assert.equal(delayPhrase(delayStats(rows.slice(0, 2))), null);
  const early = [-1, -1, -1].map((d) => ({ state: "matched" as const, delayDays: d, receivedCents: 1, expectedCents: 1 }));
  assert.equal(delayPhrase(delayStats(early), "out"), "Usually is paid 1 day early");
});

test("upcomingStrip buckets, pins overdue to today, drops waived/settled", () => {
  const mk = (dueOn: string, state: any, dir: "in" | "out" = "out") => ({ dueOn, state, expectedCents: 1000, receivedCents: 0, name: "x", direction: dir });
  const s = upcomingStrip([mk("2026-10-27", "late"), mk("2026-10-30", "upcoming", "in"), mk("2026-10-31", "waived"), mk("2026-12-30", "upcoming"), mk("2026-11-02", "matched")], "2026-10-29", 30);
  assert.equal(s.length, 30);
  assert.equal(s[0]!.outCents, 1000);
  assert.equal(s[1]!.inCents, 1000);
  assert.equal(s.reduce((a, d) => a + d.items.length, 0), 2);
});

test("parseKesToCents / centsToInput / dayLabel", () => {
  assert.equal(parseKesToCents("12,500"), 1_250_000);
  assert.equal(parseKesToCents("Ksh 1 200.5"), 120_050);
  assert.equal(parseKesToCents("1.234"), null);
  assert.equal(parseKesToCents("abc"), null);
  assert.equal(parseKesToCents(""), null);
  assert.equal(centsToInput(120_050), "1200.50");
  assert.equal(centsToInput(500_000), "5000");
  assert.equal(dayLabel("2026-10-29"), "Thu 29 Oct");
});
