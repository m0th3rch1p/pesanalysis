/**
 * Goal modes (D116). A mode is a small, explicit set of measurable plans, not a
 * "financial health score". Onboarding writes the defaults; WS6 adds the measures.
 */
import type { DbAdapter } from "../db/migrate.js";

export type GoalMode = "steady" | "grow" | "business" | "clarity";

export const GOAL_MODES: GoalMode[] = ["steady", "grow", "business", "clarity"];

export interface GoalPlanRow {
  id: number; mode: GoalMode; title: string; kind: string; params: Record<string, unknown>;
  priority: number; status: string;
}

const DEFAULTS: Record<GoalMode, Array<{ title: string; kind: string; params: Record<string, unknown>; priority: number }>> = {
  steady: [
    { title: "Buffer of 7 days", kind: "buffer", params: { days: 7 }, priority: 2 },
    { title: "Credit-funded share under 20%", kind: "credit_share", params: { maxShare: 0.2, windowDays: 30 }, priority: 1 },
  ],
  grow: [
    { title: "Build a savings pot", kind: "save_target", params: {}, priority: 1 },
  ],
  business: [
    { title: "Track a venture", kind: "venture_margin", params: {}, priority: 1 },
  ],
  clarity: [],
};

export function isGoalMode(x: string): x is GoalMode {
  return (GOAL_MODES as string[]).includes(x);
}

export function getPrimaryMode(db: DbAdapter, fallback: GoalMode = "clarity"): GoalMode {
  const row = db.get(`SELECT value FROM meta WHERE key = 'primary_mode'`) as { value?: string } | undefined;
  return row?.value && isGoalMode(row.value) ? row.value : fallback;
}

/**
 * Set the primary mode and create its default plans once. Rerunning onboarding or
 * opening Settings must not duplicate plans; user edits to an existing plan win.
 */
export function setPrimaryMode(db: DbAdapter, mode: GoalMode, now = Date.now()): number[] {
  if (!isGoalMode(mode)) throw new Error(`unknown goal mode ${mode}`);
  db.run(
    `INSERT INTO meta (key, value) VALUES ('primary_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [mode],
  );
  const ids: number[] = [];
  for (const p of DEFAULTS[mode]) {
    const existing = db.get(
      `SELECT id FROM goal_plans WHERE mode = ? AND kind = ? AND status = 'active' LIMIT 1`,
      [mode, p.kind],
    ) as { id?: number } | undefined;
    if (existing?.id) { ids.push(Number(existing.id)); continue; }
    db.run(
      `INSERT INTO goal_plans (mode, title, kind, params_json, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [mode, p.title, p.kind, JSON.stringify(p.params), p.priority, now, now],
    );
    const row = db.get(`SELECT id FROM goal_plans WHERE mode = ? AND kind = ? ORDER BY id DESC LIMIT 1`, [mode, p.kind]) as { id?: number } | undefined;
    if (row?.id) ids.push(Number(row.id));
  }
  return ids;
}

export function listGoalPlans(db: DbAdapter, mode?: GoalMode): GoalPlanRow[] {
  const rows = db.all(
    `SELECT id, mode, title, kind, params_json AS paramsJson, priority, status
       FROM goal_plans WHERE status = 'active' ${mode ? "AND mode = ?" : ""}
      ORDER BY priority DESC, id`,
    mode ? [mode] : [],
  ) as Array<{ id: number; mode: GoalMode; title: string; kind: string; paramsJson: string; priority: number; status: string }>;
  return rows.map((r) => {
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(r.paramsJson) as Record<string, unknown>; } catch { params = {}; }
    return { id: Number(r.id), mode: r.mode, title: r.title, kind: r.kind, params, priority: Number(r.priority), status: r.status };
  });
}
