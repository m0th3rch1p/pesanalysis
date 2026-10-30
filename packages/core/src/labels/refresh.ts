/**
 * Recompute stored suggestions for pending transactions with the current suggester.
 * Suggestions are written at ingest time; after the suggester's rules change (or after
 * an entity merge) old rows can carry stale labels, e.g. an airtime guess learned at a
 * telco leaking onto a bank paybill. Idempotent and bounded; confirmed labels are never
 * touched. WS0.3.
 */
import type { DbAdapter } from "../db/migrate.js";
import { suggestLabel, type Suggestion } from "./suggest.js";
import type { KnnItem } from "./knn.js";
import type { ParsedSms } from "../types.js";

interface PendingRow {
  id: number; provider: string; ref: string | null; kind: string; direction: "in" | "out" | "neutral";
  amount: number; fee: number | null; balanceAfter: number | null; account: string | null;
  occurredAt: number; template: string; parserVersion: string; cpId: number | null; cpName: string | null;
}

interface HistoryRow { id: number; label: string; kind: string | null; text: string }

export function refreshPendingLabelSuggestions(db: DbAdapter, limit = 2000): number {
  const history: KnnItem[] = db.all(
    `SELECT t.id AS id, l.name AS label, t.kind AS kind,
            TRIM(COALESCE(c.display_name, '') || ' ' || COALESCE(t.account, '') || ' ' || t.template) AS text
       FROM tx_labels tl
       JOIN transactions t ON t.id = tl.tx_id
       JOIN labels l ON l.id = tl.label_id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE tl.confirmed_at IS NOT NULL AND t.role = 'transaction'
      ORDER BY t.occurred_at DESC LIMIT 200`,
  ).map((r: HistoryRow) => ({ id: String(r.id), label: r.label, text: r.text, kind: r.kind }));

  const rows = db.all(
    `SELECT t.id, t.provider, t.ref, t.kind, t.direction, t.amount, t.fee, t.balance_after AS balanceAfter,
            t.account, t.occurred_at AS occurredAt, t.template, t.parser_version AS parserVersion,
            c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName
       FROM transactions t LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.role = 'transaction' AND t.status = 'pending'
      ORDER BY t.occurred_at DESC LIMIT ?`,
    [limit],
  ) as PendingRow[];

  let changed = 0;
  for (const row of rows) {
    const parsed: ParsedSms = {
      provider: row.provider as ParsedSms["provider"], ref: row.ref, kind: row.kind as ParsedSms["kind"],
      direction: row.direction, amount: row.amount, fee: row.fee, balanceAfter: row.balanceAfter,
      counterpartyName: row.cpName, counterpartyId: null, account: row.account,
      occurredAt: row.occurredAt, template: row.template, parserVersion: row.parserVersion,
    };
    const defaultLabel = row.cpId == null ? null : db.get(
      `SELECT l.name AS label, tl.confidence FROM counterparties c
         JOIN labels l ON l.id = c.default_label_id
         LEFT JOIN tx_labels tl ON tl.tx_id = (
           SELECT t.id FROM transactions t WHERE t.counterparty_id = c.id
            AND t.role = 'transaction' ORDER BY t.occurred_at DESC LIMIT 1)
        WHERE c.id = ? AND l.status = 'active' LIMIT 1`,
      [row.cpId],
    ) as { label: string; confidence: number | null } | undefined;
    const suggestion: Suggestion | null = suggestLabel(parsed, {
      history,
      counterpartyDefault: defaultLabel ? { label: defaultLabel.label, confidence: Math.max(0.78, Math.min(0.84, Number(defaultLabel.confidence ?? 0.8))) } : null,
    });
    const current = db.all(
      `SELECT tl.label_id AS labelId, l.name AS label, tl.source FROM tx_labels tl
         JOIN labels l ON l.id = tl.label_id
        WHERE tl.tx_id = ? AND tl.confirmed_at IS NULL`,
      [row.id],
    ) as Array<{ labelId: number; label: string; source: string }>;
    if (suggestion) {
      const same = current.length === 1 && current[0]!.label === suggestion.label && current[0]!.source === suggestion.source;
      if (same) continue;
    } else if (current.length === 0) continue;
    db.run(`DELETE FROM tx_labels WHERE tx_id = ? AND confirmed_at IS NULL`, [row.id]);
    if (suggestion) {
      const label = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND status = 'active' LIMIT 1`, [suggestion.label]) as { id?: number } | undefined;
      if (label?.id) {
        db.run(
          `INSERT OR IGNORE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at) VALUES (?, ?, ?, ?, ?)`,
          [row.id, label.id, suggestion.source, suggestion.confidence, Date.now()],
        );
        changed++;
      }
    } else {
      changed++;
    }
  }
  return changed;
}
