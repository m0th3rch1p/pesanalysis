/** Plain-English surface terms. Numbers, dates and names are never changed. */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bbranching ratio\b/gi, "chain-reaction share"],
  [/\bHawkes\b/gi, "spending-chain"],
  [/\bBOCPD\b/gi, "sudden-change"],
  [/\bchangepoint\b/gi, "sudden change"],
  [/\bregime shift\b/gi, "pattern change"],
  [/\bregime\b/gi, "pattern"],
  [/\bMiller[- ]Orr\b/gi, "safe float"],
  [/\bWald\b/gi, "first-passage"],
  [/\bfirst-passage\b/gi, "zero-balance"],
  [/\bPayday Half[- ]Life\b/gi, "how long payday money lasts"],
  [/\bsub-additivity\b/gi, "split-fee"],
  [/\bsub-additive\b/gi, "split-fee"],
  [/\boff-radar transfer\b/gi, "money moved outside SMS view"],
  [/\boff-radar\b/gi, "outside SMS view"],
  [/\bcounterparty\b/gi, "person or business"],
  [/\bMSISDN\b/gi, "phone number"],
  [/\bairlock\b/gi, "safe summary"],
  [/\bk-suppressed\b/gi, "small groups hidden"],
  [/\bcohort\b/gi, "group"],
  [/\bexogenous\b/gi, "outside trigger"],
  [/\bendogenous\b/gi, "chain reaction"],
  [/\bdeterministic\b/gi, "rule-based"],
  [/\bquant(?:itative)?\b/gi, "number"],
  [/\bMCP\b/g, "tool connection"],
  [/\bZ1\b/g, "your own computer"],
  [/\bZ2\b/g, "outside summary"],
  [/\bQ1\b/g, "first quarter"],
  [/\bregress(?:ion|ed)?\b/gi, "statistical comparison"],
  [/\bAPR\b/g, "yearly cost"],
  [/\bFPT\b/g, "zero-balance chance"],
];
export function plainTerms(text: string): string {
  return REPLACEMENTS.reduce((s, [re, to]) => s.replace(re, to), text);
}

const DETECTORS: Record<string, string> = {
  amount_multiples: "repeat amounts",
  time_of_day: "time of day",
  periodic: "regular payments",
  fee_drag: "fees",
  debt_cycle: "borrowing loop",
  scope_mix: "business and personal mixed",
  episodes: "spending bursts",
  balance_break: "numbers do not add up",
  hawkes_cascade: "spending chains",
  bocpd_regime: "sudden changes",
  liquidity_ruin: "cash runway",
  tariff_cliff: "fee traps",
  mobility_phenotype: "places and spending",
  causal_impact: "habit experiment",
};
export function plainDetector(id: string): string {
  return DETECTORS[id] ?? plainTerms(id.replace(/_/g, " "));
}

export function plainLabel(name: string): string {
  if (name === "Off-radar transfer") return "Money outside SMS";
  if (name === "Debt repayment") return "Loan repayment";
  if (name === "Airtime & data") return "Airtime and data";
  if (name === "Savings & investment") return "Savings and investment";
  return name;
}
