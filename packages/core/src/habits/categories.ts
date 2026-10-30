/** Suggested habit categories from D111. Created only when the user accepts. */
import { lastInsertId, type DbAdapter } from "../db/migrate.js";
import { normalizeItemName } from "../items/normalize.js";
import type { HabitSelector } from "./selector.js";

export interface HabitCategorySuggestion { name: string; words: string[] }

export const HABIT_CATEGORY_SUGGESTIONS: HabitCategorySuggestion[] = [
  { name: "Tobacco", words: ["cigarette", "cigarettes", "cigar", "sigara", "fegi", "shisha", "vape"] },
  { name: "Alcohol", words: ["beer", "pombe", "tusker", "whisky", "whiskey", "wine", "gin", "vodka", "alcohol", "keg", "club"] },
  { name: "Betting", words: ["sportpesa", "betika", "odibets", "mozzartbet", "bet", "betting", "mchezo"] },
  { name: "Takeaway", words: ["glovo", "uber eats", "ubereats", "bolt food", "jumia food", "takeaway", "takeout", "delivery"] },
  { name: "Snacks", words: ["snack", "snacks", "crisps", "chips", "sweets", "chocolate", "biscuit", "biscuits"] },
];

export function suggestedHabitCategories(text: string): string[] {
  const n = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (!n.trim()) return [];
  return HABIT_CATEGORY_SUGGESTIONS.filter((s) => s.words.some((w) => n.includes(` ${w} `) || n.includes(` ${w}s `))).map((s) => s.name);
}

export interface HabitCategory { labelId: number; habitId: number; groupId: number | null; name: string }

export function createHabitCategory(db: DbAdapter, rawName: string, now = Date.now()): HabitCategory {
  const name = rawName.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) throw new Error("habit category needs a name");
  const existing = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE LIMIT 1`, [name]) as { id?: number } | undefined;
  let labelId: number;
  if (existing?.id) labelId = Number(existing.id);
  else {
    const parent = db.get(`SELECT id FROM labels WHERE name = 'Personal' LIMIT 1`) as { id?: number } | undefined;
    labelId = lastInsertId(db.run(`INSERT INTO labels (name, parent_id, is_custom, created_at) VALUES (?, ?, 1, ?)`, [name, parent?.id ?? null, now]));
  }

  const suggestion = HABIT_CATEGORY_SUGGESTIONS.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const words = (suggestion?.words ?? [name]).map(normalizeItemName).filter(Boolean);
  const group = db.get(`SELECT id FROM item_groups WHERE name = ? COLLATE NOCASE LIMIT 1`, [name]) as { id?: number } | undefined;
  const groupId = group?.id
    ? (db.run(`UPDATE item_groups SET label_id = ? WHERE id = ?`, [labelId, group.id]), Number(group.id))
    : lastInsertId(db.run(`INSERT INTO item_groups (name, label_id, created_at) VALUES (?, ?, ?)`, [name, labelId, now]));
  const selector = JSON.stringify({ labels: [labelId], groups: [groupId], words, direction: "out" });

  let habitId: number;
  const habit = db.get(`SELECT id FROM habits WHERE name = ? COLLATE NOCASE LIMIT 1`, [name]) as { id?: number } | undefined;
  if (habit?.id) { habitId = Number(habit.id); db.run(`UPDATE habits SET selector_json = ?, updated_at = ? WHERE id = ?`, [selector, now, habitId]); }
  else habitId = lastInsertId(db.run(`INSERT INTO habits (name, selector_json, direction, status, created_at, updated_at) VALUES (?, ?, 'reduce', 'active', ?, ?)`, [name, selector, now, now]));

  // Existing items move without touching their transactions: rollups use the item's current group.
  for (const w of words) {
    db.run(`UPDATE items SET group_id = ?, habit_id = ? WHERE key = ? OR name = ? COLLATE NOCASE`, [groupId, habitId, w, w]);
  }
  return { labelId, habitId, groupId, name };
}

/** Group to attach to an item when its key matches an accepted habit category. */
export function habitGroupForItem(db: DbAdapter, itemName: string): { groupId: number; habitId: number } | null {
  const key = normalizeItemName(itemName);
  if (!key) return null;
  const rows = db.all(`SELECT id, selector_json AS selectorJson FROM habits WHERE status = 'active'`) as Array<{ id: number; selectorJson: string }>;
  for (const r of rows) {
    try {
      const sel = JSON.parse(r.selectorJson) as { words?: unknown };
      if (Array.isArray(sel.words) && sel.words.some((w) => typeof w === "string" && normalizeItemName(w) === key)) {
        const g = db.get(`SELECT id FROM item_groups WHERE label_id = ? ORDER BY id LIMIT 1`, [
          (JSON.parse(r.selectorJson) as { labels?: number[] }).labels?.[0] ?? -1,
        ]) as { id?: number } | undefined;
        if (g?.id) return { groupId: Number(g.id), habitId: Number(r.id) };
      }
    } catch { /* ignore malformed selector */ }
  }
  return null;
}

export interface HabitRow {
  id: number; name: string; selector: HabitSelector; direction: "reduce" | "increase" | "keep";
  target: Record<string, unknown> | null; baseline: Record<string, unknown> | null;
  nudge: Record<string, unknown> | null; goalId: number | null; status: "active" | "paused" | "archived";
  createdAt: number; updatedAt: number;
}

const parseJson = <T>(s: unknown): T | null => { try { return typeof s === "string" ? JSON.parse(s) as T : null; } catch { return null; } };

export function listHabits(db: DbAdapter, status: "active" | "paused" | "archived" | "all" = "active"): HabitRow[] {
  const rows = db.all(
    `SELECT id, name, selector_json AS selectorJson, direction, target_json AS targetJson,
            baseline_json AS baselineJson, nudge_json AS nudgeJson, goal_id AS goalId, status,
            created_at AS createdAt, updated_at AS updatedAt
       FROM habits ${status === "all" ? "" : "WHERE status = ?"} ORDER BY name`,
    status === "all" ? [] : [status],
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id), name: String(r.name),
    selector: parseJson<HabitSelector>(r.selectorJson) ?? { direction: "out" },
    direction: r.direction as HabitRow["direction"],
    target: parseJson<Record<string, unknown>>(r.targetJson),
    baseline: parseJson<Record<string, unknown>>(r.baselineJson),
    nudge: parseJson<Record<string, unknown>>(r.nudgeJson),
    goalId: r.goalId == null ? null : Number(r.goalId),
    status: r.status as HabitRow["status"], createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
  }));
}

export function renameHabit(db: DbAdapter, id: number, name: string, now = Date.now()): void {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) throw new Error("habit name is empty");
  db.run(`UPDATE habits SET name = ?, updated_at = ? WHERE id = ?`, [clean, now, id]);
}


/** Older habit-category rows only carried labels. Attach the item group that holds the same label. */
export function repairHabitSelectors(db: DbAdapter, now = Date.now()): number {
  let fixed = 0;
  for (const h of listHabits(db, "all")) {
    if (h.selector.groups?.length || !h.selector.labels?.length) continue;
    const groups = h.selector.labels.map((id) => db.get(`SELECT id FROM item_groups WHERE label_id = ? LIMIT 1`, [id]) as { id?: number } | undefined)
      .map((g) => g?.id).filter((x): x is number => x != null);
    if (!groups.length) continue;
    const sel = { ...h.selector, groups };
    db.run(`UPDATE habits SET selector_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(sel), now, h.id]);
    fixed++;
  }
  return fixed;
}
