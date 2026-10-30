/**
 * Ledger search grammar (deterministic, no model):
 *   >500  <100  over 500  under 100  100..500     amount (KES; stored as cents)
 *   tag:rent  cat:Groceries  venture:"Mama mboga"  from:Naivas
 *   @Karen                                        place
 *   last week / this month / today / after:2026-10-01 / before:2026-10-31
 *   everything else                               full-text over notes, labels, tags, counterparties, template
 */
import { resolveRange } from "../analyst/plan.js";
import type { PlanFilters } from "../analyst/plan.js";
import type { TimeRange } from "../analyst/semantic.js";
import type { ParsedSearch } from "./types.js";

export interface SearchVocab { tags?: string[] }

function cents(s: string): number {
  return Math.round(Number(s.replace(/,/g, "")) * 100);
}

const TIME_WORDS = /\b(today|yesterday|this week|last week|this month|last month|this year|last \d{1,3} (?:days?|weeks?|months?))\b.*$/i;

function trimPhrase(s: string): string {
  return s.replace(TIME_WORDS, "").replace(/[.,;]+$/, "").trim();
}

/** Match the longest known tag at the start of `rest`; else take up to three words. */
function takeTag(rest: string, known: string[]): string {
  const lower = rest.toLowerCase();
  const matches = known.filter((t) => lower.startsWith(t.toLowerCase())).sort((a, b) => b.length - a.length);
  if (matches.length) return matches[0]!;
  const m = /^("[^"]+"|[^\s:]+(?:\s+[^\s:]+){0,2})/.exec(rest);
  return trimPhrase((m?.[1] ?? "").replace(/^"|"$/g, ""));
}

function namedRange(q: string, now: number): TimeRange | undefined {
  if (/\btoday\b/.test(q)) return { kind: "named", name: "today" };
  if (/\byesterday\b/.test(q)) return { kind: "named", name: "yesterday" };
  if (/\bthis week\b/.test(q)) return { kind: "named", name: "this_week" };
  if (/\blast week\b/.test(q)) return { kind: "named", name: "last_week" };
  if (/\bthis month\b/.test(q)) return { kind: "named", name: "this_month" };
  if (/\blast month\b/.test(q)) return { kind: "named", name: "last_month" };
  if (/\bthis year\b/.test(q)) return { kind: "named", name: "this_year" };
  const rel = /\blast\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/.exec(q);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2]!;
    const unit = u.startsWith("day") ? "day" : u.startsWith("week") ? "week" : "month";
    if (n >= 1 && n <= 240) return { kind: "relative", unit, n };
  }
  return undefined;
}

function ymd(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 3 * 3_600_000;
}

export function parseSearch(query: string, now = Date.now(), vocab: SearchVocab = {}): ParsedSearch {
  let q = ` ${query.replace(/\s+/g, " ").trim()} `;
  const filters: PlanFilters & { place?: string } = {};
  const chips: ParsedSearch["chips"] = [];
  const textWords: string[] = [];
  const knownTags = vocab.tags ?? [];

  // 1. key:value tokens first, so ISO dates are never mistaken for amount ranges.
  const keyRe = /\b(tag|cat|label|venture|from|after|before):/gi;
  let guard = 0;
  while (guard++ < 20) {
    keyRe.lastIndex = 0;
    const m = keyRe.exec(q);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    const rest = q.slice(m.index + m[0].length);
    let value = "";
    let consumed = m[0];
    if (key === "tag" || key === "venture") {
      value = takeTag(rest, knownTags);
      consumed += value;
    } else if (key === "after" || key === "before") {
      value = /^\d{4}-\d{2}-\d{2}/.exec(rest)?.[0] ?? "";
      consumed += value;
    } else {
      const mm = /^("[^"]+"|[^\s:]+)/.exec(rest);
      value = (mm?.[1] ?? "").replace(/^"|"$/g, "");
      consumed += mm?.[1] ?? "";
    }
    q = q.slice(0, m.index) + " " + q.slice(m.index + consumed.length);
    if (!value) continue;
    if (key === "tag") { filters.tags = [...(filters.tags ?? []), value]; chips.push({ id: `tag-${value}`, label: `tag:${value}`, kind: "tag" }); }
    else if (key === "venture") { filters.ventures = [...(filters.ventures ?? []), value]; chips.push({ id: `venture-${value}`, label: `venture:${value}`, kind: "tag" }); }
    else if (key === "cat" || key === "label") { filters.labels = [...(filters.labels ?? []), value]; chips.push({ id: `cat-${value}`, label: value, kind: "label" }); }
    else if (key === "from") { filters.counterparties = [...(filters.counterparties ?? []), value]; chips.push({ id: `from-${value}`, label: `from ${value}`, kind: "text" }); }
    else if (key === "after") {
      const ms = ymd(value);
      if (ms != null) {
        const cur = filters.time?.kind === "absolute" ? filters.time : null;
        filters.time = { kind: "absolute", fromMs: ms, toMs: cur?.toMs ?? now };
        chips.push({ id: "after", label: `after ${value}`, kind: "time" });
      }
    } else if (key === "before") {
      const ms = ymd(value);
      if (ms != null) {
        const cur = filters.time?.kind === "absolute" ? filters.time : null;
        filters.time = { kind: "absolute", fromMs: cur?.fromMs ?? 0, toMs: ms + 86_400_000 };
        chips.push({ id: "before", label: `before ${value}`, kind: "time" });
      }
    }
  }

  // 2. place
  for (const m of q.matchAll(/(?:^|\s)@([\p{L}\p{N} _'-]{2,40})/gu)) {
    const place = m[1]!.trim();
    filters.place = place;
    chips.push({ id: `place-${place}`, label: `@${place}`, kind: "place" });
    q = q.replace(m[0], " ");
  }

  // 3. amounts
  const range = /(?:ksh|kes)?\s*([\d,]+)\s*(?:-|to|\.\.)\s*(?:ksh|kes)?\s*([\d,]+)/i.exec(q);
  if (range && !/^\d{4}-\d{2}-\d{2}/.test(range[0].trim())) {
    filters.minAmountCents = cents(range[1]!);
    filters.maxAmountCents = cents(range[2]!);
    chips.push({ id: "amount", label: `Ksh${range[1]} – ${range[2]}`, kind: "amount" });
    q = q.replace(range[0], " ");
  }
  const over = /\b(?:over|above|more than)\s*(?:ksh|kes)?\s*([\d,]+)/i.exec(q);
  if (over) {
    filters.minAmountCents = cents(over[1]!);
    chips.push({ id: "amount-min", label: `over Ksh${over[1]}`, kind: "amount" });
    q = q.replace(over[0], " ");
  }
  const under = /\b(?:under|below|less than)\s*(?:ksh|kes)?\s*([\d,]+)/i.exec(q);
  if (under) {
    filters.maxAmountCents = cents(under[1]!);
    chips.push({ id: "amount-max", label: `under Ksh${under[1]}`, kind: "amount" });
    q = q.replace(under[0], " ");
  }

  // 4. time
  const time = namedRange(q, now);
  if (time) {
    filters.time = time;
    const label = time.kind === "named"
      ? time.name.replace(/_/g, " ")
      : time.kind === "relative"
        ? `${time.n} ${time.unit}${time.n === 1 ? "" : "s"}`
        : resolveRange(time, now).label;
    chips.push({ id: "time", label, kind: "time" });
    q = q.replace(/\b(today|yesterday|this week|last week|this month|last month|this year)\b/gi, " ");
    q = q.replace(/\blast\s+\d{1,3}\s+(days?|weeks?|months?)\b/gi, " ");
  }

  // 5. direction
  if (/\b(sent|spent|paid|out|withdrawn)\b/i.test(q)) { filters.direction = "out"; chips.push({ id: "dir", label: "money out", kind: "text" }); }
  else if (/\b(received|income|in|deposited)\b/i.test(q)) { filters.direction = "in"; chips.push({ id: "dir", label: "money in", kind: "text" }); }
  q = q.replace(/\b(sent|spent|paid|out|withdrawn|received|income|deposited)\b/gi, " ");

  for (const w of q.trim().split(/\s+/)) {
    if (!w || /^[^\p{L}\p{N}]+$/u.test(w)) continue;
    textWords.push(w);
  }
  if (textWords.length) chips.push({ id: "text", label: textWords.join(" "), kind: "text" });

  return { filters, fts: textWords.join(" "), chips };
}

/** Human-readable label for the active time chip. */
export function describeSearch(p: ParsedSearch, now = Date.now()): string {
  return p.filters.time ? resolveRange(p.filters.time, now).label : "";
}
