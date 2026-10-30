/**
 * Canonical Kenyan rail directory. Paybill/till/sender identity, not user data.
 * Visibility: full (we see the wallet), partial (bank alerts), opaque (paybill-only).
 */
export type RailKind = "wallet" | "bank" | "card" | "credit" | "savings" | "sacco" | "utility_meter" | "vault" | "paybill" | "till";
export interface RailDescriptor {
  provider: string;
  kind: RailKind;
  displayName: string;
  visibility: "full" | "partial" | "opaque";
  paybillOrTill?: string;
  senderPatterns?: RegExp[];
}

const rail = (
  provider: string, kind: RailKind, displayName: string, visibility: RailDescriptor["visibility"],
  paybillOrTill?: string, senderPatterns?: RegExp[],
): RailDescriptor => ({ provider, kind, displayName, visibility, paybillOrTill, senderPatterns });

const PAYBILLS: Record<string, RailDescriptor> = {
  "247247": rail("equity", "bank", "Equity Bank", "partial", "247247"),
  "522522": rail("kcb", "bank", "KCB Bank", "partial", "522522"),
  "400200": rail("coop", "bank", "Co-operative Bank", "partial", "400200"),
  "880100": rail("ncba", "bank", "NCBA Bank", "partial", "880100"),
  "714777": rail("loop", "bank", "Loop / NCBA", "partial", "714777"),
  "303030": rail("absa", "bank", "Absa Kenya", "partial", "303030"),
  "542542": rail("im", "bank", "I&M Bank", "partial", "542542"),
  "600100": rail("stanbic", "bank", "Stanbic Bank", "partial", "600100"),
  "516600": rail("dtb", "bank", "DTB Kenya", "partial", "516600"),
  "222111": rail("family", "bank", "Family Bank", "partial", "222111"),
  "888880": rail("kplc", "utility_meter", "KPLC Prepaid", "opaque", "888880"),
  "888888": rail("kplc", "utility_meter", "KPLC Postpaid", "opaque", "888888"),
  "320320": rail("zuku", "utility_meter", "Zuku", "opaque", "320320"),
  "222222": rail("ecitizen", "paybill", "eCitizen", "opaque", "222222"),
  "555555": rail("mshwari", "savings", "M-Shwari", "opaque", "555555"),
  "999999": rail("ziidi", "savings", "Ziidi MMF", "opaque", "999999"),
};

export const BANK_SENDERS: Array<{ re: RegExp; descriptor: RailDescriptor }> = [
  { re: /^kcb/i, descriptor: rail("kcb", "bank", "KCB Bank", "partial", undefined, [/^kcb/i]) },
  { re: /^(co-?op|cooperative|co-operative)/i, descriptor: rail("coop", "bank", "Co-operative Bank", "partial", undefined, [/^(co-?op|cooperative|co-operative)/i]) },
  { re: /^(ncba|loop)/i, descriptor: rail("ncba", "bank", "NCBA Bank", "partial", undefined, [/^(ncba|loop)/i]) },
  { re: /^i&?m/i, descriptor: rail("im", "bank", "I&M Bank", "partial", undefined, [/^i&?m/i]) },
  { re: /^absa/i, descriptor: rail("absa", "bank", "Absa Kenya", "partial", undefined, [/^absa/i]) },
  { re: /^stanbic/i, descriptor: rail("stanbic", "bank", "Stanbic Bank", "partial", undefined, [/^stanbic/i]) },
  { re: /^dtb/i, descriptor: rail("dtb", "bank", "DTB Kenya", "partial", undefined, [/^dtb/i]) },
  { re: /^family ?bank/i, descriptor: rail("family", "bank", "Family Bank", "partial", undefined, [/^family ?bank/i]) },
  { re: /^m-?shwari/i, descriptor: rail("mshwari", "savings", "M-Shwari", "opaque", undefined, [/^m-?shwari/i]) },
  { re: /^ziidi/i, descriptor: rail("ziidi", "savings", "Ziidi MMF", "opaque", undefined, [/^ziidi/i]) },
  { re: /^kplc|kenya power/i, descriptor: rail("kplc", "utility_meter", "KPLC", "opaque", undefined, [/^kplc|kenya power/i]) },
  { re: /^equity/i, descriptor: rail("equity", "bank", "Equity Bank", "partial", undefined, [/^equity/i]) },
];

export function railForPaybill(id: string | null | undefined): RailDescriptor | null {
  if (!id) return null;
  return PAYBILLS[id.replace(/\D/g, "")] ?? null;
}

export function railForSender(sender: string | null | undefined): RailDescriptor | null {
  if (!sender) return null;
  for (const b of BANK_SENDERS) if (b.re.test(sender)) return b.descriptor;
  return null;
}

export function isVisibleWallet(provider: string): boolean {
  return provider === "mpesa" || provider === "airtel_money" || provider === "telco";
}

/** Money leaving a visible wallet for a bank/sacco/vault/meter we cannot see through. */
export function isOffRadarDestination(parsed: { kind: string; counterpartyId?: string | null; account?: string | null }): boolean {
  if (!["paybill", "send", "bank_debit", "till"].includes(parsed.kind)) return false;
  const byPaybill = railForPaybill(parsed.counterpartyId);
  if (byPaybill && byPaybill.visibility !== "full") return true;
  const text = `${parsed.counterpartyId ?? ""} ${parsed.account ?? ""}`.toLowerCase();
  return /sacco|savings|vault|mmf|ziidi|m-?shwari|bank/.test(text);
}
