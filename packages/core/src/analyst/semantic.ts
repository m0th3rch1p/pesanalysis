/**
 * Semantic layer vocabulary (D38). SCAFFOLD-grade before; now the closed contract.
 * Anything outside these sets is rejected by the validator before any SQL is built.
 */
export const MEASURES = ["spend", "income", "net", "fees", "count", "avg", "max", "share", "credit_share", "credit_cost", "count_items"] as const;
export const DIMENSIONS = ["label", "counterparty", "role", "tag", "venture", "kind", "provider", "scope", "hour", "weekday", "day", "week", "month", "place", "item", "item_group", "habit", "funding"] as const;
export const DIRECTIONS = ["in", "out", "any"] as const;
export const ORDERS = ["asc", "desc"] as const;
export const BUCKETS = ["day", "week", "month"] as const;
export const TIME_NAMES = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year"] as const;
export const TIME_UNITS = ["day", "week", "month", "year"] as const;
export const MAX_LIMIT = 100;
export const MAX_GROUP_BY = 2;

export type Measure = (typeof MEASURES)[number];
export type Dimension = (typeof DIMENSIONS)[number];
export type PlanDirection = (typeof DIRECTIONS)[number];
export type TimeBucket = (typeof BUCKETS)[number];
export type TimeName = (typeof TIME_NAMES)[number];
export type TimeUnit = (typeof TIME_UNITS)[number];

/** Relative or absolute time range, all in EAT. */
export type TimeRange =
  | { kind: "absolute"; fromMs: number; toMs: number }
  | { kind: "relative"; unit: TimeUnit; n: number; offset?: number }
  | { kind: "named"; name: TimeName };

/** Human labels for the provenance chip. */
export const MEASURE_LABELS: Record<Measure, string> = {
  spend: "spent", income: "received", net: "net movement", fees: "fees paid",
  count: "payments", avg: "average payment", max: "largest payment", share: "share",
  credit_share: "credit-funded share", credit_cost: "credit cost", count_items: "items",
};
export const DIMENSION_LABELS: Record<Dimension, string> = {
  label: "category", counterparty: "merchant/person", role: "role", tag: "tag", venture: "venture",
  kind: "payment type", provider: "provider", scope: "personal/business", hour: "hour", weekday: "weekday",
  day: "day", week: "week", month: "month", place: "place",
  item: "item", item_group: "item group", habit: "habit", funding: "wallet/credit",
};
