import type { Finding, LedgerTx } from "./types.js";
import { detectAmountMultiples } from "./amount-multiples.js";
import { detectTimeOfDay } from "./time-of-day.js";
import { detectPeriodic } from "./periodic.js";
import { detectFeeDrag } from "./fee-drag.js";
import { detectDebtCycle } from "./debt-cycle.js";
import { detectScopeMix } from "./scope-mix.js";
import { detectEpisodes, episodePattern, episodesUnlock } from "./episodes.js";
import { detectHawkesCascade } from "./hawkes-cascade.js";
import { detectBocpdRegime } from "./bocpd-regime.js";
import { detectLiquidityRuin } from "./liquidity-ruin.js";
import { detectTariffCliff } from "./tariff-cliff.js";
import { detectMobilityPhenotyping } from "./mobility-phenotyping.js";

export {
  detectAmountMultiples, detectTimeOfDay, detectPeriodic, detectFeeDrag, detectDebtCycle, detectScopeMix, detectEpisodes,
  episodePattern, episodesUnlock,
  detectHawkesCascade, detectBocpdRegime, detectLiquidityRuin, detectTariffCliff, detectMobilityPhenotyping,
};
export { causalImpact } from "../analytics/causal-impact.js";

export const REGISTRY = {
  amount_multiples: detectAmountMultiples,
  time_of_day: detectTimeOfDay,
  periodic: detectPeriodic,
  fee_drag: detectFeeDrag,
  debt_cycle: detectDebtCycle,
  scope_mix: detectScopeMix,
  episodes: detectEpisodes,
  // hawkes_cascade stays exported but is a diagnostic only (D96): bursts are not a user-facing finding.
  // hawkes_cascade: detectHawkesCascade,
  bocpd_regime: detectBocpdRegime,
  liquidity_ruin: detectLiquidityRuin,
  tariff_cliff: detectTariffCliff,
  mobility_phenotyping: detectMobilityPhenotyping,
} as const;

export type DetectorName = keyof typeof REGISTRY;

/** Run every detector; concatenate findings. Pure; no LLM. */
export function runAllDetectors(txs: LedgerTx[]): Finding[] {
  return Object.values(REGISTRY).flatMap((d) => d(txs));
}
