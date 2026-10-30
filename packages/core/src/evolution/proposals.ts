import { binomTwoSided } from "../detectors/stats.js";

/**
 * Typed patch proposals. ANY component may propose a change (local profiler, on-device LLM,
 * optional frontier model, or the user) — but NOTHING applies without passing the replay gate.
 * Patches are declarative JSON so they can be validated, diffed, rolled back, and replayed.
 */
export type ProposalType =
  | "rule_add"        // labels/rules.ts: add a LabelRule
  | "rule_edit"       // change a rule's keyword set/conf
  | "label_merge"     // taxonomy consolidation
  | "label_split"
  | "role_merge"
  | "detector_param"  // e.g. raise amount_multiples minShare
  | "prompt_delta";   // narrator/system prompt tweak

export interface Proposal {
  id: string;
  origin: "profiler" | "local_llm" | "frontier" | "user";
  type: ProposalType;
  /** JSON patch payload: {target, set, ...} — interpreted by the component's applier */
  patch: Record<string, unknown>;
  rationale?: string;
  createdAt: number;
}

export type Applier = (patch: Record<string, unknown>) => unknown;

export interface GateVerdict {
  verdict: "apply" | "abstain" | "reject";
  pValue: number;
  wins: number;
  losses: number;
  /** effective sample after the asymmetric penalty (each loss counts twice) */
  effWins: number;
  effLosses: number;
  reason: string;
}

export interface GateOpts {
  minN?: number;          // minimum scored items (default 30)
  alpha?: number;         // significance (default 0.05)
  /** asymmetric penalty: each regression counts as `penalty` losses (default 2, EVOLUTION design) */
  regressionPenalty?: number;
}

/**
 * The evolution gate (port of the mouse EVOLUTION design): replay the candidate patch over ALL
 * confirmed history. scoreFn is called per item for base and patched configs — a PAIRED comparison.
 * Two-sided sign test on win/loss counts with the regression penalty; ABSTAIN (no change) when
 * n is too small or the result is not significant. Never applies anything itself.
 */
export function evaluateProposal(
  proposal: Proposal,
  history: number[],
  baseScore: (item: number, ctx: unknown) => number,
  patchedScore: (item: number, ctx: unknown) => number,
  ctxFor?: (item: number) => unknown,
  opts: GateOpts = {},
): GateVerdict {
  const { minN = 30, alpha = 0.05, regressionPenalty = 2 } = opts;
  if (history.length < minN) {
    return { verdict: "abstain", pValue: 1, wins: 0, losses: 0, effWins: 0, effLosses: 0, reason: `n=${history.length} < minN=${minN}: not enough evidence to change behaviour` };
  }
  let wins = 0, losses = 0, ties = 0;
  for (const item of history) {
    const ctx = ctxFor ? ctxFor(item) : undefined;
    const a = baseScore(item, ctx);
    const b = patchedScore(item, ctx);
    if (b > a) wins++;
    else if (b < a) losses++;
    else ties++;
  }
  const effWins = wins;
  const effLosses = losses * regressionPenalty;
  const n = effWins + effLosses;
  if (n === 0) return { verdict: "abstain", pValue: 1, wins, losses, effWins, effLosses, reason: "no effect on any item" };
  const p = binomTwoSided(n, effWins, 0.5);
  const netPositive = effWins > effLosses;
  const verdict: GateVerdict["verdict"] = p < alpha && netPositive ? "apply" : p < alpha && !netPositive ? "reject" : "abstain";
  return {
    verdict, pValue: p, wins, losses, effWins, effLosses,
    reason: verdict === "apply" ? `paired sign test significant (p=${p.toFixed(4)}, ${wins}W/${losses}L with penalty ${regressionPenalty}x)` : verdict === "reject" ? "patch hurts more than it helps" : `not significant (p=${p.toFixed(4)}) or neutral — keeping current behaviour`,
  };
}
