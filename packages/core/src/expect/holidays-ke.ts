/**
 * Kenyan public holidays, versioned data. Used to shift expected-flow due dates.
 *
 * LEGAL BASIS: Public Holidays Act (Cap. 110, Laws of Kenya), First Schedule (fixed holidays) and s.2:
 *   - Idd-ul-Fitr and Idd-ul-Azha are declared by the Cabinet Secretary (Interior) by Gazette notice each year;
 *   - when a holiday falls on a Sunday the following Monday is a public holiday (the "in lieu" rows below).
 *   Saturday holidays are NOT moved.
 *   Statute text could not be retrieved programmatically (new.kenyalaw.org returned an empty body on
 *   2026-10-29), so the in-lieu rule is recorded here from the Act as commonly cited and from the 2027 rows
 *   published by the secondary source below. It is NOT independently verified against the Act text.
 *
 * SOURCE STATUS (retrieved 2026-10-29, Africa/Nairobi):
 *   2026 rows: cross-checked against https://www.officeholidays.com/countries/kenya/2026 (secondary aggregator)
 *     and a web-search summary citing Gazette Notice No. 3955 (Kenya Gazette Vol. CXXVIII, No. 50, 18 Mar 2026)
 *     for Idd-ul-Fitr 20 Mar 2026. The Gazette itself was NOT fetched => verified:"secondary".
 *     Idd-ul-Azha 27 May 2026 appears in the same aggregator; Gazette notice number not seen.
 *   2027 rows: https://www.officeholidays.com/countries/kenya/2027 (retrieved 2026-10-29), listing was read through
 *     Mazingira Day in lieu (11 Oct) and Mashujaa Day; December 2027 rows are DERIVED from the Sunday->Monday rule,
 *     not read from a source => verified:"derived". Idd dates for 2027 are astronomical estimates; the aggregator
 *     gives 9 Mar and 16 May, another summary gave 10 Mar / 17 May. They are unverified until gazetted.
 *   No primary (Gazette / Act) retrieval succeeded: nothing here is "official". Treat `verified` accordingly.
 *
 * Mazingira Day (10 Oct) is listed by the aggregator as a public holiday ("National Culture Day" comment);
 * its statutory status was not verified against the Act.
 */
import { type DayStr, addDays, parseDay, weekdayOf } from "./eat.js";

export type HolidayVerification = "secondary" | "derived" | "unverified";

export interface KenyaHoliday {
  date: DayStr;
  name: string;
  /** true when this row is the Monday observed because the actual holiday fell on a Sunday. */
  inLieu?: boolean;
  verified: HolidayVerification;
}

export const HOLIDAY_TABLE_VERSION = "ke-2026-2027.v1";
export const HOLIDAY_RETRIEVED_ON = "2026-10-29";
export const HOLIDAY_SOURCES = [
  "https://www.officeholidays.com/countries/kenya/2026",
  "https://www.officeholidays.com/countries/kenya/2027",
  "Kenya Gazette Vol. CXXVIII No. 50, Gazette Notice 3955 (18 Mar 2026) for Idd-ul-Fitr: cited by a search summary, not fetched",
  "Public Holidays Act, Cap. 110 (not retrieved)",
] as const;
/** Years the table covers. Outside these, only weekends shift and isPublicHoliday reports false. */
export const HOLIDAY_YEARS = [2026, 2027] as const;

const s = "secondary" as const;
const d = "derived" as const;
const u = "unverified" as const;

export const KENYA_HOLIDAYS: readonly KenyaHoliday[] = [
  // 2026
  { date: "2026-01-01", name: "New Year's Day", verified: s },
  { date: "2026-03-20", name: "Idd-ul-Fitr", verified: s },
  { date: "2026-04-03", name: "Good Friday", verified: s },
  { date: "2026-04-06", name: "Easter Monday", verified: s },
  { date: "2026-05-01", name: "Labour Day", verified: s },
  { date: "2026-05-27", name: "Idd-ul-Azha", verified: s },
  { date: "2026-06-01", name: "Madaraka Day", verified: s },
  { date: "2026-10-10", name: "Mazingira Day", verified: s },   // Saturday: not moved
  { date: "2026-10-20", name: "Mashujaa Day", verified: s },
  { date: "2026-12-12", name: "Jamhuri Day", verified: s },     // Saturday: not moved
  { date: "2026-12-25", name: "Christmas Day", verified: s },
  { date: "2026-12-26", name: "Boxing Day", verified: s },      // Saturday: not moved
  // 2027
  { date: "2027-01-01", name: "New Year's Day", verified: s },
  { date: "2027-03-09", name: "Idd-ul-Fitr (estimated)", verified: u },
  { date: "2027-03-26", name: "Good Friday", verified: s },
  { date: "2027-03-29", name: "Easter Monday", verified: s },
  { date: "2027-05-01", name: "Labour Day", verified: s },      // Saturday: not moved
  { date: "2027-05-16", name: "Idd-ul-Azha (estimated)", verified: u },   // Sunday
  { date: "2027-05-17", name: "Idd-ul-Azha (in lieu, estimated)", inLieu: true, verified: u },
  { date: "2027-06-01", name: "Madaraka Day", verified: s },
  { date: "2027-10-10", name: "Mazingira Day", verified: s },   // Sunday
  { date: "2027-10-11", name: "Mazingira Day (in lieu)", inLieu: true, verified: s },
  { date: "2027-10-20", name: "Mashujaa Day", verified: s },
  { date: "2027-12-12", name: "Jamhuri Day", verified: d },     // Sunday
  { date: "2027-12-13", name: "Jamhuri Day (in lieu)", inLieu: true, verified: d },
  { date: "2027-12-25", name: "Christmas Day", verified: d },   // Saturday
  { date: "2027-12-26", name: "Boxing Day", verified: d },      // Sunday
  { date: "2027-12-27", name: "Boxing Day (in lieu)", inLieu: true, verified: d },
];

const BY_DATE = new Map(KENYA_HOLIDAYS.map((h) => [h.date, h]));

export function holidayOn(day: DayStr): KenyaHoliday | null { return BY_DATE.get(day) ?? null; }
export function isPublicHoliday(day: DayStr): boolean { return BY_DATE.has(day); }
export function isSunday(day: DayStr): boolean { return weekdayOf(day) === 0; }
export function isWeekend(day: DayStr): boolean { const w = weekdayOf(day); return w === 0 || w === 6; }
/** Mon-Fri and not a public holiday. */
export function isWorkingDay(day: DayStr): boolean { return !isWeekend(day) && !isPublicHoliday(day); }
/** Holidays that are not yet verified against a primary source. */
export function unverifiedHolidays(): KenyaHoliday[] { return KENYA_HOLIDAYS.filter((h) => h.verified !== "secondary"); }
export function holidayCoverage(day: DayStr): boolean {
  const y = Number(day.slice(0, 4));
  return (HOLIDAY_YEARS as readonly number[]).includes(y);
}

/** Next working day strictly after `day`. Bounded to avoid pathological loops. */
export function nextWorkingDay(day: DayStr): DayStr {
  let x = addDays(day, 1);
  for (let i = 0; i < 14 && !isWorkingDay(x); i++) x = addDays(x, 1);
  return x;
}
export function prevWorkingDay(day: DayStr): DayStr {
  let x = addDays(day, -1);
  for (let i = 0; i < 14 && !isWorkingDay(x); i++) x = addDays(x, -1);
  return x;
}
/** Day itself when it is a working day, else the next one. */
export function onOrNextWorkingDay(day: DayStr): DayStr { return isWorkingDay(day) ? day : nextWorkingDay(day); }
export function onOrPrevWorkingDay(day: DayStr): DayStr { return isWorkingDay(day) ? day : prevWorkingDay(day); }

/** Last working day of the month containing `day`. */
export function lastWorkingDayOfMonth(y: number, m: number): DayStr {
  const next = m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
  return prevWorkingDay(next);
}

/** Sanity check used by tests: every Sunday holiday has its Monday in lieu (or the Monday is itself a holiday). */
export function sundayHolidaysWithoutLieu(): KenyaHoliday[] {
  return KENYA_HOLIDAYS.filter((h) => !h.inLieu && parseDay(h.date) >= 0 && isSunday(h.date) && !BY_DATE.has(addDays(h.date, 1)));
}
