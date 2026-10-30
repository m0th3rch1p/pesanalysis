/**
 * G1: scope was never set, so scope_mix could never fire. Infer a first guess from the label and
 * the counterparty role; the user can override it and a venture tag later upgrades it to business.
 * Pure and conservative: "unknown" beats a confident wrong answer.
 */
export type TxScope = "personal" | "business" | "mixed" | "unknown";

const BUSINESS_LABELS = new Set(["Sales (business)", "Business stock", "Business income"]);
const PERSONAL_LABELS = new Set(["Family support", "Personal transfer", "Savings & investment"]);
const BUSINESS_ROLES = new Set(["customer", "supplier", "staff", "employer", "self"]);
const PERSONAL_ROLES = new Set(["family", "friend"]);

export function inferScope(input: { label?: string | null; role?: string | null; kind?: string | null }): TxScope {
  let business = false;
  let personal = false;
  if (input.label && BUSINESS_LABELS.has(input.label)) business = true;
  if (input.label && PERSONAL_LABELS.has(input.label)) personal = true;
  if (input.role && BUSINESS_ROLES.has(input.role)) business = true;
  if (input.role && PERSONAL_ROLES.has(input.role)) personal = true;
  if (business && personal) return "mixed";
  if (business) return "business";
  if (personal) return "personal";
  return "unknown";
}
