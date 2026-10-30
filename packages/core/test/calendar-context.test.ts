import test from "node:test";
import assert from "node:assert/strict";
import { adapter, fixtureDb, at } from "./fixtures.js";
import { attachCalendarEvents, listCalendarContext } from "../src/context/calendar.js";

test("calendar connector attaches events to overlapping transactions and creates context rows", () => {
  const db = fixtureDb(); const a = adapter(db);
  const rows = a.all("SELECT id, occurred_at AS at FROM transactions") as Array<{ id: number; at: number }>;
  assert.ok(rows.length > 0);
  const first = (a.all("SELECT id, occurred_at AS at FROM transactions ORDER BY occurred_at LIMIT 1") as Array<{ id: number; at: number }>)[0]!;
  const r = attachCalendarEvents(a, [{ id: "ev1", title: "Boda shift", startAt: first.at - 60_000, endAt: first.at + 60_000 }], first.at);
  assert.ok(r.updated + r.created >= 1);
  const linked = listCalendarContext(a);
  assert.ok(linked.some((x) => x.eventId === "ev1" && x.title === "Boda shift"));
  db.close();
});
