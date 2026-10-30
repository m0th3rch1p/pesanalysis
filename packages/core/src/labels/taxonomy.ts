/**
 * Seed taxonomy (labels + roles) created on first run. Taxonomy is DATA: evolving, mergeable,
 * versioned by consolidation sessions (schema.ts). Users can create custom labels/roles any time.
 */
export interface SeedLabel { name: string; parent?: string }

export const SEED_LABELS: SeedLabel[] = [
  { name: "Income" },
  { name: "Expenses" },
  { name: "Personal" },
  { name: "Sales (business)", parent: "Income" },
  { name: "Salary", parent: "Income" },
  { name: "Transfer in", parent: "Income" },
  { name: "Other income", parent: "Income" },
  { name: "Business stock", parent: "Expenses" },
  { name: "Groceries", parent: "Expenses" },
  { name: "Eating out", parent: "Expenses" },
  { name: "Transport", parent: "Expenses" },
  { name: "Fuel", parent: "Transport" },
  { name: "Rent", parent: "Expenses" },
  { name: "Utilities", parent: "Expenses" },
  { name: "Airtime & data", parent: "Expenses" },
  { name: "Fees & charges", parent: "Expenses" },
  { name: "Family support", parent: "Personal" },
  { name: "Personal transfer", parent: "Personal" },
  { name: "Health", parent: "Expenses" },
  { name: "School fees", parent: "Expenses" },
  { name: "Entertainment", parent: "Expenses" },
  { name: "Shopping", parent: "Expenses" },
  { name: "Subscriptions", parent: "Expenses" },
  { name: "Pets", parent: "Expenses" },
  { name: "Savings & investment", parent: "Personal" },
  { name: "Debt repayment", parent: "Expenses" },
  { name: "Cash withdrawal", parent: "Expenses" },
  { name: "Transfer out", parent: "Expenses" },
  { name: "Off-radar transfer", parent: "Expenses" },
];

export const SEED_ROLES = ["customer", "supplier", "family", "friend", "staff", "landlord", "employer", "lender", "utility", "self"] as const;

/** Deterministic kind->label defaults (rule layer, weight high). */
export const KIND_DEFAULTS: Record<string, string> = {
  airtime: "Airtime & data",
  bundle: "Airtime & data",
  withdrawal_fee: "Fees & charges",
  withdraw: "Cash withdrawal",
  loan_repay: "Debt repayment",
  reversal: "Transfer in",
  bank_credit: "Transfer in",
  receive: "Transfer in",
};


/**
 * Counterparty classes for suggestion compatibility (WS0.3). A label learned from a
 * person must not be proposed for a shop, and airtime learned at a telco must not leak
 * onto bank paybills, aggregators, people or shops.
 */
export type KindClass = "telco" | "person" | "merchant" | "cash" | "loan" | "bank" | "fee" | "other";

export function kindClass(kind: string | null | undefined): KindClass {
  switch ((kind ?? "").toLowerCase()) {
    case "airtime": case "bundle": return "telco";
    case "send": case "receive": return "person";
    case "paybill": case "till": return "merchant";
    case "withdraw": return "cash";
    case "loan_draw": case "loan_repay": case "overdraft": return "loan";
    case "bank_credit": case "bank_debit": case "bank_transfer": return "bank";
    case "fee": case "withdrawal_fee": return "fee";
    default: return "other";
  }
}

/**
 * Labels each class may receive from kNN. `null` = no restriction (unknown/other kinds).
 * Income/expense direction is still enforced separately by the suggester.
 */
export const CLASS_LABELS: Record<KindClass, Set<string> | null> = {
  telco: new Set(["Airtime & data", "Fees & charges", "Debt repayment"]),
  person: new Set([
    "Personal transfer", "Family support", "Transfer out", "Transfer in", "Off-radar transfer",
    "Savings & investment", "Debt repayment", "Other income", "Salary", "Sales (business)",
  ]),
  merchant: new Set([
    "Business stock", "Groceries", "Eating out", "Transport", "Fuel", "Rent", "Utilities",
    "Health", "School fees", "Entertainment", "Shopping", "Subscriptions", "Pets",
    "Savings & investment", "Debt repayment", "Transfer out",
  ]),
  cash: new Set(["Cash withdrawal", "Fees & charges", "Debt repayment"]),
  loan: new Set(["Debt repayment", "Fees & charges"]),
  bank: new Set([
    "Transfer in", "Transfer out", "Salary", "Other income", "Sales (business)",
    "Savings & investment", "Debt repayment", "Family support", "Personal transfer", "Fees & charges",
  ]),
  fee: new Set(["Fees & charges"]),
  other: null,
};

export function labelAllowedForKind(kind: string | null | undefined, label: string): boolean {
  const allowed = CLASS_LABELS[kindClass(kind)];
  return allowed == null || allowed.has(label);
}
