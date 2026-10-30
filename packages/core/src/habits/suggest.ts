import type { DbAdapter } from "../db/migrate.js";
import type { Finding } from "../detectors/types.js";
import { listHabits, type HabitRow } from "./categories.js";
import type { HabitSelector } from "./selector.js";
import { computeBaseline } from "./baseline.js";
import { suggestedTarget, type HabitTarget } from "./progress.js";

export interface HabitSuggestion {
  key: string; name: string; why: string;
  selector: HabitSelector; baselineCount: number; baselineValueCents: number;
  target: HabitTarget; direction: "reduce" | "increase";
  previewCount: number;
}

const labelId = (db: DbAdapter, name: string): number | null => {
  const r = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE LIMIT 1`, [name]) as { id?: number } | undefined;
  return r?.id == null ? null : Number(r.id);
};

function windowName(startHour: number, width: number): string {
  const end = (startHour + width) % 24;
  return `${String(startHour).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00`;
}

/** Suggestions from gated time-of-day findings and credit-funded items. User must accept. */
export function suggestHabits(db: DbAdapter, findings: Finding[], now = Date.now()): HabitSuggestion[] {
  const out: HabitSuggestion[] = [];
  const existing = listHabits(db, "all");
  const has = (sel: HabitSelector) => existing.some((h) => {
    const s = h.selector;
    return (s.labels ?? []).join(",") === (sel.labels ?? []).join(",")
      && (s.window?.startMin ?? -1) === (sel.window?.startMin ?? -1)
      && (s.window?.endMin ?? -1) === (sel.window?.endMin ?? -1);
  });
  for (const f of findings) {
    if (f.detector !== "time_of_day" || (f.gate && f.gate !== "shown")) continue;
    const group = String(f.evidence.group ?? "");
    const m = /^label:(.+)\|(out|in)$/.exec(group);
    if (!m) continue;
    const id = labelId(db, m[1]!);
    if (!id) continue;
    const w = f.evidence.window as [number, number] | undefined;
    const width = Number(f.evidence.widthHours ?? (w ? (w[1] - w[0] + 24) % 24 || 24 : 3));
    const window = w ? { startMin: w[0] * 60, endMin: ((w[0] + width) % 24) * 60 } : undefined;
    const selector: HabitSelector = { labels: [id], direction: m[2] === "in" ? "in" : "out", ...(window ? { window } : {}) };
    if (has(selector)) continue;
    const baseline = computeBaseline(db, selector, now);
    out.push({
      key: `tod:${id}:${w?.[0] ?? 0}`,
      name: `${m[1]} ${windowName(w?.[0] ?? 0, width)}`,
      why: f.title,
      selector, baselineCount: baseline.meanCount, baselineValueCents: baseline.meanValueCents,
      target: suggestedTarget(baseline, "reduce"), direction: "reduce",
      previewCount: baseline.counts.reduce((a, b) => a + b, 0),
    });
  }
  // High credit-funded items at one counterparty are habit candidates too.
  const creditItems = db.all(
    `SELECT i.id AS itemId, i.name, t.counterparty_id AS cpId, c.display_name AS cpName, COUNT(*) AS n
       FROM tx_items ti JOIN items i ON i.id = ti.item_id
       JOIN transactions t ON t.id = ti.tx_id
       LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.role = 'transaction' AND t.direction = 'out'
        AND EXISTS (SELECT 1 FROM transactions f WHERE f.role='funding_notice' AND f.ref IS NOT NULL AND f.ref = t.event_ref)
      GROUP BY i.id, t.counterparty_id HAVING n >= 5 ORDER BY n DESC LIMIT 4`,
  ) as Array<{ itemId: number; name: string; cpId: number | null; cpName: string | null; n: number }>;
  for (const r of creditItems) {
    const selector: HabitSelector = { items: [Number(r.itemId)], direction: "out", funding: "credit" };
    if (has(selector)) continue;
    const baseline = computeBaseline(db, selector, now);
    out.push({
      key: `credit:${r.itemId}:${r.cpId ?? 0}`,
      name: `${r.name} on Fuliza`,
      why: `${r.n} credit-funded ${r.name} purchases${r.cpName ? ` at ${r.cpName}` : ""}.`,
      selector, baselineCount: baseline.meanCount, baselineValueCents: baseline.meanValueCents,
      target: suggestedTarget(baseline, "reduce"), direction: "reduce",
      previewCount: baseline.counts.reduce((a, b) => a + b, 0),
    });
  }
  return out.slice(0, 6);
}

export interface CreateHabitInput {
  name: string; selector: HabitSelector; direction: "reduce" | "increase" | "keep";
  target?: HabitTarget | null; baseline?: Record<string, unknown> | null; nudge?: Record<string, unknown> | null; goalId?: number | null;
}
export function createHabit(db: DbAdapter, input: CreateHabitInput, now = Date.now()): number {
  const r = db.run(
    `INSERT INTO habits (name, selector_json, direction, target_json, baseline_json, nudge_json, goal_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [input.name.trim(), JSON.stringify(input.selector), input.direction,
      input.target ? JSON.stringify(input.target) : null, input.baseline ? JSON.stringify(input.baseline) : null,
      input.nudge ? JSON.stringify(input.nudge) : null, input.goalId ?? null, now, now],
  );
  const id = Number((r as { lastInsertRowid?: number | bigint; lastInsertRowId?: number | bigint } | undefined)?.lastInsertRowid ?? (r as { lastInsertRowId?: number } | undefined)?.lastInsertRowId ?? 0);
  return id || Number((db.get(`SELECT id FROM habits WHERE name = ? ORDER BY id DESC LIMIT 1`, [input.name.trim()]) as { id?: number } | undefined)?.id ?? 0);
}

export function setHabitStatus(db: DbAdapter, id: number, status: "active" | "paused" | "archived", now = Date.now()): void {
  db.run(`UPDATE habits SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
}

export function setHabitTarget(db: DbAdapter, id: number, target: HabitTarget | null, now = Date.now()): void {
  db.run(`UPDATE habits SET target_json = ?, updated_at = ? WHERE id = ?`, [target ? JSON.stringify(target) : null, now, id]);
}

export function habitById(db: DbAdapter, id: number): HabitRow | null {
  return listHabits(db, "all").find((h) => h.id === id) ?? null;
}
