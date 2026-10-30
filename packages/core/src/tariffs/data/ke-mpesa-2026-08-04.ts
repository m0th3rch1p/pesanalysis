import type { TariffVersion } from "../types.js";

/**
 * Safaricom consumer M-PESA tariffs, as read from the official page on 2026-10-29.
 * The page shows "Published: August 16, 2022 | Last Updated: August 4, 2026". The Last Updated date is
 * NOT a proven change date, so this snapshot is also applied (flagged `extrapolated`) to earlier dates.
 * Figures are customer charges in KES. Data only.
 */
export const KE_MPESA_2026_08_04: TariffVersion = {
  id: "ke-mpesa-2026-08-04",
  effectiveFrom: "2026-08-04",
  extrapolateBackward: true,
  sourceUrls: ["https://www.safaricom.co.ke/personal/m-pesa/getting-started/m-pesa-rates"],
  retrievedAt: "2026-10-29",
  notes:
    "Page title 'M-PESA Charges' under M-PESA > M-PESA For You > Tariffs & Limits > Consumer Tariffs & Limits. " +
    "Transfer-to-M-PESA and transfer-to-other-network columns are identical.",
  tables: {
    send: {
      type: "bands", confidence: "verified",
      bands: [
        { minKes: 1, maxKes: 49, feeKes: 0 },
        { minKes: 50, maxKes: 100, feeKes: 0 },
        { minKes: 101, maxKes: 500, feeKes: 7 },
        { minKes: 501, maxKes: 1000, feeKes: 13 },
        { minKes: 1001, maxKes: 1500, feeKes: 23 },
        { minKes: 1501, maxKes: 2500, feeKes: 33 },
        { minKes: 2501, maxKes: 3500, feeKes: 53 },
        { minKes: 3501, maxKes: 5000, feeKes: 57 },
        { minKes: 5001, maxKes: 7500, feeKes: 78 },
        { minKes: 7501, maxKes: 10000, feeKes: 90 },
        { minKes: 10001, maxKes: 15000, feeKes: 100 },
        { minKes: 15001, maxKes: 20000, feeKes: 105 },
        { minKes: 20001, maxKes: 35000, feeKes: 108 },
        { minKes: 35001, maxKes: 50000, feeKes: 108 },
        { minKes: 50001, maxKes: 250000, feeKes: 108 },
      ],
    },
    send_unregistered: {
      type: "unpublished",
      notes:
        "The current consumer tariff page lists no separate send-to-unregistered column and the Send Money page " +
        "(last updated 2025-07-23) states no figure. Not modelled; do not guess.",
    },
    withdraw_agent: {
      type: "bands", confidence: "verified",
      bands: [
        // KES 1-49 is 'N/A' on the page (minimum agent withdrawal is KES 50): no band, expectedFee returns null.
        { minKes: 50, maxKes: 100, feeKes: 11 },
        { minKes: 101, maxKes: 500, feeKes: 29 },
        { minKes: 501, maxKes: 1000, feeKes: 29 },
        { minKes: 1001, maxKes: 1500, feeKes: 29 },
        { minKes: 1501, maxKes: 2500, feeKes: 29 },
        { minKes: 2501, maxKes: 3500, feeKes: 52 },
        { minKes: 3501, maxKes: 5000, feeKes: 69 },
        { minKes: 5001, maxKes: 7500, feeKes: 87 },
        { minKes: 7501, maxKes: 10000, feeKes: 115 },
        { minKes: 10001, maxKes: 15000, feeKes: 167 },
        { minKes: 15001, maxKes: 20000, feeKes: 185 },
        { minKes: 20001, maxKes: 35000, feeKes: 197 },
        { minKes: 35001, maxKes: 50000, feeKes: 278 },
        { minKes: 50001, maxKes: 250000, feeKes: 309 },
      ],
    },
    withdraw_atm: {
      type: "bands", confidence: "verified",
      bands: [
        { minKes: 200, maxKes: 2500, feeKes: 35 },
        { minKes: 2501, maxKes: 5000, feeKes: 69 },
        { minKes: 5001, maxKes: 10000, feeKes: 115 },
        { minKes: 10001, maxKes: 35000, feeKes: 203 },
      ],
    },
    till: {
      type: "flat", feeKes: 0, confidence: "verified",
      notes:
        "Buy Goods: customer charge 0 in every band. Exception stated on the page: at authorised fuel stations the " +
        "transaction charge is borne by the paying customer (not modelled).",
    },
    paybill: {
      type: "flat", feeKes: 0, confidence: "assumed",
      notes:
        "Customer-side paybill payment is free in the Safaricom tariff, but some billers pass charges on; the page " +
        "does not publish a customer table for paybill. Treat a stated non-zero fee as biller-defined.",
    },
  },
};
