import { KE_MPESA_2026_08_04 } from "./ke-mpesa-2026-08-04.js";
import { KE_POCHI_PROMO_2026_08_01 } from "./ke-pochi-promo-2026-08-01.js";
import { KE_FULIZA_2022_10_01 } from "./ke-fuliza-2022-10-01.js";
import type { FulizaVersion, TariffVersion } from "../types.js";

export const TARIFF_VERSIONS: TariffVersion[] = [KE_MPESA_2026_08_04, KE_POCHI_PROMO_2026_08_01];
export const FULIZA_VERSIONS: FulizaVersion[] = [KE_FULIZA_2022_10_01];
