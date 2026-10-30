/** Obligations auto-created from lender due-date notices (Fuliza, Okoa, Kopa, other lenders). Pure builders. */
import { type DayStr, dayOf, mkDay, parseDay } from "./eat.js";
import type { NewFlow } from "./store.js";

export type DueNoticeKind = "fuliza" | "okoa" | "kopa" | "lender";

export interface DueNotice {
  kind: DueNoticeKind;
  /** EAT date the lender states the debt is due. Give either dueOn or dueAt (epoch ms). */
  dueOn?: DayStr;
  dueAt?: number;
  /** total owed, integer cents */
  outstandingCents: number;
  /** lender name for kind "lender" */
  lender?: string;
}

/** Accepts dd/mm/yy, dd/mm/yyyy, dd-mm-yy, dd-mm-yyyy and yyyy-mm-dd. Two-digit years are 20yy. Null if invalid. */
export function parseDueDate(s: string): DayStr | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else {
    r = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(t);
    if (!r) return null;
    d = +r[1]!; m = +r[2]!; y = r[3]!.length === 2 ? 2000 + +r[3]! : +r[3]!;
  }
  const day = mkDay(y, m, d);
  try { parseDay(day); } catch { return null; }
  return day;
}

const LABEL: Record<DueNoticeKind, { name: string; hint: string }> = {
  fuliza: { name: "Fuliza repayment", hint: "fuliza" },
  okoa: { name: "Okoa Jahazi repayment", hint: "okoa" },
  kopa: { name: "Airtel Kopa repayment", hint: "kopa" },
  lender: { name: "Loan repayment", hint: "" },
};

/**
 * A once-off obligation flow (source "sms", status "suggested": the user confirms or dismisses).
 * Partial repayments accumulate against the stated outstanding amount. Lenders charge from the due date,
 * so grace is 0 days. The dedupe key is kind + due date (+ lender), so a repeated notice never duplicates it.
 */
export function obligationFromNotice(n: DueNotice): NewFlow | null {
  const dueOn = n.dueOn ?? (n.dueAt != null ? dayOf(n.dueAt) : null);
  if (!dueOn || !(n.outstandingCents > 0)) return null;
  const l = LABEL[n.kind];
  const lender = n.kind === "lender" ? (n.lender ?? "lender").trim() : "";
  return {
    direction: "out",
    name: n.kind === "lender" && lender ? `${lender} repayment` : l.name,
    counterpartyHint: n.kind === "lender" ? lender || null : l.hint,
    amountMinCents: n.outstandingCents, amountTypCents: n.outstandingCents, amountMaxCents: n.outstandingCents,
    cadence: "once", anchorOn: dueOn,
    holidayPolicy: "none", graceDays: 0, missedAfterDays: 14, earlyDays: 30,
    source: "sms", sourceRef: `${n.kind}:${lender.toLowerCase()}:${dueOn}`, status: "suggested",
  };
}
