/** Credit-funded consumption and Fuliza cost (WS5.5). A canonical outflow is credit-funded when
 * its event_ref points at a funding notice (Fuliza/Okoa/Airtel loan draw). No model here. */
import type { DbAdapter } from "../db/migrate.js";
import { simulateFuliza, type FulizaEvent } from "../tariffs/engine.js";

export interface CreditShare {
  outflows: number;
  creditOutflows: number;
  outflowCents: number;
  creditCents: number;
  shareCount: number;
  shareValue: number;
}
export interface CreditOptions { label?: string; item?: string; habitId?: number }

export function creditShare(db: DbAdapter, from: number, to: number, o: CreditOptions = {}): CreditShare {
  const where = [`t.direction = 'out'`, `t.role = 'transaction'`, `t.occurred_at >= ?`, `t.occurred_at < ?`];
  const params: unknown[] = [from, to];
  if (o.label) {
    where.push(`EXISTS (SELECT 1 FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL AND l.name = ?)`);
    params.push(o.label);
  }
  if (o.item) {
    where.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id = ti.item_id WHERE ti.tx_id = t.id AND i.key = ?)`);
    params.push(o.item.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim());
  }
  if (o.habitId != null) {
    where.push(`EXISTS (SELECT 1 FROM tx_items ti JOIN items i ON i.id = ti.item_id WHERE ti.tx_id = t.id AND i.habit_id = ?)`);
    params.push(o.habitId);
  }
  const rows = db.all(
    `SELECT t.amount AS amount,
            EXISTS (SELECT 1 FROM transactions f WHERE f.role = 'funding_notice' AND f.ref IS NOT NULL AND f.ref = t.event_ref) AS credit
       FROM transactions t WHERE ${where.join(" AND ")}`,
    params,
  ) as Array<{ amount: number; credit: number }>;
  const outflows = rows.length;
  const creditOutflows = rows.filter((r) => Number(r.credit) === 1).length;
  const outflowCents = rows.reduce((a, r) => a + Number(r.amount), 0);
  const creditCents = rows.filter((r) => Number(r.credit) === 1).reduce((a, r) => a + Number(r.amount), 0);
  return {
    outflows, creditOutflows, outflowCents, creditCents,
    shareCount: outflows ? creditOutflows / outflows : 0,
    shareValue: outflowCents ? creditCents / outflowCents : 0,
  };
}

export interface FulizaCost {
  draws: number; drawnCents: number; accessFeesCents: number; dailyFeesCents: number;
  totalFeesCents: number; costPer100Cents: number | null; estimated: true;
}
export function fulizaCost(db: Adapter, from: number, to: number): FulizaCost {
  const rows = db.all(
    `SELECT kind, amount, occurred_at AS at FROM transactions
      WHERE template LIKE 'mpesa.fuliza%' AND kind IN ('loan_draw','loan_repay') AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at`, [from, to],
  ) as Array<{ kind: string; amount: number; at: number }>;
  const events: FulizaEvent[] = rows.map((r) => ({ at: Number(r.at), kind: r.kind === "loan_draw" ? "draw" : "repay", amountCents: Number(r.amount) }));
  const sim = simulateFuliza(events, to);
  const draws = rows.filter((r) => r.kind === "loan_draw");
  const drawnCents = draws.reduce((a, r) => a + Number(r.amount), 0);
  return {
    draws: draws.length, drawnCents,
    accessFeesCents: sim.accessFeesCents, dailyFeesCents: sim.dailyFeesCents,
    totalFeesCents: sim.totalCents,
    costPer100Cents: drawnCents > 0 ? Math.round((sim.totalCents / drawnCents) * 10_000) : null,
    estimated: true,
  };
}
type Adapter = DbAdapter;
