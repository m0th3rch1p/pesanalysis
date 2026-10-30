import type { Cents } from "../types.js";

/** Rails the engine can price. */
export type TariffKind =
  | "send"               // M-Pesa to a registered M-Pesa (or other-network) user
  | "send_unregistered"  // M-Pesa to an unregistered number (voucher)
  | "withdraw_agent"
  | "withdraw_atm"
  | "pochi_send"         // Pay to Pochi la Biashara
  | "paybill"            // customer-side charge when paying a paybill
  | "till";              // customer-side charge when paying a Buy Goods till

/** Integer-KES inclusive band. An amount of KES 100.50 is looked up as KES 100. */
export interface TariffBand { minKes: number; maxKes: number; feeKes: number }

export type Confidence =
  | "verified"   // read from an official Safaricom page on `retrievedAt`
  | "assumed";   // not published on the page we could fetch; documented assumption

export type TariffTable =
  | { type: "bands"; bands: TariffBand[]; confidence: Confidence; notes?: string }
  | { type: "flat"; feeKes: number; confidence: Confidence; notes?: string }
  /** The provider does not publish a customer-side figure we could verify. expectedFee returns null. */
  | { type: "unpublished"; notes: string };

/** One dated, sourced snapshot. Pure data: no logic lives in these files. */
export interface TariffVersion {
  id: string;
  /** First EAT calendar day (YYYY-MM-DD) the tables apply. */
  effectiveFrom: string;
  /** Exclusive EAT calendar day the tables stop applying (promos). */
  effectiveTo?: string;
  /** True when `effectiveFrom` is the page's last-updated date, not a proven change date: earlier dates reuse this snapshot, flagged. */
  extrapolateBackward?: boolean;
  sourceUrls: string[];
  /** YYYY-MM-DD the pages were read. */
  retrievedAt: string;
  notes?: string;
  tables: Partial<Record<TariffKind, TariffTable>>;
}

export interface FulizaBand {
  minKes: number; maxKes: number;
  /** Daily maintenance fee before duty. */
  baseFeeKes: number;
  /** 20% excise duty on the base fee. */
  dutyKes: number;
  /** Total charged per day (base + duty). */
  totalFeeKes: number;
  /** Days (counted from the free-window clock start) during which this band is not charged. 0 = never free. */
  freeDays: number;
}

export interface FulizaVersion {
  id: string;
  effectiveFrom: string;
  effectiveTo?: string;
  sourceUrls: string[];
  retrievedAt: string;
  /** One-off access fee as a fraction of each draw (0.01 = 1%). */
  accessFeeRate: number;
  bands: FulizaBand[];
  notes?: string;
  /** What is NOT verified from a primary source; surfaced to callers. */
  unverified: string[];
}

export type DateInput = number | string; // epoch ms, or YYYY-MM-DD / ISO string (EAT calendar day)

export interface FeeQuote {
  kind: TariffKind;
  amountCents: Cents;
  feeCents: Cents;
  tariffVersion: string;
  confidence: Confidence;
  /** True when the snapshot is applied to a date before its proven effective_from. */
  extrapolated: boolean;
  /** Always true: a table-derived fee is a model, a stated `Transaction cost` is ground truth. */
  estimated: true;
}

/**
 * Open modelling question (docs/plan/06 F-TARIFF): is the 3-day free window measured
 *  - "per_episode": from the first draw of an overdrawn episode (outstanding went 0 -> >0), or
 *  - "per_draw":    restarted by every new draw?
 * UNVERIFIED. The 28 Sep 2022 release only says customers borrowing KES 1,000 and below
 * get the first 3 days free. Default is "per_episode" because it never under-states cost.
 */
export type FulizaClockModel = "per_episode" | "per_draw";
