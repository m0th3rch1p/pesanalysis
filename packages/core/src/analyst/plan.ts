/**
 * QueryPlan: the only shape an LLM (or the rules router) may produce (D38).
 * Validated against a closed vocabulary, compiled to parameterised read-only SQL over tx_events.
 *
 * QVAC 0.22 can constrain generation to `QUERY_PLAN_JSON_SCHEMA` natively (GBNF). `strict` does
 * not auto-tighten in QVAC, so the schema sets `additionalProperties:false` everywhere itself.
 */
import { NotImplemented } from "../util/not-implemented.js";
import { formatKes } from "../sms/money.js";
import {
  BUCKETS, DIMENSION_LABELS, DIMENSIONS, DIRECTIONS, MAX_GROUP_BY, MAX_LIMIT, MEASURE_LABELS, MEASURES,
  TIME_NAMES, TIME_UNITS, type TimeBucket, type Dimension, type PlanDirection, type Measure, type TimeName, type TimeRange, type TimeUnit,
} from "./semantic.js";

export interface PlanFilters {
  time?: TimeRange;
  direction?: PlanDirection;
  minAmountCents?: number;
  maxAmountCents?: number;
  labels?: string[];
  tags?: string[];
  ventures?: string[];
  counterparties?: string[];
  roles?: string[];
  items?: string[];
  groups?: string[];
  habits?: string[];
  funding?: "credit" | "wallet" | "any";
  hourWindow?: { startMin: number; endMin: number };
  weekdays?: number[];
  text?: string;
}

export interface QueryPlan {
  version: 1;
  measure: Measure;
  groupBy?: Dimension[];
  filters?: PlanFilters;
  compare?: { to: TimeRange };
  bucket?: TimeBucket;
  orderBy?: { by: "value" | "key"; dir: "asc" | "desc" };
  limit?: number;
  needs?: { slot: string; question: string; options?: string[] };
}

export type PlanValidation = { ok: true; plan: QueryPlan } | { ok: false; errors: string[] };

const TOP_KEYS = new Set(["version", "measure", "groupBy", "filters", "compare", "bucket", "orderBy", "limit", "needs"]);
const FILTER_KEYS = new Set(["time", "direction", "minAmountCents", "maxAmountCents", "labels", "tags", "ventures", "counterparties", "roles", "items", "groups", "habits", "funding", "hourWindow", "weekdays", "text"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string") && v.length <= 40;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);

function validateTime(v: unknown, path: string, errors: string[]): void {
  if (!isObj(v)) return void errors.push(`${path} must be an object`);
  for (const k of Object.keys(v)) if (!["kind", "fromMs", "toMs", "unit", "n", "offset", "name"].includes(k)) errors.push(`${path}.${k} is not allowed`);
  const kind = v.kind;
  if (kind === "absolute") {
    if (!isInt(v.fromMs) || !isInt(v.toMs)) errors.push(`${path} absolute needs integer fromMs/toMs`);
    else if ((v.fromMs as number) >= (v.toMs as number)) errors.push(`${path} fromMs must be < toMs`);
  } else if (kind === "relative") {
    if (!TIME_UNITS.includes(v.unit as TimeUnit)) errors.push(`${path}.unit must be one of ${TIME_UNITS.join("|")}`);
    if (!isInt(v.n) || (v.n as number) < 1 || (v.n as number) > 240) errors.push(`${path}.n must be 1..240`);
    if (v.offset != null && (!isInt(v.offset) || (v.offset as number) < 0 || (v.offset as number) > 240)) errors.push(`${path}.offset must be 0..240`);
  } else if (kind === "named") {
    if (!TIME_NAMES.includes(v.name as TimeName)) errors.push(`${path}.name must be one of ${TIME_NAMES.join("|")}`);
  } else {
    errors.push(`${path}.kind must be absolute|relative|named`);
  }
}

export function validatePlan(input: unknown): PlanValidation {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["plan must be an object"] };
  for (const k of Object.keys(input)) if (!TOP_KEYS.has(k)) errors.push(`${k} is not allowed`);
  if (input.version !== 1) errors.push("version must be 1");
  if (!MEASURES.includes(input.measure as Measure)) errors.push(`measure must be one of ${MEASURES.join("|")}`);

  const groupBy = input.groupBy;
  if (groupBy !== undefined) {
    if (!Array.isArray(groupBy) || groupBy.length === 0 || groupBy.length > MAX_GROUP_BY || !groupBy.every((d) => DIMENSIONS.includes(d as Dimension))) {
      errors.push(`groupBy must contain 1..${MAX_GROUP_BY} of ${DIMENSIONS.join("|")}`);
    } else if (new Set(groupBy).size !== groupBy.length) errors.push("groupBy contains duplicates");
  }

  const filters = input.filters;
  if (filters !== undefined) {
    if (!isObj(filters)) errors.push("filters must be an object");
    else {
      for (const k of Object.keys(filters)) if (!FILTER_KEYS.has(k)) errors.push(`filters.${k} is not allowed`);
      if (filters.time !== undefined) validateTime(filters.time, "filters.time", errors);
      if (filters.direction !== undefined && !DIRECTIONS.includes(filters.direction as PlanDirection)) errors.push(`filters.direction must be one of ${DIRECTIONS.join("|")}`);
      for (const k of ["minAmountCents", "maxAmountCents"] as const) {
        if (filters[k] !== undefined && (!isInt(filters[k]) || (filters[k] as number) < 0)) errors.push(`filters.${k} must be a non-negative integer`);
      }
      if (isInt(filters.minAmountCents) && isInt(filters.maxAmountCents) && filters.minAmountCents > filters.maxAmountCents) errors.push("minAmountCents must be <= maxAmountCents");
      for (const k of ["labels", "tags", "ventures", "counterparties", "roles", "items", "groups", "habits"] as const) {
        if (filters[k] !== undefined && !isStrArray(filters[k])) errors.push(`filters.${k} must be a string[]`);
      }
      if (filters.funding !== undefined && !["credit", "wallet", "any"].includes(filters.funding as string)) errors.push("filters.funding must be credit|wallet|any");
      if (filters.hourWindow !== undefined) {
        const w = filters.hourWindow;
        if (!isObj(w) || !isInt(w.startMin) || !isInt(w.endMin) || (w.startMin as number) < 0 || (w.startMin as number) >= 1440 || (w.endMin as number) < 0 || (w.endMin as number) >= 1440) errors.push("filters.hourWindow must be {startMin,endMin} in 0..1439");
      }
      if (filters.weekdays !== undefined) {
        if (!Array.isArray(filters.weekdays) || !filters.weekdays.every((d) => isInt(d) && d >= 0 && d <= 6)) errors.push("filters.weekdays must be an array of 0..6");
      }
      if (filters.text !== undefined && (typeof filters.text !== "string" || filters.text.length > 120)) errors.push("filters.text must be a string <=120 chars");
    }
  }

  if (input.compare !== undefined) {
    if (!isObj(input.compare)) errors.push("compare must be an object");
    else validateTime(input.compare.to, "compare.to", errors);
  }
  if (input.bucket !== undefined && !BUCKETS.includes(input.bucket as TimeBucket)) errors.push(`bucket must be one of ${BUCKETS.join("|")}`);
  if (input.orderBy !== undefined) {
    if (!isObj(input.orderBy)) errors.push("orderBy must be an object");
    else {
      if (input.orderBy.by !== "value" && input.orderBy.by !== "key") errors.push("orderBy.by must be value|key");
      if (input.orderBy.dir !== "asc" && input.orderBy.dir !== "desc") errors.push("orderBy.dir must be asc|desc");
    }
  }
  if (input.limit !== undefined && (!isInt(input.limit) || (input.limit as number) < 1 || (input.limit as number) > MAX_LIMIT)) errors.push(`limit must be 1..${MAX_LIMIT}`);
  if (input.needs !== undefined) {
    if (!isObj(input.needs) || typeof input.needs.slot !== "string" || typeof input.needs.question !== "string") errors.push("needs must be {slot,question,options?}");
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan: input as unknown as QueryPlan };
}

/** Strict JSON Schema for constrained decoding. Keep in sync with validatePlan (tested). */
export const QUERY_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "measure"],
  properties: {
    version: { type: "integer", enum: [1] },
    measure: { type: "string", enum: [...MEASURES] },
    groupBy: { type: "array", maxItems: MAX_GROUP_BY, items: { type: "string", enum: [...DIMENSIONS] } },
    bucket: { type: "string", enum: [...BUCKETS] },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    orderBy: {
      type: "object", additionalProperties: false, required: ["by", "dir"],
      properties: { by: { type: "string", enum: ["value", "key"] }, dir: { type: "string", enum: ["asc", "desc"] } },
    },
    compare: { type: "object", additionalProperties: false, required: ["to"], properties: { to: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["absolute", "relative", "named"] },
        fromMs: { type: "integer" }, toMs: { type: "integer" },
        unit: { type: "string", enum: [...TIME_UNITS] },
        n: { type: "integer", minimum: 1, maximum: 240 },
        offset: { type: "integer", minimum: 0, maximum: 240 },
        name: { type: "string", enum: [...TIME_NAMES] },
      },
    } } },
    needs: {
      type: "object", additionalProperties: false, required: ["slot", "question"],
      properties: { slot: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
    },
    filters: {
      type: "object", additionalProperties: false,
      properties: {
        time: {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["absolute", "relative", "named"] },
        fromMs: { type: "integer" }, toMs: { type: "integer" },
        unit: { type: "string", enum: [...TIME_UNITS] },
        n: { type: "integer", minimum: 1, maximum: 240 },
        offset: { type: "integer", minimum: 0, maximum: 240 },
        name: { type: "string", enum: [...TIME_NAMES] },
      },
    },
        direction: { type: "string", enum: [...DIRECTIONS] },
        minAmountCents: { type: "integer", minimum: 0 },
        maxAmountCents: { type: "integer", minimum: 0 },
        labels: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        ventures: { type: "array", items: { type: "string" } },
        counterparties: { type: "array", items: { type: "string" } },
        roles: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "string" } },
        groups: { type: "array", items: { type: "string" } },
        habits: { type: "array", items: { type: "string" } },
        funding: { type: "string", enum: ["credit", "wallet", "any"] },
        hourWindow: { type: "object", additionalProperties: false, required: ["startMin", "endMin"], properties: { startMin: { type: "integer", minimum: 0, maximum: 1439 }, endMin: { type: "integer", minimum: 0, maximum: 1439 } } },
        weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
        text: { type: "string", maxLength: 120 },
      },
    },
  },
} as const;

// ---------- time ----------
const HOUR = 3_600_000;
const DAY = 86_400_000;
const EAT = 3 * HOUR;

function eat(ms: number) {
  const d = new Date(ms + EAT);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
}
function midnight(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - EAT;
}
function addMonths(ms: number, n: number): number {
  const p = eat(ms);
  return midnight(p.y, p.m + n, 1);
}
function startOfWeek(ms: number): number {
  const p = eat(ms);
  const mondayOffset = (p.wd + 6) % 7; // Mon=0
  return midnight(p.y, p.m, p.d) - mondayOffset * DAY;
}
function startOfMonth(ms: number): number {
  const p = eat(ms);
  return midnight(p.y, p.m, 1);
}
function startOfYear(ms: number): number {
  const p = eat(ms);
  return midnight(p.y, 1, 1);
}

export interface ResolvedRange {
  from: number;
  to: number;
  label: string;
  previous: { from: number; to: number; label: string };
  explicit: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(ms: number, withYear = false): string {
  const p = eat(ms);
  return `${p.d} ${MONTHS[p.m - 1]}${withYear ? ` ${p.y}` : ""}`;
}

function named(name: TimeName, now: number): ResolvedRange {
  switch (name) {
    case "today": {
      const from = midnight(eat(now).y, eat(now).m, eat(now).d);
      const y = midnight(eat(now).y, eat(now).m, eat(now).d) - DAY;
      return { from, to: now, label: "today", previous: { from: y, to: from, label: "yesterday" }, explicit: true };
    }
    case "yesterday": {
      const to = midnight(eat(now).y, eat(now).m, eat(now).d);
      const from = to - DAY;
      return { from, to, label: "yesterday", previous: { from: from - DAY, to: from, label: "the day before" }, explicit: true };
    }
    case "this_week": {
      const from = startOfWeek(now);
      return { from, to: now, label: "this week", previous: { from: from - 7 * DAY, to: from, label: "last week" }, explicit: true };
    }
    case "last_week": {
      const to = startOfWeek(now);
      const from = to - 7 * DAY;
      return { from, to, label: "last week", previous: { from: from - 7 * DAY, to: from, label: "the week before" }, explicit: true };
    }
    case "this_month": {
      const from = startOfMonth(now);
      return { from, to: now, label: `this month (${MONTHS[eat(from).m - 1]} ${eat(from).y})`, previous: { from: addMonths(from, -1), to: from, label: "last month" }, explicit: true };
    }
    case "last_month": {
      const to = startOfMonth(now);
      const from = addMonths(to, -1);
      return { from, to, label: `last month (${MONTHS[eat(from).m - 1]} ${eat(from).y})`, previous: { from: addMonths(from, -1), to: from, label: "the month before" }, explicit: true };
    }
    case "this_year": {
      const from = startOfYear(now);
      return { from, to: now, label: `${eat(from).y} so far`, previous: { from: midnight(eat(from).y - 1, 1, 1), to: midnight(eat(from).y, 1, 1), label: `${eat(from).y - 1}` }, explicit: true };
    }
  }
}

function relative(unit: TimeUnit, n: number, offset: number, now: number): ResolvedRange {
  const back = offset ?? 0;
  if (unit === "day") {
    const from = midnight(eat(now).y, eat(now).m, eat(now).d) - (n - 1 + back * n) * DAY;
    const to = back ? from + n * DAY : now;
    const label = back ? `${n} days ending ${dateLabel(to - DAY, true)}` : `last ${n} day${n === 1 ? "" : "s"}`;
    return { from, to, label, previous: { from: from - n * DAY, to: from, label: `previous ${n} days` }, explicit: true };
  }
  if (unit === "week") {
    const from = startOfWeek(now) - (n - 1 + back * n) * 7 * DAY;
    const to = back ? from + n * 7 * DAY : now;
    return { from, to, label: back ? `${n} weeks ending ${dateLabel(to - DAY, true)}` : `last ${n} week${n === 1 ? "" : "s"}`, previous: { from: from - n * 7 * DAY, to: from, label: `previous ${n} weeks` }, explicit: true };
  }
  if (unit === "month") {
    const thisMonth = startOfMonth(now);
    const from = addMonths(thisMonth, -(n - 1 + back * n));
    const to = back ? addMonths(from, n) : now;
    return { from, to, label: back ? `${n} months ending ${MONTHS[eat(to - DAY).m - 1]} ${eat(to - DAY).y}` : `last ${n} month${n === 1 ? "" : "s"}`, previous: { from: addMonths(from, -n), to: from, label: `previous ${n} months` }, explicit: true };
  }
  const thisYear = startOfYear(now);
  const from = midnight(eat(thisYear).y - (n - 1 + back * n), 1, 1);
  const to = back ? midnight(eat(from).y + n, 1, 1) : now;
  return { from, to, label: back ? `${n} years ending ${eat(to - DAY).y}` : `last ${n} year${n === 1 ? "" : "s"}`, previous: { from: midnight(eat(from).y - n, 1, 1), to: from, label: `previous ${n} years` }, explicit: true };
}

export function resolveRange(range: TimeRange | undefined, now: number, fallback: TimeName = "this_month"): ResolvedRange {
  if (!range) return named(fallback, now);
  if (range.kind === "absolute") {
    const span = range.toMs - range.fromMs;
    return {
      from: range.fromMs, to: range.toMs, label: `${dateLabel(range.fromMs, true)} – ${dateLabel(range.toMs - 1, true)}`,
      previous: { from: range.fromMs - span, to: range.fromMs, label: "previous period" }, explicit: true,
    };
  }
  if (range.kind === "relative") return relative(range.unit, range.n, range.offset ?? 0, now);
  return named(range.name, now);
}

// ---------- SQL ----------
const DIM_EXPR: Record<Dimension, string> = {
  label: `COALESCE(label, 'Unlabelled')`,
  counterparty: `COALESCE(counterparty, 'Unknown')`,
  role: `COALESCE(role, 'Unknown')`,
  tag: `COALESCE(tags, 'Untagged')`,
  venture: `COALESCE(venture_tags, 'No venture')`,
  kind: `kind`,
  provider: `provider`,
  scope: `scope`,
  hour: `strftime('%H', occurred_at / 1000, 'unixepoch', '+3 hours')`,
  weekday: `strftime('%w', occurred_at / 1000, 'unixepoch', '+3 hours')`,
  day: `strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', '+3 hours')`,
  week: `strftime('%Y-W%W', occurred_at / 1000, 'unixepoch', '+3 hours')`,
  month: `strftime('%Y-%m', occurred_at / 1000, 'unixepoch', '+3 hours')`,
  place: `COALESCE(place, 'Unknown')`,
  item: `COALESCE(items, 'No item')`,
  item_group: `COALESCE(item_groups, 'No group')`,
  habit: `COALESCE(habits, 'No habit')`,
  funding: `CASE WHEN credit = 1 THEN 'credit' ELSE 'wallet' END`,
};

function measureExpr(measure: Measure, itemAmount = false): string {
  const spendAmount = itemAmount ? "COALESCE(item_amount_cents, amount)" : "amount";
  switch (measure) {
    case "spend": return `SUM(CASE WHEN direction = 'out' AND COALESCE(flow_class,'') <> 'debt_repay' THEN ${spendAmount} ELSE 0 END)`;
    case "income": return `SUM(CASE WHEN direction = 'in' AND COALESCE(flow_class,'') <> 'debt_draw' THEN amount ELSE 0 END)`;
    case "net": return `SUM(CASE WHEN direction = 'in' AND COALESCE(flow_class,'') <> 'debt_draw' THEN amount WHEN direction = 'out' AND COALESCE(flow_class,'') <> 'debt_repay' THEN -amount ELSE 0 END)`;
    case "fees": return `SUM(COALESCE(fee, 0))`;
    case "count": return `COUNT(*)`;
    case "avg": return `AVG(amount)`;
    case "max": return `MAX(amount)`;
    case "share": return `SUM(CASE WHEN direction = 'out' AND COALESCE(flow_class,'') <> 'debt_repay' THEN amount ELSE 0 END)`;
    case "credit_share": return `SUM(CASE WHEN direction = 'out' AND credit = 1 THEN amount ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0)`;
    case "credit_cost": return `SUM(CASE WHEN credit = 1 AND direction = 'out' THEN COALESCE(fee, 0) ELSE 0 END)`;
    case "count_items": return `SUM(item_count)`;
  }
}

const CTE = `WITH ev AS (
  SELECT t.id, t.occurred_at, t.amount, t.fee, t.direction, t.flow_class, t.kind, t.provider, t.scope,
         COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS counterparty,
         r.name AS role,
         (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id
           WHERE tl.tx_id = t.id
           ORDER BY (tl.confirmed_at IS NOT NULL) DESC, tl.confidence DESC LIMIT 1) AS label,
         (SELECT GROUP_CONCAT(tg.name, ', ') FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.tx_id = t.id) AS tags,
         (SELECT GROUP_CONCAT(tg.name, ', ') FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.tx_id = t.id AND tg.kind = 'venture') AS venture_tags,
         (SELECT p.name FROM tx_context ctx JOIN places p ON p.id = ctx.place_id
           WHERE ctx.tx_id = t.id) AS place,
         (SELECT GROUP_CONCAT(i.name, ', ') FROM tx_items ti JOIN items i ON i.id = ti.item_id
           WHERE ti.tx_id = t.id) AS items,
         (SELECT GROUP_CONCAT(g.name, ', ') FROM tx_items ti JOIN item_groups g ON g.id = COALESCE(ti.group_id, (SELECT group_id FROM items WHERE id = ti.item_id))
           WHERE ti.tx_id = t.id) AS item_groups,
         (SELECT GROUP_CONCAT(h.name, ', ') FROM tx_items ti JOIN items i ON i.id = ti.item_id JOIN habits h ON h.id = i.habit_id
           WHERE ti.tx_id = t.id) AS habits,
         EXISTS (SELECT 1 FROM transactions f WHERE f.role = 'funding_notice' AND f.ref IS NOT NULL AND f.ref = t.event_ref) AS credit,
         (SELECT COUNT(*) FROM tx_items ti WHERE ti.tx_id = t.id) AS item_count,
         (SELECT SUM(ti.amount_cents) FROM tx_items ti WHERE ti.tx_id = t.id AND ti.amount_cents IS NOT NULL) AS item_amount_cents
    FROM tx_events t
    LEFT JOIN counterparties c ON c.id = t.counterparty_id
    LEFT JOIN roles r ON r.id = c.role_id
   WHERE {where}
)`;

interface FilterBuild { sql: string; params: (string | number)[] }

function buildWhere(plan: QueryPlan, range: ResolvedRange): FilterBuild {
  const f = plan.filters ?? {};
  const parts: string[] = ["t.occurred_at >= ?", "t.occurred_at < ?"];
  const params: (string | number)[] = [range.from, range.to];
  if (f.direction && f.direction !== "any") { parts.push("t.direction = ?"); params.push(f.direction); }
  if (f.minAmountCents != null) { parts.push("t.amount >= ?"); params.push(f.minAmountCents); }
  if (f.maxAmountCents != null) { parts.push("t.amount <= ?"); params.push(f.maxAmountCents); }
  if (f.labels?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND l.name IN (${f.labels.map(() => "?").join(",")}))`);
    params.push(...f.labels);
  }
  if (f.tags?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.name IN (${f.tags.map(() => "?").join(",")}))`);
    params.push(...f.tags);
  }
  if (f.ventures?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.kind = 'venture' AND tg.name IN (${f.ventures.map(() => "?").join(",")}))`);
    params.push(...f.ventures);
  }
  if (f.counterparties?.length) {
    parts.push(`(${f.counterparties.map(() => `COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) LIKE ?`).join(" OR ")})`);
    params.push(...f.counterparties.map((x) => `%${x}%`));
  }
  if (f.roles?.length) {
    parts.push(`r.name IN (${f.roles.map(() => "?").join(",")})`);
    params.push(...f.roles);
  }
  if (f.items?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id = ti.item_id WHERE ti.tx_id = t.id AND (i.key IN (${f.items.map(() => "?").join(",")}) OR i.name IN (${f.items.map(() => "?").join(",")})))`);
    const keys = f.items.map((x) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim());
    params.push(...keys, ...f.items);
  }
  if (f.groups?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN item_groups g ON g.id = ti.group_id WHERE ti.tx_id = t.id AND g.name IN (${f.groups.map(() => "?").join(",")}))`);
    params.push(...f.groups);
  }
  if (f.habits?.length) {
    parts.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id = ti.item_id JOIN habits h ON h.id = i.habit_id WHERE ti.tx_id = t.id AND h.name IN (${f.habits.map(() => "?").join(",")}))`);
    params.push(...f.habits);
  }
  if (f.funding === "credit") parts.push(`EXISTS (SELECT 1 FROM transactions fn WHERE fn.role='funding_notice' AND fn.ref IS NOT NULL AND fn.ref = t.event_ref)`);
  if (f.funding === "wallet") parts.push(`NOT EXISTS (SELECT 1 FROM transactions fn WHERE fn.role='funding_notice' AND fn.ref IS NOT NULL AND fn.ref = t.event_ref)`);
  if (f.hourWindow) {
    const w = f.hourWindow;
    const minute = `CAST(strftime('%H', t.occurred_at/1000, 'unixepoch', '+3 hours') AS INTEGER) * 60 + CAST(strftime('%M', t.occurred_at/1000, 'unixepoch', '+3 hours') AS INTEGER)`;
    if (w.startMin <= w.endMin) { parts.push(`(${minute} >= ? AND ${minute} < ?)`); params.push(w.startMin, w.endMin); }
    else { parts.push(`(${minute} >= ? OR ${minute} < ?)`); params.push(w.startMin, w.endMin); }
  }
  if (f.weekdays?.length) {
    parts.push(`CAST(strftime('%w', t.occurred_at/1000, 'unixepoch', '+3 hours') AS INTEGER) IN (${f.weekdays.map(() => "?").join(",")})`);
    params.push(...f.weekdays);
  }
  if (f.text) {
    parts.push(`(
      COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), '') LIKE ? OR
      EXISTS (SELECT 1 FROM tx_notes n WHERE n.tx_id = t.id AND n.text LIKE ?) OR
      EXISTS (SELECT 1 FROM attachments a WHERE a.tx_id = t.id AND a.caption LIKE ?) OR
      EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND l.name LIKE ?) OR
      EXISTS (SELECT 1 FROM tx_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.tx_id = t.id AND tg.name LIKE ?) OR
      t.template LIKE ?
    )`);
    const q = `%${f.text}%`;
    params.push(q, q, q, q, q);
  }
  return { sql: parts.join(" AND "), params };
}

export interface CompiledQuery {
  sql: string;
  params: (string | number)[];
  explain: string;
  range: ResolvedRange;
  comparison?: { sql: string; params: (string | number)[]; range: { from: number; to: number; label: string } };
}

function selectSql(plan: QueryPlan, range: ResolvedRange): { sql: string; params: (string | number)[] } {
  const where = buildWhere(plan, range);
  const dims = plan.groupBy ?? [];
  const measure = measureExpr(plan.measure, !!plan.filters?.items?.length);
  const value = plan.measure === "share" && dims.length
    ? `SUM(${measure}) * 1.0 / NULLIF(SUM(SUM(${measure})) OVER (), 0)`
    : measure;
  const keys = dims.length ? dims.map((d) => `${DIM_EXPR[d]} AS k${dims.indexOf(d)}`) : ["'total' AS k0"];
  const group = dims.length ? `GROUP BY ${dims.map((_, i) => i + 1).join(", ")}` : "";
  const having = dims.length && ["spend", "income", "fees", "share"].includes(plan.measure)
    ? `HAVING ${value} > 0`
    : dims.length && plan.measure === "net" ? `HAVING ${value} <> 0` : "";
  const order = plan.orderBy?.by === "key"
    ? `ORDER BY 1 ${plan.orderBy.dir === "asc" ? "ASC" : "DESC"}`
    : `ORDER BY 2 ${plan.orderBy?.dir === "asc" ? "ASC" : "DESC"}`;
  const limit = plan.limit ?? 50;
  const sql = `${CTE.replace("{where}", where.sql)}
SELECT ${keys.join(", ")}, ${value} AS v
  FROM ev ${group} ${having} ${order} LIMIT ${limit}`;
  return { sql, params: where.params };
}

export interface EvidenceRow {
  id: number; occurredAt: number; amount: number; direction: string; counterparty: string | null; label: string | null;
}

/** The exact transactions behind a plan, using the same filters as the answer. */
export function compileEvidence(plan: QueryPlan, now: number, limit = 200): { sql: string; params: (string | number)[]; countSql: string; range: ResolvedRange } {
  const range = resolveRange(plan.filters?.time, now);
  const where = buildWhere(plan, range);
  // Match the measure's own definition so "See N payments" cannot over-count debt repayments/draws.
  const scope = plan.measure === "spend" || plan.measure === "share" || plan.measure === "credit_share" || plan.measure === "credit_cost"
    ? " AND t.direction = 'out' AND COALESCE(t.flow_class, '') <> 'debt_repay'"
    : plan.measure === "income"
      ? " AND t.direction = 'in' AND COALESCE(t.flow_class, '') <> 'debt_draw'"
      : "";
  const scoped = where.sql + scope;
  const sql = `${CTE.replace("{where}", scoped)}
SELECT ev.id, ev.occurred_at AS occurredAt, ev.amount, ev.direction, ev.counterparty, ev.label
  FROM ev ORDER BY ev.occurred_at DESC, ev.id DESC LIMIT ${Math.max(1, Math.min(500, limit))}`;
  const countSql = `${CTE.replace("{where}", scoped)} SELECT COUNT(*) AS n FROM ev`;
  return { sql, params: where.params, countSql, range };
}

export function compilePlan(plan: QueryPlan, now: number): CompiledQuery {
  const range = resolveRange(plan.filters?.time, now);
  const main = selectSql(plan, range);
  let comparison: CompiledQuery["comparison"];
  if (plan.compare) {
    const cmp = resolveRange(plan.compare.to, now);
    const q = selectSql(plan, cmp);
    comparison = { sql: q.sql, params: q.params, range: { from: cmp.from, to: cmp.to, label: cmp.label } };
  }
  return { sql: main.sql, params: main.params, range, comparison, explain: describePlan(plan, range) };
}

/** Deterministic provenance sentence shown under every answer. */
export function describePlan(plan: QueryPlan, range: ResolvedRange): string {
  const dims = plan.groupBy?.map((d) => DIMENSION_LABELS[d]).join(" and ");
  const filters = plan.filters;
  const bits: string[] = [`${MEASURE_LABELS[plan.measure]}${dims ? ` by ${dims}` : ""}`, `for ${range.label}`];
  if (filters?.direction && filters.direction !== "any") bits.push(`${filters.direction === "out" ? "money out" : "money in"}`);
  if (filters?.labels?.length) bits.push(`category ${filters.labels.join(", ")}`);
  if (filters?.tags?.length) bits.push(`tag ${filters.tags.join(", ")}`);
  if (filters?.ventures?.length) bits.push(`venture ${filters.ventures.join(", ")}`);
  if (filters?.counterparties?.length) bits.push(`with ${filters.counterparties.join(", ")}`);
  if (filters?.items?.length) bits.push(`item ${filters.items.join(", ")}`);
  if (filters?.groups?.length) bits.push(`group ${filters.groups.join(", ")}`);
  if (filters?.habits?.length) bits.push(`habit ${filters.habits.join(", ")}`);
  if (filters?.funding) bits.push(`${filters.funding === "credit" ? "credit-funded" : filters.funding === "wallet" ? "wallet-funded" : "any funding"}`);
  if (filters?.hourWindow) bits.push(`between ${String(Math.floor(filters.hourWindow.startMin / 60)).padStart(2, "0")}:${String(filters.hourWindow.startMin % 60).padStart(2, "0")} and ${String(Math.floor(filters.hourWindow.endMin / 60)).padStart(2, "0")}:${String(filters.hourWindow.endMin % 60).padStart(2, "0")}`);
  if (filters?.weekdays?.length) bits.push(`on ${filters.weekdays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")}`);
  if (filters?.minAmountCents != null) bits.push(`amount >= ${formatKes(filters.minAmountCents)}`);
  if (filters?.maxAmountCents != null) bits.push(`amount <= ${formatKes(filters.maxAmountCents)}`);
  if (filters?.text) bits.push(`matching "${filters.text}"`);
  if (plan.compare) bits.push("compared with the previous period");
  return bits.join(" · ");
}
