import type { TariffVersion } from "../types.js";

/**
 * Pay to Pochi la Biashara. The official page labels this table "(For 3 Months from 1st August 2026)":
 * a promotion. The end date below (exclusive 2026-11-01) is INFERRED from that wording, not stated.
 * The page's band edges overlap at 1,500 and 2,500; the lower band is used for the edge value.
 * No verified Pochi table exists for other dates, so expectedFee returns null outside the window.
 * Source page last updated 2026-08-04, read 2026-10-29. Data only.
 */
export const KE_POCHI_PROMO_2026_08_01: TariffVersion = {
  id: "ke-pochi-promo-2026-08-01",
  effectiveFrom: "2026-08-01",
  effectiveTo: "2026-11-01",
  sourceUrls: ["https://www.safaricom.co.ke/personal/m-pesa/getting-started/m-pesa-rates"],
  retrievedAt: "2026-10-29",
  notes: "Promotional tariff; effectiveTo inferred.",
  tables: {
    pochi_send: {
      type: "bands", confidence: "verified",
      bands: [
        // page rows: 0-50: 0; 50-100: 0; 101-200: 0 (merged)
        { minKes: 0, maxKes: 200, feeKes: 0 },
        { minKes: 201, maxKes: 500, feeKes: 7 },
        { minKes: 501, maxKes: 1000, feeKes: 13 },
        { minKes: 1001, maxKes: 1500, feeKes: 23 },
        { minKes: 1501, maxKes: 2500, feeKes: 33 },
        { minKes: 2501, maxKes: 250000, feeKes: 50 },
      ],
    },
  },
};
