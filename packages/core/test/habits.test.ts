import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb } from "./fixtures.js";
import { createHabit, suggestHabits, setHabitTarget } from "../src/habits/suggest.js";
import { listHabits } from "../src/habits/categories.js";
import { matchingTxIds, selectorPreview } from "../src/habits/selector.js";
import { computeBaseline } from "../src/habits/baseline.js";
import { habitProgress, suggestedTarget } from "../src/habits/progress.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 18); // 21:00 EAT
function add(db: ReturnType<typeof fixtureDb>, label: string, at: number, amount = 10_000) {
  const cp = (db.prepare("SELECT id FROM counterparties LIMIT 1").get() as { id: number }).id;
  const id = Number(db.prepare(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
    VALUES ('mpesa','till','out',?,?,?,'x','1','confirmed','transaction')`).run(amount, cp, at).lastInsertRowid);
  const labelId = (db.prepare("SELECT id FROM labels WHERE name = ?").get(label) as { id: number }).id;
  db.prepare(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`).run(id, labelId, at, at);
  return id;
}

test("habit selector matches labels, weekday and wrapping window", () => {
  const db = fixtureDb(); const a = adapter(db);
  const label = (db.prepare("SELECT id FROM labels WHERE name='Eating out'").get() as { id: number }).id;
  for (let d = 0; d < 14; d++) add(db, "Eating out", NOW - d * DAY - 2 * 3_600_000);
  add(db, "Eating out", NOW - 60 * DAY - 2 * 3_600_000);
  const ids = matchingTxIds(a, { labels: [label], direction: "out", window: { startMin: 18 * 60, endMin: 23 * 60 } }, NOW - 56 * DAY, NOW);
  assert.equal(ids.length, 14);
  const preview = selectorPreview(a, { labels: [label], direction: "out" }, NOW);
  assert.ok(preview.count >= 14);

  const b = computeBaseline(a, { labels: [label], direction: "out" }, NOW);
  assert.equal(b.weeks, 8);
  assert.equal(b.counts.length, 8);
  assert.ok(b.meanCount > 0);
  db.close();
});

test("habit progress holds N of last M weeks and suggest accepts gated time-of-day", () => {
  const db = fixtureDb(); const a = adapter(db);
  const label = (db.prepare("SELECT id FROM labels WHERE name='Eating out'").get() as { id: number }).id;
  for (let d = 0; d < 56; d += 7) add(db, "Eating out", NOW - d * DAY - 2 * 3_600_000);
  const id = createHabit(a, { name: "Takeaway", selector: { labels: [label], direction: "out" }, direction: "reduce" });
  const habit = listHabits(a).find((h) => h.id === id)!;
  const base = computeBaseline(a, habit.selector, NOW);
  const target = suggestedTarget(base, "reduce");
  if (target.count === 0) target.count = 1;
  setHabitTarget(a, id, target);
  const h2 = listHabits(a).find((h) => h.id === id)!;
  const p = habitProgress(a, h2, NOW);
  assert.equal(p.periods.length, 9);
  assert.ok(p.heldOfLastM?.includes("of last 8 weeks"));

  const suggestions = suggestHabits(a, [{
    detector: "time_of_day", id: "t", title: "30% of eating out debits fall between 22:00 and 02:00", n: 20, gate: "shown",
    evidence: { group: "label:Eating out|out", window: [22, 2], widthHours: 4, count: 6, share: 0.3, baseline: 0.1 },
  }], NOW);
  assert.ok(suggestions.some((s) => s.name.includes("Eating out")));
  db.close();
});

test("habit nudges: parse, quiet-hour shift, weekdays and disabled schedules", async () => {
  const { parseHabitNudge, adjustNudgeMinute, nudgeSchedules, setHabitNudge } = await import("../src/habits/nudge.js");
  const { adapter, fixtureDb } = await import("./fixtures.js");
  const { createHabit } = await import("../src/habits/suggest.js");
  const { listHabits } = await import("../src/habits/categories.js");
  assert.deepEqual(parseHabitNudge({ enabled: true, minuteOfDay: 1290, weekdays: [1, 1, 6] }), { enabled: true, minuteOfDay: 1290, weekdays: [1, 6] });
  assert.equal(parseHabitNudge({ enabled: true, minuteOfDay: 2000, weekdays: [1] }), null);
  assert.equal(parseHabitNudge({ enabled: true, minuteOfDay: 100, weekdays: [] }), null);
  assert.equal(adjustNudgeMinute(22 * 60 + 30), 7 * 60);
  assert.equal(adjustNudgeMinute(21 * 60 + 30), 21 * 60 + 30);
  const db = fixtureDb(); const a = adapter(db);
  const id = createHabit(a, { name: "Nudge test", selector: { direction: "out" }, direction: "reduce" }, 1);
  setHabitNudge(a, id, { enabled: true, minuteOfDay: 22 * 60 + 30, weekdays: [1, 5] });
  const rows = nudgeSchedules(listHabits(a, "active"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.weekday, r.minute]), [[1, 420], [5, 420]]);
  assert.match(rows[0]!.body, /07:00/);
  setHabitNudge(a, id, null);
  assert.equal(nudgeSchedules(listHabits(a, "active")).length, 0);
  db.close();
});
