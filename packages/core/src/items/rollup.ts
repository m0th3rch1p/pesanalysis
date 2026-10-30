/** Rollups by item -> group -> label, using the deepest level the row has (D110). */
import type { DbAdapter } from "../db/migrate.js";

export interface ItemRollupRow {
  key: string; name: string; level: "item" | "group" | "label";
  count: number; totalCents: number; labelName: string | null;
}

export function itemRollup(db: DbAdapter, from: number, to: number): ItemRollupRow[] {
  return db.all(
    `SELECT CASE WHEN ti.item_id IS NOT NULL THEN 'item:' || ti.item_id
                 WHEN COALESCE(ti.group_id, i.group_id) IS NOT NULL THEN 'group:' || COALESCE(ti.group_id, i.group_id)
                 ELSE 'label:' || tl.label_id END AS key,
            CASE WHEN ti.item_id IS NOT NULL THEN i.name
                 WHEN COALESCE(ti.group_id, i.group_id) IS NOT NULL THEN g.name
                 ELSE l.name END AS name,
            CASE WHEN ti.item_id IS NOT NULL THEN 'item'
                 WHEN COALESCE(ti.group_id, i.group_id) IS NOT NULL THEN 'group'
                 ELSE 'label' END AS level,
            COUNT(*) AS count, SUM(COALESCE(ti.amount_cents, t.amount)) AS totalCents,
            l.name AS labelName
       FROM tx_items ti
       JOIN transactions t ON t.id = ti.tx_id
       LEFT JOIN items i ON i.id = ti.item_id
       LEFT JOIN item_groups g ON g.id = COALESCE(ti.group_id, i.group_id)
       LEFT JOIN tx_labels tl ON tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL
       LEFT JOIN labels l ON l.id = COALESCE(g.label_id, tl.label_id)
      WHERE t.role = 'transaction' AND t.direction = 'out' AND t.occurred_at >= ? AND t.occurred_at < ?
      GROUP BY key ORDER BY totalCents DESC`,
    [from, to],
  ) as ItemRollupRow[];
}
