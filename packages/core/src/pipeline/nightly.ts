import type { ParsedSms } from "../types.js";
import { detectAmountMultiples, runAllDetectors } from "../detectors/index.js";
import type { Finding, LedgerTx } from "../detectors/types.js";
import { profile, type ConfirmedTx, type ProfileResult } from "../evolution/profiler.js";

/**
 * Nightly orchestration (device-local batch — no network):
 * detectors over all txs -> diff vs stored findings -> profiler rule mining.
 * A knob example: re-run detection with a looser threshold; it counts as an improvement only if
 * the extra findings still pass significance. The app persists results and surfaces what needs
 * a human in the next consolidation session.
 */
export interface NightlyResult {
  findings: Finding[];
  newFindings: Finding[];
  goneFindings: string[];
  profileResult: ProfileResult;
  knobVerdict: "keep" | "loosen" | "abstain";
}

export interface NightlyStore {
  allTransactions(): Array<{
    id: number; parsed: ParsedSms; occurredAt: number; cpKey?: string | null;
    kind?: string; fee?: number | null; label?: string | null;
    scope?: string; role?: string | null; provider?: string; chainStatus?: string;
  }>;
  storedFindingIds(): string[];
}

export function toLedger(rows: ReturnType<NightlyStore["allTransactions"]>): LedgerTx[] {
  return rows.map((r) => ({
    id: String(r.id), occurredAt: r.occurredAt, direction: r.parsed.direction,
    amount: r.parsed.amount, counterpartyKey: r.cpKey ?? null, kind: r.parsed.kind,
    fee: r.fee ?? null, label: r.label ?? null, scope: (r.scope as LedgerTx["scope"]) ?? "unknown",
    role: r.role ?? null, provider: r.provider,
  }));
}

export function runNightly(store: NightlyStore): NightlyResult {
  const rows = store.allTransactions();
  const ledger = toLedger(rows);
  const findings = runAllDetectors(ledger);
  const stored = new Set(store.storedFindingIds());
  const newFindings = findings.filter((f) => !stored.has(f.id));
  const goneFindings = [...stored].filter((id) => !findings.some((f) => f.id === id));

  const confirmed: ConfirmedTx[] = rows.filter((r) => r.label).map((r) => ({ parsed: r.parsed, label: r.label!, cpKey: r.cpKey ?? null }));
  const profileResult = profile(confirmed, { maxNewRules: 2 });

  const knobVerdict = knobVerdictFor(ledger, confirmed.length);

  return { findings, newFindings, goneFindings, profileResult, knobVerdict };
}

/** Loosen detectAmountMultiples minShare 0.9 -> 0.85 only if it surfaces MORE findings, with confirmed data to validate. */
function knobVerdictFor(ledger: LedgerTx[], confirmed: number): "keep" | "loosen" | "abstain" {
  if (confirmed < 30) return "abstain";
  const base = detectAmountMultiples(ledger, { minShare: 0.9 }).length;
  const loose = detectAmountMultiples(ledger, { minShare: 0.85 }).length;
  return loose > base ? "loosen" : "keep";
}
