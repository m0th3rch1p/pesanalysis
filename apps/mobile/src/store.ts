import type { SQLiteDatabase } from "expo-sqlite";
import {
  sha256Hex, classifyBalanceBreak, classifyFlow, discoverAccount, insertSecurityAlert, linkAirtimeCredit as linkAirtimeCreditDb,
  type Cents, type KnnItem, type ParsedSms, type SecurityAlertInput, type SmsContext, type SmsMessage, type Store,
} from "@yako/core";
import { asDbAdapter } from "./db/open";

/**
 * Synchronous expo-sqlite implementation of the core Store contract.
 * One SMS -> a handful of indexed writes; no network, no LLM (DECISIONS D3).
 */
export class SqliteStore implements Store {
  constructor(private readonly db: SQLiteDatabase) {}

  hasSms(s: SmsMessage): boolean {
    const h = sha256Hex(s.body);
    return !!this.db.getFirstSync<{ ok: number }>(
      `SELECT 1 AS ok FROM sms_raw WHERE sender = ? AND received_at = ? AND body_sha256 = ? LIMIT 1`,
      [s.sender, s.receivedAt, h],
    );
  }

  insertSms(s: SmsMessage): number {
    const h = sha256Hex(s.body);
    this.db.runSync(
      `INSERT OR IGNORE INTO sms_raw (sender, body, received_at, body_sha256) VALUES (?, ?, ?, ?)`,
      [s.sender, s.body, s.receivedAt, h],
    );
    const row = this.db.getFirstSync<{ id: number }>(
      `SELECT id FROM sms_raw WHERE sender = ? AND received_at = ? AND body_sha256 = ?`,
      [s.sender, s.receivedAt, h],
    );
    if (!row) throw new Error("insertSms: row missing after insert");
    return row.id;
  }

  insertTx(tx: {
    smsId: number; parsed: ParsedSms; counterpartyId: number | null;
    chainStatus: string; chainDiscrepancy: Cents; status: string;
    role: string; eventRef: string; scope?: string;
    suggestedLabelId: number | null; suggestedSource?: string | null; suggestedConfidence?: number | null;
  }): number {
    const p = tx.parsed;
    const r = this.db.runSync(
      `INSERT OR IGNORE INTO transactions
        (sms_id, provider, ref, kind, direction, amount, fee, balance_after, counterparty_id,
         account, occurred_at, template, parser_version, chain_status, chain_discrepancy, status,
         scope, role, event_ref, flow_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.smsId, p.provider, p.ref, p.kind, p.direction, p.amount, p.fee, p.balanceAfter,
        tx.counterpartyId, p.account, p.occurredAt, p.template, p.parserVersion,
        tx.chainStatus, tx.chainDiscrepancy, tx.status, tx.scope ?? "unknown", tx.role, tx.eventRef,
        classifyFlow({
          kind: p.kind, direction: p.direction, template: p.template,
          counterpartyId: p.counterpartyId, account: p.account, counterpartyName: p.counterpartyName,
        }),
      ],
    );
    const row = this.db.getFirstSync<{ id: number }>(
      `SELECT id FROM transactions WHERE sms_id = ?`,
      [tx.smsId],
    );
    if (!row) throw new Error("insertTx: row missing after insert");
    const id = row.id;
    if (tx.suggestedLabelId != null) {
      this.db.runSync(
        `INSERT OR IGNORE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, tx.suggestedLabelId, tx.suggestedSource ?? "rule", tx.suggestedConfidence ?? null, Date.now()],
      );
    }
    return id;
  }

  /** F2: remember a financial-looking unread SMS for on-device help. */
  recordUnparsed(smsId: number, info: { sender: string; receivedAt: number; reason: string }): void {
    this.db.runSync(
      `INSERT OR IGNORE INTO model_candidates (sms_id, sender, received_at, reason) VALUES (?, ?, ?, ?)`,
      [smsId, info.sender, info.receivedAt, info.reason],
    );
  }

  findTxByEventRef(eventRef: string): { id: number; provider: string; role: string } | null {
    return this.db.getFirstSync<{ id: number; provider: string; role: string }>(
      `SELECT id, provider, role FROM transactions WHERE event_ref = ?
        ORDER BY CASE role WHEN 'transaction' THEN 0 WHEN 'funding_notice' THEN 1 ELSE 2 END, id
        LIMIT 1`,
      [eventRef],
    ) ?? null;
  }

  setTxRole(txId: number, role: string): void {
    this.db.runSync(`UPDATE transactions SET role = ? WHERE id = ?`, [role, txId]);
  }

  upsertCounterparty(key: string, rawName: string | null): { id: number; isNew: boolean } {
    const row = this.db.getFirstSync<{ id: number; merged_into: number | null }>(`SELECT id, merged_into FROM counterparties WHERE key = ?`, [key]);
    if (row) {
      let id = row.id;
      if (row.merged_into != null) {
        const target = this.db.getFirstSync<{ id: number }>(`SELECT id FROM counterparties WHERE id = ?`, [row.merged_into]);
        if (target) id = target.id;
      }
      if (rawName) {
        const cur = this.db.getFirstSync<{ raw_names: string }>(`SELECT raw_names FROM counterparties WHERE id = ?`, [id]);
        let names: string[] = [];
        try { names = JSON.parse(cur?.raw_names ?? "[]"); } catch { names = []; }
        if (!names.includes(rawName)) {
          names.push(rawName);
          this.db.runSync(`UPDATE counterparties SET raw_names = ? WHERE id = ?`, [JSON.stringify(names), id]);
        }
      }
      return { id, isNew: false };
    }
    const r = this.db.runSync(
      `INSERT OR IGNORE INTO counterparties (key, raw_names, first_seen) VALUES (?, ?, ?)`,
      [key, JSON.stringify(rawName ? [rawName] : []), Date.now()],
    );
    // Always read back by natural key: `lastInsertRowId` is stale when OR IGNORE
    // ignores a row inserted by another connection between the SELECT and INSERT.
    const again = this.db.getFirstSync<{ id: number }>(`SELECT id FROM counterparties WHERE key = ?`, [key]);
    if (!again) throw new Error("upsertCounterparty: row missing after insert");
    return { id: again.id, isNew: Number(r.changes) > 0 };
  }

  findLabelIdByName(name: string): number | null {
    const row = this.db.getFirstSync<{ id: number }>(
      `SELECT id FROM labels WHERE name = ? AND status = 'active' LIMIT 1`,
      [name],
    );
    return row?.id ?? null;
  }

  lastBalanceTx(provider: string, before: number): { occurredAt: number; balanceAfter: Cents } | null {
    return this.db.getFirstSync<{ occurredAt: number; balanceAfter: Cents }>(
      `SELECT occurred_at AS occurredAt, balance_after AS balanceAfter
         FROM transactions
        WHERE provider = ? AND balance_after IS NOT NULL AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
      [provider, before],
    );
  }

  chainAnchor(provider: string, before: number): { anchor: Cents | null; pending: Cents } {
    const a = this.lastBalanceTx(provider, before);
    if (!a) return { anchor: null, pending: 0 };
    const row = this.db.getFirstSync<{ pending: number }>(
      `SELECT COALESCE(SUM(
          CASE
            WHEN balance_after IS NOT NULL THEN 0
            WHEN kind IN ('send','paybill','till','withdraw','airtime','bundle') THEN -(amount + COALESCE(fee, 0))
            WHEN kind IN ('receive','deposit','reversal') THEN amount - COALESCE(fee, 0)
            WHEN kind = 'loan_draw' AND provider = 'mpesa' THEN amount
            ELSE 0
          END), 0) AS pending
         FROM transactions
        WHERE provider = ? AND occurred_at < ? AND occurred_at > ? AND role <> 'duplicate_notice'`,
      [provider, before, a.occurredAt],
    );
    return { anchor: a.balanceAfter, pending: row?.pending ?? 0 };
  }

  linkTxAccounts(txId: number, sender: string, parsed: ParsedSms): void {
    try { discoverAccount(asDbAdapter(this.db), { sender, parsed, txId }); } catch { /* non-fatal */ }
  }

  recordSecurityAlert(alert: SecurityAlertInput): void {
    try {
      const a = asDbAdapter(this.db);
      const id = insertSecurityAlert(a, alert);
      if (alert.kind === "balance_break" && id > 0) classifyBalanceBreak(a, id);
    } catch { /* non-fatal */ }
  }

  linkAirtimeCredit(txId: number, creditCents: number, occurredAt: number): boolean {
    try { return !!linkAirtimeCreditDb(asDbAdapter(this.db), txId, creditCents, occurredAt); } catch { return false; }
  }

  saveContext(txId: number, c: SmsContext): void {
    try {
      const at = c.capturedAt ?? Date.now();
      const hour = new Date(at + 3 * 3_600_000).getUTCHours();
      const phase = hour < 6 ? "late_night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "late_night";
      const existing = this.db.getFirstSync<{ lat: number | null; fix_kind: string | null }>(
        `SELECT lat, fix_kind FROM tx_context WHERE tx_id = ?`, [txId],
      );
      const incomingCurrent = c.fixKind === "current";
      const keepBetter = existing?.lat != null && existing.fix_kind === "current" && !incomingCurrent;
      if (keepBetter) {
        this.db.runSync(
          `UPDATE tx_context SET battery_pct = COALESCE(?, battery_pct), is_charging = COALESCE(?, is_charging),
                  calendar_event_id = COALESCE(?, calendar_event_id), calendar_title = COALESCE(?, calendar_title)
            WHERE tx_id = ?`,
          [c.batteryPct ?? null, c.isCharging == null ? null : (c.isCharging ? 1 : 0),
            c.calendarEventId ?? null, c.calendarTitle ?? null, txId],
        );
      } else {
        const age = c.ageMs ?? (c.locationAt != null ? Math.max(0, at - c.locationAt) : null);
        this.db.runSync(
          `INSERT INTO tx_context
            (tx_id, lat, lng, accuracy_m, motion, steps_last_10m, calendar_event_id, calendar_title,
             source, captured_at, age_ms, battery_pct, is_charging, step_delta, circadian_phase,
             fix_kind, fix_latency_ms, provider)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'sms_receiver', ?, ?, ?, ?, NULL, ?, ?, ?, ?)
           ON CONFLICT(tx_id) DO UPDATE SET
             lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
             calendar_event_id = excluded.calendar_event_id, calendar_title = excluded.calendar_title,
             captured_at = excluded.captured_at, age_ms = excluded.age_ms,
             battery_pct = excluded.battery_pct, is_charging = excluded.is_charging,
             circadian_phase = excluded.circadian_phase,
             fix_kind = excluded.fix_kind, fix_latency_ms = excluded.fix_latency_ms, provider = excluded.provider`,
          [txId, c.lat ?? null, c.lng ?? null, c.accuracy ?? null, c.calendarEventId ?? null, c.calendarTitle ?? null,
            at, age, c.batteryPct ?? null, c.isCharging == null ? null : (c.isCharging ? 1 : 0), phase,
            c.fixKind ?? (c.lat != null ? "last_known" : "none"), c.fixLatencyMs ?? null, c.provider ?? null],
        );
      }
    } catch { /* context is optional */ }
  }

  counterpartyDefaultLabel(counterpartyId: number): { label: string; confidence: number } | null {
    const row = this.db.getFirstSync<{ label: string; confidence: number | null }>(
      `SELECT l.name AS label, tl.confidence
         FROM counterparties c
         JOIN labels l ON l.id = c.default_label_id
         LEFT JOIN tx_labels tl ON tl.tx_id = (
           SELECT t.id FROM transactions t WHERE t.counterparty_id = c.id
            AND t.role = 'transaction' ORDER BY t.occurred_at DESC LIMIT 1)
        WHERE c.id = ? AND l.status = 'active' LIMIT 1`,
      [counterpartyId],
    );
    if (!row) return null;
    return { label: row.label, confidence: Math.max(0.78, Math.min(0.84, Number(row.confidence ?? 0.8))) };
  }

  confirmedHistoryForKnn(limit: number): KnnItem[] {
    return this.db.getAllSync<{ id: number; label: string; text: string; kind: string | null }>(
      `SELECT t.id AS id, l.name AS label, t.kind AS kind,
              TRIM(COALESCE(c.display_name, '') || ' ' || COALESCE(t.account, '') || ' ' || t.template) AS text
         FROM tx_labels tl
         JOIN transactions t ON t.id = tl.tx_id
         JOIN labels l ON l.id = tl.label_id
         LEFT JOIN counterparties c ON c.id = t.counterparty_id
        WHERE tl.confirmed_at IS NOT NULL AND t.role = 'transaction'
        ORDER BY t.occurred_at DESC
        LIMIT ?`,
      [limit],
    ).map((r) => ({ id: String(r.id), label: r.label, text: r.text, kind: r.kind }));
  }
}
