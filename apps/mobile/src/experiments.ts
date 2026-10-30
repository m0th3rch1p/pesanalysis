import type { SQLiteDatabase } from "expo-sqlite";
import { causalImpact, matchingTxs, type CausalImpactResult } from "@yako/core";
import { asDbAdapter } from "./db/open";

export interface ExperimentRow {
  id: number; name: string; hypothesis: string | null; startedAt: number; endedAt: number | null;
  metricMeasure: string; targetLabel: string | null; controlLabel: string | null;
  status: string; createdAt: number; resultJson: string | null; habitId: number | null; mode: string;
}

const DAY = 86_400_000;

export function listExperiments(db: SQLiteDatabase): ExperimentRow[] {
  return db.getAllSync<{
    id: number; name: string; hypothesis: string | null; startedAt: number; endedAt: number | null;
    metricMeasure: string; targetLabel: string | null; controlLabel: string | null;
    status: string; createdAt: number; resultJson: string | null; habitId: number | null; mode: string;
  }>(`SELECT id, name, hypothesis, started_at AS startedAt, ended_at AS endedAt,
             metric_measure AS metricMeasure, target_label AS targetLabel, control_label AS controlLabel,
             status, created_at AS createdAt, result_json AS resultJson, habit_id AS habitId, COALESCE(mode,'live') AS mode
        FROM experiments ORDER BY created_at DESC LIMIT 30`).map((r) => ({ ...r }));
}

/** Daily spend series (last 90 days), optionally for one label. */
export function dailySeries(db: SQLiteDatabase, label: string | null, now = Date.now()): { series: number[]; start: number } {
  const days = 90;
  const start = now - (days - 1) * DAY;
  const a = asDbAdapter(db);
  const rows = a.all(
    `SELECT t.occurred_at AS at, t.amount, t.fee, l.name AS label
       FROM tx_events t
       LEFT JOIN tx_labels tl ON tl.rowid = (
         SELECT x.rowid FROM tx_labels x WHERE x.tx_id = t.id
          ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
       LEFT JOIN labels l ON l.id = tl.label_id
      WHERE t.direction = 'out' AND t.occurred_at >= ?`,
    [start],
  ) as Array<{ at: number; amount: number; fee: number | null; label: string | null }>;
  const series = new Array<number>(days).fill(0);
  for (const r of rows) {
    if (label && (r.label ?? "").toLowerCase() !== label.toLowerCase()) continue;
    const idx = Math.floor((r.at - start) / DAY);
    if (idx >= 0 && idx < days) series[idx] = series[idx]! + r.amount + (r.fee ?? 0);
  }
  return { series, start };
}

export function createExperiment(
  db: SQLiteDatabase,
  input: { name: string; targetLabel?: string | null; startedAt: number; hypothesis?: string },
): ExperimentRow {
  const now = Date.now();
  const r = db.runSync(
    `INSERT INTO experiments (name, hypothesis, started_at, metric_measure, target_label, status, created_at)
     VALUES (?, ?, ?, 'spend', ?, 'running', ?)`,
    [input.name.trim() || "Experiment", input.hypothesis ?? null, input.startedAt, input.targetLabel?.trim() || null, now],
  );
  const id = Number(r.lastInsertRowId);
  return listExperiments(db).find((e) => e.id === id)!;
}

export function listExperimentsForHabit(db: SQLiteDatabase, habitId: number): ExperimentRow[] {
  return listExperiments(db).filter((e) => e.habitId === habitId);
}

/** Create a live habit experiment. The series is daily matching count, not spend. */
export function createHabitExperiment(db: SQLiteDatabase, habitId: number, name: string, startedAt = Date.now()): ExperimentRow {
  const row = db.runSync(
    `INSERT INTO experiments (name, hypothesis, started_at, metric_measure, target_label, status, created_at, habit_id, mode)
     VALUES (?, ?, ?, 'habit_count', NULL, 'running', ?, ?, 'live')`,
    [name.trim() || "Habit change", "Changing the routine reduces how often this habit happens.", startedAt, Date.now(), habitId],
  );
  return listExperiments(db).find((e) => e.id === Number(row.lastInsertRowId))!;
}

export function habitDailySeries(db: SQLiteDatabase, habitId: number, now = Date.now()): { series: number[]; start: number } {
  const days = 90, start = now - (days - 1) * DAY;
  const a = asDbAdapter(db);
  const habit = a.get(`SELECT selector_json AS s FROM habits WHERE id = ?`, [habitId]) as { s?: string } | undefined;
  if (!habit?.s) return { series: new Array(days).fill(0), start };
  let selector: Record<string, unknown>;
  try { selector = JSON.parse(habit.s) as Record<string, unknown>; } catch { return { series: new Array(days).fill(0), start }; }
  const ids = matchingTxs(a, selector as never, start, now + DAY).map((t) => t.at);
  const series = new Array<number>(days).fill(0);
  for (const at of ids) { const idx = Math.floor((at - start) / DAY); if (idx >= 0 && idx < days) series[idx] = series[idx]! + 1; }
  return { series, start };
}

export function runHabitExperiment(db: SQLiteDatabase, id: number, now = Date.now()): CausalImpactResult {
  const row = db.getFirstSync<{ habitId: number | null; startedAt: number }>(`SELECT habit_id AS habitId, started_at AS startedAt FROM experiments WHERE id = ?`, [id]);
  if (!row?.habitId) throw new Error("habit experiment not found");
  const { series, start } = habitDailySeries(db, row.habitId, now);
  const interventionIndex = Math.max(0, Math.min(series.length, Math.floor((row.startedAt - start) / DAY)));
  const result = causalImpact(series, interventionIndex, { seasonLength: 7 });
  db.runSync(`UPDATE experiments SET status='completed', ended_at=?, result_json=? WHERE id=?`, [now, JSON.stringify(result), id]);
  return result;
}

export function runExperiment(db: SQLiteDatabase, id: number, now = Date.now()): CausalImpactResult {
  const row = db.getFirstSync<{
    name: string; startedAt: number; targetLabel: string | null;
  }>(`SELECT name, started_at AS startedAt, target_label AS targetLabel FROM experiments WHERE id = ?`, [id]);
  if (!row) throw new Error("experiment not found");
  const { series, start } = dailySeries(db, row.targetLabel, now);
  const interventionIndex = Math.max(0, Math.min(series.length, Math.floor((row.startedAt - start) / DAY)));
  const result = causalImpact(series, interventionIndex, { seasonLength: 7 });
  db.runSync(`UPDATE experiments SET status='completed', ended_at=?, result_json=? WHERE id=?`, [now, JSON.stringify(result), id]);
  return result;
}
