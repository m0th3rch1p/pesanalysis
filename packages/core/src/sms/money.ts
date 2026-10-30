import type { Cents } from "../types.js";

/** "Ksh1,234.50" | "KES 1,234.50" | "1,234" | "-500.00" (Fuliza debt) -> 123450 | -50000 */
export function parseKes(s: string): Cents {
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (!/[\d]/.test(cleaned)) throw new Error(`parseKes: no digits in "${s}"`);
  const [whole = "0", frac = ""] = cleaned.replace(/-/g, "").split(".");
  const cents = (frac + "00").slice(0, 2);
  const mag = parseInt(whole, 10) * 100 + parseInt(cents, 10);
  return cleaned.includes("-") ? -mag : mag;
}

export function formatKes(c: Cents): string {
  const neg = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg}Ksh${whole}.${(abs % 100).toString().padStart(2, "0")}`;
}
