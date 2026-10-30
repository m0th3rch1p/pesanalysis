/**
 * Deterministic analyst prose. Every number here comes from executed SQL; the model (if any)
 * may only rephrase it behind the narrator's number-preservation check. This is what makes the
 * demo honest and keeps working when the phone cannot run a larger model.
 */
import { formatKes } from "../sms/money.js";
import { MEASURE_LABELS, type Measure } from "./semantic.js";
import type { QueryPlan } from "./plan.js";
import type { ResolvedRange } from "./plan.js";

export interface PlanRow { k0: string; v: number; [key: string]: string | number }

export interface AnswerBundle {
  headline: string;
  bullets: string[];
  detail: string[];
  numbersVerified: true;
  empty: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function money(measure: Measure, v: number): string {
  if (measure === "count") return `${Math.round(v)}`;
  if (measure === "share") return `${(v * 100).toFixed(v * 100 >= 10 ? 0 : 1)}%`;
  return formatKes(Math.round(v));
}

function unit(measure: Measure): string {
  if (measure === "count") return "payments";
  if (measure === "share") return "of spending";
  if (measure === "fees") return "in fees";
  return "";
}

export function composeAnswer(plan: QueryPlan, rows: PlanRow[], comparisonRows: PlanRow[] | null, range: ResolvedRange): AnswerBundle {
  const total = rows.reduce((s, r) => s + Number(r.v ?? 0), 0);
  const empty = rows.length === 0 || (rows.length === 1 && total === 0);
  const measureLabel = MEASURE_LABELS[plan.measure];
  const grouped = !!plan.groupBy?.length && !(rows.length === 1 && String(rows[0]!.k0) === "total");

  if (empty) {
    return {
      headline: `I found nothing for ${measureLabel} ${range.label}.`,
      bullets: [],
      detail: [`Query: ${range.label}. Try a wider period or a different category.`],
      numbersVerified: true,
      empty: true,
    };
  }

  const headline = grouped
    ? `${capitalize(measureLabel)} ${range.label}: ${money(plan.measure, total)} across ${plural(rows.length, "group")}.`
    : plan.measure === "count"
      ? `You made ${Math.round(total)} payments ${range.label}.`
      : plan.measure === "avg"
        ? `Your average payment ${range.label} was ${formatKes(Math.round(total))}.`
        : plan.measure === "max"
          ? `Your largest payment ${range.label} was ${formatKes(Math.round(total))}.`
          : plan.measure === "net"
            ? `Money in minus money out ${range.label} was ${formatKes(Math.round(total))}.`
            : plan.measure === "share"
              ? `That group is ${money("share", total)} of spending ${range.label}.`
              : `${capitalize(measureLabel)} ${range.label}: ${money(plan.measure, total)}${unit(plan.measure) ? ` ${unit(plan.measure)}` : ""}.`;

  const bullets: string[] = [];
  if (grouped) {
    const denom = rows.reduce((s, r) => s + Math.abs(Number(r.v ?? 0)), 0) || 1;
    for (const r of rows.slice(0, 5)) {
      const v = Number(r.v ?? 0);
      if (plan.measure === "share") bullets.push(`${r.k0}: ${money("share", v)}`);
      else bullets.push(`${r.k0}: ${money(plan.measure, v)} (${Math.round((Math.abs(v) / denom) * 100)}%)`);
    }
    if (rows.length > 5) bullets.push(`…and ${rows.length - 5} more.`);
  }

  const detail: string[] = [];
  if (comparisonRows) {
    const prev = comparisonRows.reduce((s, r) => s + Number(r.v ?? 0), 0);
    if (prev !== 0 && total !== 0) {
      const pct = ((total - prev) / Math.abs(prev)) * 100;
      const dir = pct >= 0 ? "more" : "less";
      detail.push(`That is ${Math.abs(pct).toFixed(pct === 0 ? 0 : 1)}% ${dir} than ${range.previous.label} (${money(plan.measure, prev)}).`);
    } else if (prev === 0 && total !== 0) {
      detail.push(`There was nothing recorded in ${range.previous.label}.`);
    }
  }
  if (plan.filters?.labels?.length) detail.push(`Filter: ${plan.filters.labels.join(", ")}.`);
  if (plan.filters?.tags?.length) detail.push(`Tag: ${plan.filters.tags.join(", ")}.`);
  detail.push(`Computed from ${plural(rows.length, "result row")} over ${range.label}.`);

  return { headline, bullets, detail, numbersVerified: true, empty: false };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Summary answer used by "how am I doing" (runs three plans, one prose block). */
export function composeSummary(parts: {
  range: ResolvedRange;
  spend: number; income: number; fees: number; count: number; previousSpend: number; top?: Array<{ k0: string; v: number }>;
}): AnswerBundle {
  const net = parts.income - parts.spend;
  const bullets: string[] = [];
  if (parts.top?.length) for (const t of parts.top.slice(0, 3)) bullets.push(`${t.k0}: ${formatKes(t.v)}`);
  const detail: string[] = [];
  if (parts.previousSpend > 0) {
    const pct = ((parts.spend - parts.previousSpend) / parts.previousSpend) * 100;
    detail.push(`Spending is ${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? "higher" : "lower"} than ${parts.range.previous.label}.`);
  }
  detail.push(`Fees: ${formatKes(parts.fees)}. ${parts.count === 1 ? "1 payment" : `${parts.count} payments`}.`);
  const top = parts.top?.[0];
  if (top && top.k0 === "Unlabelled" && top.v > 0) {
    detail.push(`${formatKes(top.v)} of this spending is still unlabelled. Naming a few payments will sharpen every category chart.`);
  }
  return {
    headline: `${capitalize(parts.range.label)}: in ${formatKes(parts.income)}, out ${formatKes(parts.spend)}, net ${formatKes(net)}.`,
    bullets,
    detail,
    numbersVerified: true,
    empty: parts.count === 0,
  };
}
