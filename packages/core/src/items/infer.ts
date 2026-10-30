/**
 * Deterministic item inference (WS3.3). The model never runs here. Every candidate is
 * a hypothesis shown as a chip; only the user confirms it.
 */
import type { DbAdapter } from "../db/migrate.js";
import { pricesForCounterparty, topItemsForCounterparty, type PriceRow } from "./store.js";
import { wilson } from "../detectors/stats.js";

export interface InferredItem { itemId: number; name: string; qty: number; amountCents: number }
export interface ItemCandidate {
  kind: "exact" | "basket" | "mode";
  items: InferredItem[];
  confidence: number;
  why: string;
}

interface TxLike { id: number; counterpartyId: number | null; amountCents: number }

function totalConfirmedAt(db: DbAdapter, counterpartyId: number): number {
  const r = db.get(
    `SELECT COUNT(*) AS n FROM tx_items ti JOIN transactions t ON t.id = ti.tx_id
      WHERE t.counterparty_id = ? AND ti.confirmed_at IS NOT NULL AND ti.item_id IS NOT NULL`,
    [counterpartyId],
  ) as { n?: number } | undefined;
  return Number(r?.n ?? 0);
}

/** Exact price: one item whose learned unit price equals the amount, seen at least twice. */
function exact(db: DbAdapter, tx: TxLike, prices: PriceRow[], total: number): ItemCandidate | null {
  const hits = prices.filter((p) => p.unitCents === tx.amountCents);
  if (!hits.length) return null;
  hits.sort((a, b) => b.seen - a.seen);
  const top = hits[0]!;
  if (top.seen < 2) return null;
  if (hits.length > 1 && top.seen < 2 * hits[1]!.seen) return null; // ambiguous
  const conf = Math.min(0.9, wilson(top.seen, Math.max(top.seen, total)).lo + 0.1);
  return {
    kind: "exact", confidence: conf,
    items: [{ itemId: top.itemId, name: top.name, qty: 1, amountCents: tx.amountCents }],
    why: `${top.name} has cost ${(top.unitCents / 100).toFixed(0)} here ${top.seen} times.`,
  };
}

/** Subset-sum over learned unit prices. Max 4 distinct items, max 3 units each. */
function baskets(db: DbAdapter, tx: TxLike, prices: PriceRow[]): ItemCandidate[] {
  if (tx.amountCents <= 0 || prices.length < 2) return [];
  const uniq: PriceRow[] = [];
  const seen = new Set<number>();
  for (const p of prices) { if (!seen.has(p.itemId)) { seen.add(p.itemId); uniq.push(p); } }
  const out: Array<{ items: InferredItem[]; score: number }> = [];
  const n = Math.min(uniq.length, 12);
  let nodes = 0;
  const walk = (start: number, chosen: InferredItem[], sum: number, score: number) => {
    if (++nodes > 120_000) return;
    if (sum === tx.amountCents && chosen.length) {
      out.push({ items: chosen.slice(), score });
      return;
    }
    if (chosen.length >= 4 || sum >= tx.amountCents) return;
    for (let i = start; i < n; i++) {
      const p = uniq[i]!;
      for (let q = 1; q <= 3; q++) {
        const add = p.unitCents * q;
        if (sum + add > tx.amountCents) break;
        chosen.push({ itemId: p.itemId, name: p.name, qty: q, amountCents: add });
        walk(i + 1, chosen, sum + add, score + Math.log(1 + p.seen));
        chosen.pop();
        if (sum + add === tx.amountCents) break;
      }
    }
  };
  walk(0, [], 0, 0);
  if (!out.length) return [];
  out.sort((a, b) => b.score - a.score);
  // Only offer a decomposition when the best clearly beats the second.
  if (out.length > 1 && out[0]!.score < out[1]!.score + Math.log(2)) return [];
  return [{
    kind: "basket", confidence: 0.55,
    items: out[0]!.items,
    why: "This payment splits exactly into prices seen here before.",
  }];
}

export function inferItems(db: DbAdapter, tx: TxLike): ItemCandidate[] {
  if (tx.counterpartyId == null) return [];
  const prices = pricesForCounterparty(db, tx.counterpartyId);
  if (!prices.length) return [];
  const total = totalConfirmedAt(db, tx.counterpartyId);
  const exactHit = exact(db, tx, prices, total);
  if (exactHit) return [exactHit];
  const basketHits = baskets(db, tx, prices);
  if (basketHits.length) return basketHits;
  const top = topItemsForCounterparty(db, tx.counterpartyId, 1)[0];
  if (!top || top.count < 2) return [];
  return [{
    kind: "mode", confidence: Math.min(0.6, wilson(top.count, Math.max(top.count, total)).lo + 0.1),
    items: [{ itemId: top.itemId, name: top.name, qty: 1, amountCents: tx.amountCents }],
    why: `${top.name} is the usual buy here (${top.count} times).`,
  }];
}
