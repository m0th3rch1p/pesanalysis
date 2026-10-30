/** All money is integer minor units (KES cents). Never floats. */
export type Cents = number;

export type Provider = "mpesa" | "airtel_money" | "bank" | "lender" | "telco" | "platform" | "unknown";

export type TxKind =
  | "send"          // P2P out
  | "receive"       // P2P in
  | "paybill"       // paybill out (utility, merchant w/ account no.)
  | "till"          // buy goods out
  | "withdraw"      // agent cash-out
  | "deposit"       // agent cash-in
  | "airtime"
  | "bundle"        // data/sms bundles
  | "loan_draw"     // Fuliza / Okoa / digital lender disbursement
  | "loan_repay"
  | "fee"           // standalone charges (e.g. Fuliza interest)
  | "reversal"
  | "bank_debit"
  | "bank_credit"
  | "other";

export type Direction = "in" | "out" | "neutral";

/** Output of a deterministic template parser. No LLM involved. */
export interface ParsedSms {
  provider: Provider;
  /** Provider transaction reference (e.g. M-Pesa "TJ12ABC3XY"). Natural dedupe key. */
  ref: string | null;
  kind: TxKind;
  direction: Direction;
  amount: Cents;
  /** Transaction cost parsed from the same message, 0 if stated as 0, null if absent. */
  fee: Cents | null;
  /** Balance AFTER the transaction as stated by the provider. */
  balanceAfter: Cents | null;
  /** Raw counterparty string as it appears (name, till name, paybill name). */
  counterpartyName: string | null;
  /** Phone number / paybill / till / account number as it appears. */
  counterpartyId: string | null;
  /** For paybills: the account number the user typed. */
  account: string | null;
  /** Epoch ms, interpreted in Africa/Nairobi (UTC+3, no DST). */
  occurredAt: number;
  /** Fuliza/credit-line facts stated in the message. All cents; null when not stated. */
  creditLimitCents?: number | null;
  availableCreditCents?: number | null;
  outstandingCents?: number | null;
  dueAt?: number | null;
  /** M-Shwari / KCB M-PESA savings balance stated in the message. NOT the wallet balance (never use for the balance chain). */
  savingsBalanceAfter?: number | null;
  /** Which template matched. Used for coverage and regression tracking. */
  template: string;
  parserVersion: string;
}

export interface SmsContext {
  lat?: number; lng?: number; accuracy?: number;
  /** When the fix itself was taken (vs capturedAt, when the SMS snapshot was assembled). */
  locationAt?: number;
  fixKind?: "current" | "last_known" | "none";
  provider?: string;
  fixLatencyMs?: number;
  ageMs?: number;
  batteryPct?: number; isCharging?: boolean;
  capturedAt?: number;
  calendarEventId?: string; calendarTitle?: string;
}

export interface SmsMessage {
  sender: string;
  body: string;
  /** Epoch ms when the phone received it. */
  receivedAt: number;
  /** Passive context captured by the native receiver (optional; never required). */
  context?: SmsContext;
}

/** Why a message did not become a transaction. */
export type SkipReason = "not_financial_sender" | "phone_number_sender" | "no_template_match" | "not_a_transaction";

export type ParseOutcome =
  | { ok: true; parsed: ParsedSms }
  | { ok: false; reason: SkipReason; fingerprint?: string };

export type BalanceChainStatus = "ok" | "break" | "first" | "unknown";
