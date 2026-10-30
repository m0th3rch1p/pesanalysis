/**
 * F2: on-device model help for financial SMS the deterministic parsers cannot read.
 *
 * Pipeline (everything on the phone, CPU only):
 *   1. A deterministic prefilter drops clear non-transactions (OTP, marketing) and messages without an amount.
 *   2. Qwen3-0.6B extracts fields with a constrained JSON schema, including `is_transaction`.
 *   3. Core validators check every field against the raw text (amount verbatim, direction keywords,
 *      date within a day, reference shape). Any failure rejects the proposal.
 *   4. An accepted proposal becomes a PENDING transaction the user must confirm. Nothing is auto-filed.
 *
 * Laya was measured on this device and is NOT used as a gate: on a plain "Ksh 500.00 sent to ..." message
 * it answered "not money" with p=0.90 and the wrong direction, and its 3-way direction was near chance
 * (D97/D101). A wrong high-confidence gate loses real transactions, so the model only extracts and code decides.
 */
import type { SQLiteDatabase } from "expo-sqlite";
import { classifySender, directionFromKeywords, validateExtraction, type ParsedSms, type TxKind } from "@yako/core";
import { SqliteStore } from "../store";

export interface CandidateRow { smsId: number; sender: string; receivedAt: number; body: string; reason: string | null }
export interface WorkerResult {
  attempted: number; proposed: number; rejected: number; skipped: number; ms: number; note?: string;
}

const META_ENABLED = "ai_unknown_sms";

/** Messages that are never transactions; cheap, deterministic, and never sends them to a model. */
const NON_TRANSACTION = /\b(otp|one[- ]?time|verification code|your code|passcode|pin is|you are eligible|apply now|loan limit|win|winner|promotion|offer|dial \*|to opt out|terms apply)\b/i;
/** A record of a movement: an amount plus at least one confirmation verb. */
const HAS_AMOUNT = /(?:ksh|kes|sh)\s?\.?\s?\d|\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b/i;
const CONFIRMATION = /\b(confirmed|has been (sent|received|paid|debited|credited|withdrawn|deposited)|sent to|received from|paid to|withdrawn|deposited|transaction (cost|id)|new m-?pesa balance|m-?pesa balance|fuliza|repaid|disbursed)\b/i;

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_transaction", "amount", "direction", "date"],
  properties: {
    is_transaction: { type: "boolean", description: "True only when this message records an actual money movement that already happened. False for marketing, limit changes, reminders, balances and codes." },
    amount: { type: "number", description: "Amount in Kenyan shillings, e.g. 1250.5. No currency symbol." },
    direction: { type: "string", enum: ["in", "out"] },
    date: { type: "string", description: "Transaction date as yyyy-mm-dd (East Africa Time)." },
    counterparty: { type: ["string", "null"], description: "Person or business name exactly as written, or null." },
    ref: { type: ["string", "null"], description: "Provider transaction reference exactly as written, or null." },
  },
} as const;

const SYSTEM = "You extract ONE transaction from a Kenyan mobile-money or bank SMS. Reply with JSON only. " +
  "Set is_transaction true ONLY when the message records money that already moved (a payment, receipt, withdrawal, " +
  "deposit, loan draw, repayment or fee). Marketing, a credit-limit change, a reminder that something is due later, " +
  "a balance-only notice or a verification code is NOT a transaction: set is_transaction false. " +
  "Use the exact amount and reference from the message; never invent values. Dates are yyyy-mm-dd in East Africa Time. " +
  "direction is 'in' only when money entered THIS account (received, credited, deposited, a refund); 'sent to', " +
  "'paid to', 'withdrawn', 'debited' and 'bought' are 'out'.";

export function setModelHelp(db: SQLiteDatabase, on: boolean): void {
  try { db.runSync(`INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [META_ENABLED, on ? "1" : "0"]); } catch { /* optional */ }
}
export function modelHelpEnabled(db: SQLiteDatabase): boolean {
  try {
    const r = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [META_ENABLED]);
    return r ? r.value === "1" : true;
  } catch { return true; }
}

function listCandidates(db: SQLiteDatabase, limit: number): CandidateRow[] {
  return db.getAllSync<CandidateRow>(
    `SELECT c.sms_id AS smsId, c.sender, c.received_at AS receivedAt, s.body, c.reason
       FROM model_candidates c JOIN sms_raw s ON s.id = c.sms_id
      WHERE c.status = 'pending' ORDER BY c.received_at DESC LIMIT ?`, [limit],
  );
}

function mark(db: SQLiteDatabase, smsId: number, status: string, reason?: string | null, detail?: string | null): void {
  db.runSync(`UPDATE model_candidates SET status=?, reason=COALESCE(?, reason), detail=?, decided_at=? WHERE sms_id=?`,
    [status, reason ?? null, detail ? detail.slice(0, 400) : null, Date.now(), smsId]);
}

function kindFor(body: string, direction: "in" | "out"): TxKind {
  const b = body.toLowerCase();
  if (/fuliza|loan|repay|deni/.test(b)) return direction === "out" ? "loan_repay" : "loan_draw";
  if (/paybill|business number/.test(b)) return "paybill";
  if (/buy goods|till/.test(b)) return "till";
  if (/withdraw|agent|cash out/.test(b)) return "withdraw";
  if (/deposit|cash in/.test(b)) return "deposit";
  if (/airtime|bundle|data/.test(b)) return "airtime";
  return direction === "in" ? "receive" : "send";
}

function atNoonEat(iso: string, fallback: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return fallback;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0);
  return Number.isFinite(t) ? t : fallback;
}

function findLabelId(db: SQLiteDatabase, name: string): number | null {
  try {
    const r = db.getFirstSync<{ id: number }>(`SELECT id FROM labels WHERE name = ? AND status = 'active' LIMIT 1`, [name]);
    return r?.id ?? null;
  } catch { return null; }
}

const worker = { busy: null as Promise<WorkerResult> | null };

async function run(db: SQLiteDatabase, limit: number): Promise<WorkerResult> {
  const t0 = Date.now();
  const out: WorkerResult = { attempted: 0, proposed: 0, rejected: 0, skipped: 0, ms: 0 };
  const q = await import("../qvac");
  if (q.crashState().disabled) return { ...out, ms: Date.now() - t0, note: "disabled_after_crash" };
  const rows = listCandidates(db, limit);
  if (!rows.length) return { ...out, ms: Date.now() - t0, note: "no_candidates" };
  out.attempted = rows.length;

  // Cheap prefilter: obvious non-transactions and messages with no amount never reach Qwen.
  const usable = rows.filter((r) => !NON_TRANSACTION.test(r.body) && HAS_AMOUNT.test(r.body) && CONFIRMATION.test(r.body));
  for (const r of rows) if (!usable.includes(r)) { mark(db, r.smsId, "rejected", "prefilter_not_transaction"); out.rejected++; }
  if (!usable.length) { out.ms = Date.now() - t0; return out; }

  if (!q.localPath(q.MODELS.qwen3_06b)) {
    // Keep the candidate pending: the user may install the model later. Never look like a rejection.
    out.skipped = usable.length;
    out.ms = Date.now() - t0;
    return { ...out, note: "extract_model_missing" };
  }

  const store = new SqliteStore(db);
  let qwen: Awaited<ReturnType<typeof q.loadLocal>> | null = null;
  for (const r of usable) {
    try {
      qwen ??= await q.loadLocal(q.MODELS.qwen3_06b, { ctxSize: 2048 });
      q.beginInference(`extract:${r.smsId}`);
      let raw: string;
      try {
        const res = await q.complete(qwen.modelId, {
          system: SYSTEM,
          user: `SMS from ${r.sender}, received ${new Date(r.receivedAt + 3 * 3_600_000).toISOString().slice(0, 10)}:\n\"\"\"${r.body}\"\"\"`,
          predict: 160, temp: 0, timeoutMs: 90_000,
          responseFormat: { type: "json_schema", json_schema: { name: "sms_extraction", schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>, strict: true } },
        });
        raw = res.text;
      } finally { q.endInference(); }

      let parsed: unknown;
      try { parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()); }
      catch { mark(db, r.smsId, "rejected", "model_non_json", raw.slice(0, 200)); out.rejected++; continue; }

      // Direction is decided by the wording, not by the model: "sent to" is out even when the model says in.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const kw = directionFromKeywords(r.body);
        if (kw) (parsed as Record<string, unknown>).direction = kw;
      }
      const v = validateExtraction(parsed, { body: r.body, receivedAt: r.receivedAt, provider: classifySender(r.sender).provider });
      if (!v.accepted) { mark(db, r.smsId, "rejected", v.reasons.join(","), raw.slice(0, 200)); out.rejected++; continue; }

      const p = parsed as { amount: number; direction: "in" | "out"; date: string; counterparty?: string | null; ref?: string | null };
      const parsedSms: ParsedSms = {
        provider: classifySender(r.sender).provider,
        ref: p.ref ?? null,
        kind: kindFor(r.body, p.direction),
        direction: p.direction,
        amount: Math.round(p.amount * 100),
        fee: null,
        balanceAfter: null,
        counterpartyName: p.counterparty ?? null,
        counterpartyId: null,
        account: null,
        occurredAt: atNoonEat(p.date, r.receivedAt),
        template: "model.proposed",
        parserVersion: "model-1",
      };
      const cpName = p.counterparty?.trim();
      const cp = cpName ? store.upsertCounterparty(`n:${cpName.toLowerCase()}`, cpName) : null;
      const labelName = p.direction === "in" ? "Transfer in" : "Transfer out";
      const labelId = findLabelId(db, labelName);
      db.withTransactionSync(() => {
        const txId = store.insertTx({
          smsId: r.smsId, parsed: parsedSms, counterpartyId: cp?.id ?? null,
          chainStatus: "unknown", chainDiscrepancy: 0, status: "pending", role: "transaction",
          eventRef: `model:${r.smsId}`, scope: "unknown", suggestedLabelId: labelId, suggestedSource: "model", suggestedConfidence: 0.6,
        });
        db.runSync(`INSERT INTO model_proposals (sms_id, tx_id, classification, fields, reasons, status, created_at) VALUES (?,?,?,?,?,?,?)`,
          [r.smsId, txId, null, JSON.stringify(p), v.reasons.join(","), "accepted", Date.now()]);
        mark(db, r.smsId, "proposed", null, null);
      });
      out.proposed++;
    } catch (e) {
      mark(db, r.smsId, "rejected", "worker_error", String(e));
      out.rejected++;
    }
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Serialised, capped, never throws. Safe to call on every tick. */
export function processModelCandidates(db: SQLiteDatabase, limit = 3): Promise<WorkerResult> {
  if (!modelHelpEnabled(db)) return Promise.resolve({ attempted: 0, proposed: 0, rejected: 0, skipped: 0, ms: 0, note: "disabled_by_user" });
  if (worker.busy) return worker.busy;
  worker.busy = run(db, Math.max(1, Math.min(10, limit))).catch((e) => ({
    attempted: 0, proposed: 0, rejected: 0, skipped: 0, ms: 0, note: `worker_error:${String(e).slice(0, 120)}`,
  })).finally(() => { worker.busy = null; });
  return worker.busy;
}
