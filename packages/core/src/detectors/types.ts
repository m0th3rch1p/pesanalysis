import type { Cents, Direction, TxKind } from "../types.js";

/** Minimal ledger row detectors need. Detectors are PURE FUNCTIONS over these: no I/O, no LLM. */
export interface LedgerTx {
  id: string;
  occurredAt: number;
  direction: Direction;
  amount: Cents;
  /** Stable key for the other party (normalised msisdn/till/paybill, else name). */
  counterpartyKey: string | null;
  /** Human name seen in SMS / user-given (display only; key stays canonical). */
  counterpartyName?: string | null;
  /** Optional enrichments used by later detectors. */
  kind?: TxKind;
  fee?: Cents | null;
  label?: string | null;
  scope?: "personal" | "business" | "mixed" | "unknown";
  role?: string | null;
  provider?: string;
  /** Optional context enrichments (all nullable: absence means "not observed"). */
  lat?: number | null;
  lng?: number | null;
  batteryPct?: number | null;
  isCharging?: boolean | null;
  stepDelta?: number | null;
  circadianPhase?: string | null;
  /** Latest provider-stated balance after this transaction, when the parser had one. */
  balanceAfterCents?: number | null;
  /** Item names attached to this transaction (confirmed items only). */
  items?: string[];
  /** Habit names attached through confirmed items (WS5.2 grouping). */
  habits?: string[];
  /** Credit-funded (Fuliza/Okoa/Airtel loan) vs wallet-funded when known. */
  funding?: "credit" | "wallet";
}

/**
 * Every detector emits typed findings with a sample size and a statistic. The LLM only NARRATES
 * findings; it never produces them. Findings below the min-n floor are not emitted ("we don't know").
 */
export interface Finding {
  detector: string;
  /** Stable id so a finding can be tracked/dismissed across runs. */
  id: string;
  title: string;
  n: number;
  /** One-sided p-value against the stated null, when applicable. */
  pValue?: number;
  evidence: Record<string, unknown>;
  /** Effect size used by the gate (WS5.1). */
  effect?: { abs: number; rel: number; unit: "cents" | "share" | "count" | "days" | "ratio"; lo?: number; hi?: number; absMonthlyCents?: number };
  /** Detector-specific minimum-data result; the gate defaults to n >= its own floor. */
  minDataMet?: boolean;
  /** Set by the gate; absent on raw detector output. */
  gate?: "shown" | "below_effect" | "insufficient_data" | "not_significant";
}

export type Detector<Opts = unknown> = (txs: LedgerTx[], opts?: Opts) => Finding[];
