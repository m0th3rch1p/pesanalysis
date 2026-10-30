import test from "node:test";
import assert from "node:assert/strict";
import { addDays, dayOf, dayStartMs, daysInMonth, diffDays, parseDay, weekdayOf, clampedDay } from "../src/expect/eat.js";
import {
  KENYA_HOLIDAYS, holidayOn, isPublicHoliday, isWorkingDay, lastWorkingDayOfMonth, nextWorkingDay, prevWorkingDay,
  sundayHolidaysWithoutLieu, unverifiedHolidays, HOLIDAY_RETRIEVED_ON, HOLIDAY_SOURCES, holidayCoverage,
} from "../src/expect/holidays-ke.js";
import { generateOccurrences, nominalDates, shiftDue, validateCadence } from "../src/expect/occurrences.js";

test("EAT day arithmetic: boundary at 21:00 UTC, no DST, leap days", () => {
  assert.equal(dayOf(Date.UTC(2026, 9, 28, 20, 59, 59, 999)), "2026-10-28");
  assert.equal(dayOf(Date.UTC(2026, 9, 28, 21, 0, 0)), "2026-10-29");
  assert.equal(dayStartMs("2026-10-29"), Date.UTC(2026, 9, 28, 21, 0, 0));
  assert.equal(dayOf(dayStartMs("2027-03-01")), "2027-03-01");
  assert.equal(dayOf(dayStartMs("2027-03-01") - 1), "2027-02-28");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(diffDays("2026-12-31", "2026-01-01"), 364);
  assert.equal(weekdayOf("1970-01-01"), 4);
  assert.equal(weekdayOf("2026-10-29"), 4);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(clampedDay(2027, 4, 31), "2027-04-30");
  assert.throws(() => parseDay("2027-02-29"));
  assert.throws(() => parseDay("2027-13-01"));
  assert.throws(() => parseDay("27-01-01"));
});

test("holiday table: sorted, unique, valid, Sunday rule respected, Saturdays not moved", () => {
  const dates = KENYA_HOLIDAYS.map((h) => h.date);
  assert.deepEqual([...dates].sort(), dates);
  assert.equal(new Set(dates).size, dates.length);
  for (const h of KENYA_HOLIDAYS) {
    parseDay(h.date);
    if (h.inLieu) {
      assert.equal(weekdayOf(h.date), 1, `${h.date} in lieu must be a Monday`);
      assert.equal(weekdayOf(addDays(h.date, -1)), 0);
      assert.ok(holidayOn(addDays(h.date, -1)), "lieu follows a real Sunday holiday");
    }
  }
  assert.deepEqual(sundayHolidaysWithoutLieu().map((h) => h.date), []);
  // Saturday holidays: no Monday row
  for (const d of ["2026-10-10", "2026-12-12", "2026-12-26", "2027-05-01", "2027-12-25"]) {
    assert.equal(weekdayOf(d), 6);
    assert.ok(isPublicHoliday(d));
    assert.ok(!holidayOn(addDays(d, 2))?.inLieu || d === "2027-12-25"); // 27 Dec 2027 is lieu for Sunday Boxing Day, not for Saturday Christmas
  }
  assert.equal(isPublicHoliday("2026-10-12"), false);
  assert.equal(isPublicHoliday("2027-12-13"), true);
  assert.equal(isPublicHoliday("2027-12-27"), true);
});

test("holiday data carries provenance; unverified entries are flagged", () => {
  assert.equal(HOLIDAY_RETRIEVED_ON, "2026-10-29");
  assert.ok(HOLIDAY_SOURCES.length >= 2);
  const unv = unverifiedHolidays().map((h) => h.date);
  assert.ok(unv.includes("2027-03-09") && unv.includes("2027-05-16") && unv.includes("2027-12-13"));
  assert.ok(KENYA_HOLIDAYS.every((h) => ["secondary", "derived", "unverified"].includes(h.verified)));
  assert.equal(holidayCoverage("2026-05-05"), true);
  assert.equal(holidayCoverage("2028-05-05"), false);
});

test("working-day helpers across Easter 2026", () => {
  assert.equal(isWorkingDay("2026-04-03"), false);
  assert.equal(isWorkingDay("2026-04-04"), false);
  assert.equal(isWorkingDay("2026-04-07"), true);
  assert.equal(nextWorkingDay("2026-04-02"), "2026-04-07");
  assert.equal(prevWorkingDay("2026-04-07"), "2026-04-02");
  assert.equal(lastWorkingDayOfMonth(2026, 5), "2026-05-29");
  assert.equal(lastWorkingDayOfMonth(2026, 10), "2026-10-30");
  assert.equal(lastWorkingDayOfMonth(2026, 12), "2026-12-31");
  assert.equal(lastWorkingDayOfMonth(2027, 5), "2027-05-31");
  assert.equal(lastWorkingDayOfMonth(2027, 12), "2027-12-31");
});

test("monthly: day clamping incl. leap year and 30-day months", () => {
  const r = { cadence: "monthly" as const, dayOfMonth: 31 };
  assert.deepEqual(nominalDates(r, "2027-01-01", "2027-04-30"), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  assert.deepEqual(nominalDates(r, "2028-02-01", "2028-02-29"), ["2028-02-29"]);
  assert.deepEqual(nominalDates({ cadence: "monthly", dayOfMonth: 29 }, "2027-02-01", "2027-03-01"), ["2027-02-28"]);
});

test("monthly 28th with weekend shifts before/after/none", () => {
  const base = { cadence: "monthly" as const, dayOfMonth: 28 };
  const g = (p: "none" | "before" | "after") => generateOccurrences({ ...base, holidayPolicy: p }, "2026-02-01", "2026-03-31");
  assert.deepEqual(g("none").map((o) => o.dueOn), ["2026-02-28", "2026-03-28"]);
  assert.deepEqual(g("before").map((o) => o.dueOn), ["2026-02-27", "2026-03-27"]);
  assert.deepEqual(g("after").map((o) => o.dueOn), ["2026-03-02", "2026-03-30"]);
  assert.equal(g("after")[0]!.nominalOn, "2026-02-28");
  assert.equal(g("after")[0]!.shifted, true);
});

test("monthly holiday shifts: Easter, New Year, in-lieu Monday", () => {
  const m3 = { cadence: "monthly" as const, dayOfMonth: 3 };
  assert.equal(generateOccurrences({ ...m3, holidayPolicy: "after" }, "2026-04-01", "2026-04-30")[0]!.dueOn, "2026-04-07");
  assert.equal(generateOccurrences({ ...m3, holidayPolicy: "before" }, "2026-04-01", "2026-04-30")[0]!.dueOn, "2026-04-02");
  const m1 = { cadence: "monthly" as const, dayOfMonth: 1 };
  assert.equal(generateOccurrences({ ...m1, holidayPolicy: "after" }, "2026-01-01", "2026-01-31")[0]!.dueOn, "2026-01-02");
  assert.equal(generateOccurrences({ ...m1, holidayPolicy: "after" }, "2027-01-01", "2027-01-31")[0]!.dueOn, "2027-01-04");
  assert.equal(generateOccurrences({ ...m1, holidayPolicy: "before" }, "2026-12-01", "2027-01-31").find((o) => o.nominalOn === "2027-01-01")!.dueOn, "2026-12-31");
  // 13 Dec 2027 is a holiday in lieu: a payment due on it moves to Tuesday
  assert.equal(shiftDue("2027-12-13", "after", "monthly"), "2027-12-14");
  assert.equal(shiftDue("2027-12-12", "after", "monthly"), "2027-12-14"); // Sunday, then Monday-in-lieu, then Tuesday
});

test("weekly rules are shifted only by public holidays, never by weekends", () => {
  const sat = { cadence: "weekly" as const, weekday: 6, holidayPolicy: "after" as const };
  assert.deepEqual(generateOccurrences(sat, "2026-03-01", "2026-03-31").map((o) => o.dueOn), ["2026-03-07", "2026-03-14", "2026-03-21", "2026-03-28"]);
  const mon = { cadence: "weekly" as const, weekday: 1 };
  assert.ok(generateOccurrences(mon, "2026-04-01", "2026-04-10").some((o) => o.dueOn === "2026-04-06"));
  const monAfter = generateOccurrences({ ...mon, holidayPolicy: "after" }, "2026-04-01", "2026-04-10");
  assert.deepEqual(monAfter.map((o) => o.dueOn), ["2026-04-07"]);
});

test("last_working_day, once, custom interval, starts/ends bounds", () => {
  assert.deepEqual(generateOccurrences({ cadence: "last_working_day" }, "2026-05-01", "2026-06-30").map((o) => o.dueOn), ["2026-05-29", "2026-06-30"]);
  assert.deepEqual(generateOccurrences({ cadence: "once", anchorOn: "2026-11-15" }, "2026-11-01", "2026-11-30").map((o) => o.dueOn), ["2026-11-15"]);
  assert.deepEqual(generateOccurrences({ cadence: "once", anchorOn: "2026-11-15" }, "2026-12-01", "2026-12-30"), []);
  const c = { cadence: "custom" as const, intervalDays: 14, anchorOn: "2026-10-01" };
  assert.deepEqual(generateOccurrences(c, "2026-10-20", "2026-11-20").map((o) => o.dueOn), ["2026-10-29", "2026-11-12", "2026-11-26"].slice(0, 2));
  assert.deepEqual(generateOccurrences(c, "2026-09-01", "2026-10-15").map((o) => o.dueOn), ["2026-10-01", "2026-10-15"]);
  const b = generateOccurrences({ cadence: "monthly", dayOfMonth: 10, startsOn: "2026-02-10", endsOn: "2026-04-09" }, "2026-01-01", "2026-12-31");
  assert.deepEqual(b.map((o) => o.dueOn), ["2026-02-10", "2026-03-10"]);
});

test("validation rejects malformed rules and generation returns nothing", () => {
  assert.ok(validateCadence({ cadence: "monthly" }));
  assert.ok(validateCadence({ cadence: "monthly", dayOfMonth: 32 }));
  assert.ok(validateCadence({ cadence: "weekly", weekday: 7 }));
  assert.ok(validateCadence({ cadence: "custom", intervalDays: 0, anchorOn: "2026-01-01" }));
  assert.ok(validateCadence({ cadence: "once" }));
  assert.equal(validateCadence({ cadence: "last_working_day" }), null);
  assert.deepEqual(generateOccurrences({ cadence: "monthly" }, "2026-01-01", "2026-12-31"), []);
});

test("window edges: a shifted occurrence is included by its due date, not its nominal date", () => {
  const r = { cadence: "monthly" as const, dayOfMonth: 3, holidayPolicy: "before" as const }; // nominal Apr 3 -> due Apr 2
  assert.deepEqual(generateOccurrences(r, "2026-04-02", "2026-04-02").map((o) => o.dueOn), ["2026-04-02"]);
  assert.deepEqual(generateOccurrences(r, "2026-04-03", "2026-04-29"), []);
});

test("generation is idempotent and window-partitioned (property)", () => {
  const rules = [
    { cadence: "monthly" as const, dayOfMonth: 28, holidayPolicy: "after" as const },
    { cadence: "monthly" as const, dayOfMonth: 31, holidayPolicy: "before" as const },
    { cadence: "monthly" as const, dayOfMonth: 1, holidayPolicy: "after" as const },
    { cadence: "weekly" as const, weekday: 1, holidayPolicy: "after" as const },
    { cadence: "custom" as const, intervalDays: 10, anchorOn: "2026-01-05", holidayPolicy: "before" as const },
    { cadence: "last_working_day" as const },
  ];
  for (const r of rules) {
    const full = generateOccurrences(r, "2026-01-01", "2027-12-31");
    assert.deepEqual(generateOccurrences(r, "2026-01-01", "2027-12-31"), full);
    for (const cut of ["2026-03-15", "2026-10-29", "2027-04-05", "2027-12-13"]) {
      const a = generateOccurrences(r, "2026-01-01", cut);
      const b = generateOccurrences(r, addDays(cut, 1), "2027-12-31");
      assert.deepEqual([...a, ...b], full, `${r.cadence} cut ${cut}`);
    }
    if (r.cadence === "monthly" && "holidayPolicy" in r) {
      for (const o of full) {
        assert.ok(isWorkingDay(o.dueOn) || o.dueOn < "2026-01-01" || o.dueOn > "2027-12-31", `${o.dueOn} should be a working day`);
        assert.ok(Math.abs(diffDays(o.dueOn, o.nominalOn)) <= 5);
      }
    }
  }
});
