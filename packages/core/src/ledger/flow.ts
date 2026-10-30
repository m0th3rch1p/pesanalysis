/**
 * Money model (NET_DEFINITION_V1). One definition of "income", "spend", "fees" and "net"
 * for every screen, detector and answer. See docs/plan/06-feature-specs.md F-MONEY.
 *
 * Every canonical transaction carries a `flow_class`. Debt principal and money moved
 * between the user's own accounts are NOT income or spending.
 */
import type { DbAdapter } from "../db/migrate.js";
import { railForPaybill } from "../sms/rails-directory.js";

export const NET_DEFINITION_V1 = "v1";

export type FlowClass =
  | "income"        // money earned or received from others
  | "spend"         // money paid to others (goods, bills, P2P)
  | "fee"           // standalone charges (Fuliza access/daily fees, bank charges)
  | "cash_in"       // agent deposit: cash converted to wallet money
  | "cash_out"      // agent withdrawal: wallet money converted to cash
  | "transfer_own"  // movement between the user's own accounts (savings, pots, vaults)
  | "debt_draw"     // loan principal received (Fuliza, Okoa, lenders)
  | "debt_repay"    // loan principal repaid
  | "reversal"      // provider reversal of an earlier movement
  | "neutral";      // informational rows with no money movement

export const FLOW_CLASSES: readonly FlowClass[] = [
  "income", "spend", "fee", "cash_in", "cash_out", "transfer_own", "debt_draw", "debt_repay", "reversal", "neutral",
];

export interface FlowInput {
  kind: string;
  direction: string;
  template?: string | null;
  counterpartyId?: string | null;
  account?: string | null;
  counterpartyName?: string | null;
}

const OWN_ACCOUNT_TEXT = /m-?shwari|ziidi|\bmmf\b|money market|lock savings|kcb m-?pesa|mpesa pot|m-?pesa pot|savings pot/i;

/** True when the destination is the user's own savings or vault rail (not a bill, not a person). */
export function isOwnAccountDestination(i: FlowInput): boolean {
  const rail = railForPaybill(i.counterpartyId);
  if (rail && (rail.kind === "savings" || rail.kind === "vault")) return true;
  const text = `${i.counterpartyName ?? ""} ${i.account ?? ""} ${i.counterpartyId ?? ""} ${i.template ?? ""}`;
  return OWN_ACCOUNT_TEXT.test(text);
}

/** Deterministic classification. Order matters: the first matching rule wins. */
export function classifyFlow(i: FlowInput): FlowClass {
  switch (i.kind) {
    case "loan_draw": return "debt_draw";
    case "loan_repay": return "debt_repay";
    case "fee": return "fee";
    case "reversal": return "reversal";
    case "deposit": return "cash_in";
    case "withdraw": return "cash_out";
    default: break;
  }
  if (i.direction === "neutral") return "neutral";
  if (isOwnAccountDestination(i)) return "transfer_own";
  return i.direction === "in" ? "income" : "spend";
}

export interface MoneyTotals {
  income: number; spend: number; fees: number;
  cashIn: number; cashOut: number;
  transferIn: number; transferOut: number;
  debtDraw: number; debtRepay: number;
  reversalIn: number; reversalOut: number;
  /** NET_DEFINITION_V1: income + cashIn + reversalIn + transferIn - spend - cashOut - reversalOut - transferOut - fees. Debt principal is excluded; transfers count (to an untracked account they are money out). */
  net: number;
  /** Net before fees. */
  netBeforeFees: number;
  /** Money that left the tracked wallet for any reason (all out-direction amounts). */
  grossOut: number;
  grossIn: number;
  count: number;
}

export function netOf(t: Omit<MoneyTotals, "net" | "netBeforeFees" | "grossOut" | "grossIn" | "count">): { net: number; netBeforeFees: number } {
  const netBeforeFees = t.income + t.cashIn + t.reversalIn + t.transferIn - t.spend - t.cashOut - t.reversalOut - t.transferOut;
  return { net: netBeforeFees - t.fees, netBeforeFees };
}

/** SQL select list shared by every aggregate. `a` is an optional table alias (e.g. "t"). */
export function flowSelectSql(a = ""): string {
  const c = (n: string) => (a ? `${a}.${n}` : n);
  const s = (cond: string) => `COALESCE(SUM(CASE WHEN ${cond} THEN ${c("amount")} ELSE 0 END), 0)`;
  return [
    `${s(`${c("flow_class")} = 'income'`)} AS income`,
    `${s(`${c("flow_class")} = 'spend'`)} AS spend`,
    `COALESCE(SUM(CASE WHEN ${c("flow_class")} = 'fee' THEN ${c("amount")} ELSE COALESCE(${c("fee")}, 0) END), 0) AS fees`,
    `${s(`${c("flow_class")} = 'cash_in'`)} AS cashIn`,
    `${s(`${c("flow_class")} = 'cash_out'`)} AS cashOut`,
    `${s(`${c("flow_class")} = 'transfer_own' AND ${c("direction")} = 'in'`)} AS transferIn`,
    `${s(`${c("flow_class")} = 'transfer_own' AND ${c("direction")} = 'out'`)} AS transferOut`,
    `${s(`${c("flow_class")} = 'debt_draw'`)} AS debtDraw`,
    `${s(`${c("flow_class")} = 'debt_repay'`)} AS debtRepay`,
    `${s(`${c("flow_class")} = 'reversal' AND ${c("direction")} = 'in'`)} AS reversalIn`,
    `${s(`${c("flow_class")} = 'reversal' AND ${c("direction")} = 'out'`)} AS reversalOut`,
    `${s(`${c("direction")} = 'out'`)} AS grossOut`,
    `${s(`${c("direction")} = 'in'`)} AS grossIn`,
    `COUNT(*) AS count`,
  ].join(", ");
}

function toTotals(r: Record<string, unknown> | null | undefined): MoneyTotals {
  const n = (k: string) => Number(r?.[k] ?? 0);
  const base = {
    income: n("income"), spend: n("spend"), fees: n("fees"),
    cashIn: n("cashIn"), cashOut: n("cashOut"),
    transferIn: n("transferIn"), transferOut: n("transferOut"),
    debtDraw: n("debtDraw"), debtRepay: n("debtRepay"),
    reversalIn: n("reversalIn"), reversalOut: n("reversalOut"),
  };
  return { ...base, ...netOf(base), grossOut: n("grossOut"), grossIn: n("grossIn"), count: n("count") };
}

/** Totals over canonical events in [from, to). `where`/`params` narrow further (must use column names of tx_events). */
export function moneyTotals(db: DbAdapter, from: number, to: number, where = "", params: unknown[] = []): MoneyTotals {
  const row = db.get(
    `SELECT ${flowSelectSql()} FROM tx_events WHERE occurred_at >= ? AND occurred_at < ? ${where ? `AND (${where})` : ""}`,
    [from, to, ...params],
  );
  return toTotals(row);
}

/** In-memory equivalent for detectors operating on arrays (kept in lock-step by test/flow.test.ts). */
export function moneyTotalsOf(rows: Array<{ flowClass: FlowClass; direction: string; amount: number; fee?: number | null }>): MoneyTotals {
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + r.amount, 0);
  const base = {
    income: sum((r) => r.flowClass === "income"),
    spend: sum((r) => r.flowClass === "spend"),
    fees: rows.reduce((a, r) => a + (r.flowClass === "fee" ? r.amount : (r.fee ?? 0)), 0),
    cashIn: sum((r) => r.flowClass === "cash_in"),
    cashOut: sum((r) => r.flowClass === "cash_out"),
    transferIn: sum((r) => r.flowClass === "transfer_own" && r.direction === "in"),
    transferOut: sum((r) => r.flowClass === "transfer_own" && r.direction === "out"),
    debtDraw: sum((r) => r.flowClass === "debt_draw"),
    debtRepay: sum((r) => r.flowClass === "debt_repay"),
    reversalIn: sum((r) => r.flowClass === "reversal" && r.direction === "in"),
    reversalOut: sum((r) => r.flowClass === "reversal" && r.direction === "out"),
  };
  return {
    ...base, ...netOf(base),
    grossOut: sum((r) => r.direction === "out"), grossIn: sum((r) => r.direction === "in"), count: rows.length,
  };
}

/** Backfill rows that predate v7 or were written without a class. Idempotent. */
export function backfillFlowClass(db: DbAdapter): number {
  const hasCp = !!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'counterparties'`);
  const rows = db.all(
    `SELECT t.id, t.kind, t.direction, t.template, t.account,
            ${hasCp ? "(SELECT c.raw_names FROM counterparties c WHERE c.id = t.counterparty_id)" : "NULL"} AS names
       FROM transactions t WHERE t.flow_class IS NULL`,
  );
  let n = 0;
  for (const r of rows) {
    let name: string | null = null;
    try { const a = JSON.parse(String(r.names ?? "[]")); name = Array.isArray(a) ? a.join(" ") : null; } catch { name = null; }
    const cls = classifyFlow({
      kind: String(r.kind), direction: String(r.direction), template: r.template as string | null,
      account: r.account as string | null, counterpartyName: name,
    });
    db.run(`UPDATE transactions SET flow_class = ? WHERE id = ?`, [cls, r.id]);
    n++;
  }
  return n;
}
