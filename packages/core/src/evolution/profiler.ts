import type { ParsedSms } from "../types.js";
import { SEED_RULES, type LabelRule, type RuleCtx } from "../labels/rules.js";
import { evaluateProposal, type Proposal, type GateVerdict } from "./proposals.js";

/**
 * The profiler: the on-device component that makes the system SELF-EVOLVING.
 * Runs in a batch (nightly / on charge, DECISIONS D-x) over CONFIRMED transactions and:
 *  1. mines candidate keyword rules (precision + support gated) for labels not yet well covered,
 *  2. proposes them as typed rule_add proposals,
 *  3. passes each candidate through the replay gate (evaluateProposal) — only statistically
 *     significant improvements survive.
 * Nothing here writes to the DB: it returns gated proposals for the consolidation session
 * (or safe auto-apply per policy). Derived from PEAM (arXiv 2610.14855) + the mouse EVOLUTION gate.
 */

export interface ConfirmedTx {
  parsed: ParsedSms;
  label: string;       // user-confirmed label (ground truth)
  cpKey: string | null;
}

export interface ProfileResult {
  proposals: Proposal[];
  verdicts: Map<string, GateVerdict>;
  /** labels with enough confirmed data to mine from */
  minableLabels: string[];
}

export interface ProfilerOpts {
  minSupport?: number;      // min confirmed txs per candidate keyword (default 5)
  minPrecision?: number;    // keyword precision vs its label (default 0.9)
  minLift?: number;         // precision / base-rate of the label (default 1.5)
  gateMinN?: number;        // replay gate floor (default 30)
  maxNewRules?: number;     // per run (default 3) — keep the taxonomy stable
}

/** Simple tokenizer for keyword mining. */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

export function profile(history: ConfirmedTx[], opts: ProfilerOpts = {}): ProfileResult {
  const { minSupport = 5, minPrecision = 0.9, minLift = 1.5, gateMinN = 30, maxNewRules = 3 } = opts;

  // label base rates
  const labelCount = new Map<string, number>();
  for (const h of history) labelCount.set(h.label, (labelCount.get(h.label) ?? 0) + 1);
  const minableLabels = [...labelCount].filter(([, n]) => n >= minSupport).map(([l]) => l);

  // token -> labels it appears in (from counterparty + account + template haystack)
  const tokenLabels = new Map<string, Map<string, number>>();
  for (const h of history) {
    const hay = [h.parsed.counterpartyName, h.parsed.account, h.parsed.template].filter(Boolean).join(" ");
    for (const t of new Set(tokens(hay))) {
      const m = tokenLabels.get(t) ?? new Map<string, number>();
      m.set(h.label, (m.get(h.label) ?? 0) + 1);
      tokenLabels.set(t, m);
    }
  }

  const candidates: Array<{ rule: LabelRule; support: number; precision: number; lift: number }> = [];
  for (const [tok, labels] of tokenLabels) {
    if (SEED_RULES.some((r) => r.id === `m_${tok}`)) continue;
    // skip tokens already matched by a seed rule (they'd be redundant)
    if (SEED_RULES.some((r) => r.test({ parsed: {} as unknown as ParsedSms, hay: tok }))) continue;
    for (const [label, n] of labels) {
      if (n < minSupport) continue;
      const support = n;
      const labelTotal = labelCount.get(label)!;
      const precision = n / labelTotal; // how often this keyword co-occurs with the label (co-occurrence proxy)
      const baseRate = labelTotal / history.length;
      const lift = precision / Math.max(baseRate, 1e-9);
      if (precision < minPrecision || lift < minLift) continue;
      const keyword = label.toLowerCase().includes(tok) ? null : tok;
      if (!keyword) continue;
      candidates.push({
        rule: {
          id: `m_${tok}`,
          test: (c: RuleCtx) => c.hay.includes(keyword),
          label,
          conf: Math.min(0.9, 0.5 + 0.4 * Math.min(1, (precision - minPrecision) / (1 - minPrecision) + 0.25)),
        },
        support, precision, lift,
      });
    }
  }

  // rank candidates: support * lift
  candidates.sort((a, b) => b.support * b.lift - a.support * a.lift);

  const proposals: Proposal[] = [];
  const verdicts = new Map<string, GateVerdict>();
  for (const cand of candidates.slice(0, maxNewRules)) {
    const proposal: Proposal = {
      id: `prop_${cand.rule.id}_${Date.now()}`,
      origin: "profiler",
      type: "rule_add",
      patch: { ruleId: cand.rule.id, label: cand.rule.label, keyword: [cand.rule.test][0] ? undefined : undefined, conf: cand.rule.conf, keywordHay: cand.rule.id.slice(2), support: cand.support, precision: cand.precision, lift: cand.lift },
      rationale: `Confirmed history: "${cand.rule.id.slice(2)}" co-occurs with label "${cand.rule.label}" in ${cand.precision.toFixed(2)} of ${cand.support} confirmed cases (lift ${cand.lift.toFixed(2)}).`,
      createdAt: Date.now(),
    };
    // replay gate: score = exact-label match on the confirmed history
    const verdict = evaluateProposal(
      proposal,
      history.map((_, i) => i),
      (i) => (baseLabel(history[i]!, cand.rule) ? 1 : 0),
      (i) => (patchedLabel(history[i]!, cand.rule) ? 1 : 0),
      undefined,
      { minN: gateMinN },
    );
    proposals.push(proposal);
    verdicts.set(proposal.id, verdict);
  }
  return { proposals, verdicts, minableLabels };
}

function hay(h: ConfirmedTx, tok: string): string {
  void tok;
  return [h.parsed.counterpartyName, h.parsed.account, h.parsed.template].filter(Boolean).join(" ").toLowerCase();
}

/** base scorer: does the CURRENT rule set predict the confirmed label? */
function baseLabel(h: ConfirmedTx, _candidate: LabelRule): boolean {
  const hay0 = hay(h, "");
  return SEED_RULES.some((r) => r.test({ parsed: h.parsed, hay: hay0 }) && labelsMatch(r.label, h.label));
}

/** patched scorer: current rules + the candidate */
function patchedLabel(h: ConfirmedTx, cand: LabelRule): boolean {
  if (baseLabel(h, cand)) return true;
  return cand.test({ parsed: h.parsed, hay: hay(h, "") }) && labelsMatch(cand.label, h.label);
}

function labelsMatch(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}
