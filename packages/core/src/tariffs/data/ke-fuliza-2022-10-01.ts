import type { FulizaVersion } from "../types.js";

/**
 * Fuliza M-PESA charges. Band table and the 1% access fee: read from the official Fuliza page
 * (page "Last Updated: June 23, 2025") on 2026-10-29. The page does NOT mention the free-window rule;
 * that rule comes from the Safaricom/NCBA/KCB release of 28 Sep 2022 (effective 1 Oct 2022), which we
 * could not fetch from a primary source (only secondary summaries). Data only.
 */
export const KE_FULIZA_2022_10_01: FulizaVersion = {
  id: "ke-fuliza-2022-10-01",
  effectiveFrom: "2022-10-01",
  sourceUrls: [
    "https://www.safaricom.co.ke/main-mpesa/m-pesa-services/credit-and-savings/fuliza",
    "Safaricom/NCBA/KCB joint release, 2022-09-28 (not fetched from a primary URL)",
  ],
  retrievedAt: "2026-10-29",
  accessFeeRate: 0.01,
  bands: [
    { minKes: 0, maxKes: 100, baseFeeKes: 0, dutyKes: 0, totalFeeKes: 0, freeDays: 0 },
    { minKes: 101, maxKes: 500, baseFeeKes: 2.5, dutyKes: 0.5, totalFeeKes: 3, freeDays: 3 },
    { minKes: 501, maxKes: 1000, baseFeeKes: 5, dutyKes: 1, totalFeeKes: 6, freeDays: 3 },
    { minKes: 1001, maxKes: 1500, baseFeeKes: 18, dutyKes: 3.6, totalFeeKes: 21.6, freeDays: 0 },
    { minKes: 1501, maxKes: 2500, baseFeeKes: 20, dutyKes: 4, totalFeeKes: 24, freeDays: 0 },
    { minKes: 2501, maxKes: 70000, baseFeeKes: 25, dutyKes: 5, totalFeeKes: 30, freeDays: 0 },
  ],
  notes: "Daily fee is charged at 00:00 on the OUTSTANDING amount. Daily fees never appear in SMS.",
  unverified: [
    "3-day free window is not on the current Fuliza page; sourced from the 2022 release via secondary summaries.",
    "Whether the 3-day clock is per draw or per overdrawn episode is unknown (see FulizaClockModel).",
    "Whether the access fee is added to the outstanding amount before banding (assumed yes, matches stated 'Total outstanding').",
  ],
};
