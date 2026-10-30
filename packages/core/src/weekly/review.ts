/** Weekly review (WS5.7): deterministic roll-up of habits, gated findings, episodes and credit use. */
import type { DbAdapter } from "../db/migrate.js";
import { listHabits } from "../habits/categories.js";
import { habitProgress } from "../habits/progress.js";
import { creditShare } from "../insight/credit.js";

const DAY = 86_400_000;

export interface WeeklyHabit {
  id: number; name: string; currentCount: number; targetCount: number | null;
  heldOfLastM: string | null; followThrough: number | null;
}
export interface WeeklyFinding { id: string; detector: string; title: string; lastSeen: number; evidence: Record<string, unknown> }
export interface WeeklyEpisode {
  id: string; title: string; totalCents: number; startedAt: number | null;
  txIds: number[]; creditShare: number;
}
export interface WeeklyReview {
  from: number; to: number;
  habits: WeeklyHabit[];
  findings: WeeklyFinding[];
  episodes: WeeklyEpisode[];
  credit: { thisShare: number; previousShare: number; deltaPts: number; thisCents: number; thisOutflowCents: number; thisOutflows: number; previousCents: number };
  experiment: { habitId: number; habitName: string; title: string; why: string } | null;
  hasAnything: boolean;
}

function json(s: unknown): Record<string, unknown> {
  if (s == null) return {};
  try { const v = JSON.parse(String(s)); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** Last 7 EAT days ending now, with the previous 7 days as the comparison window. */
export function weeklyReview(db: DbAdapter, now = Date.now(), weeksOfHistory = 8): WeeklyReview {
  const to = now;
  const from = now - 7 * DAY;
  const previousFrom = now - 14 * DAY;

  const habits: WeeklyHabit[] = listHabits(db, "active").map((h) => {
    const p = habitProgress(db, h, now, weeksOfHistory);
    return {
      id: h.id, name: h.name,
      currentCount: p.current?.count ?? 0,
      targetCount: p.target?.count ?? null,
      heldOfLastM: p.heldOfLastM,
      followThrough: p.followThrough,
    };
  });

  const findingRows = db.all(
    `SELECT id, detector, title, last_seen AS lastSeen, evidence
       FROM findings
      WHERE COALESCE(gate,'shown') = 'shown' AND state NOT IN ('dismissed')
        AND last_seen >= ? AND last_seen < ?
      ORDER BY last_seen DESC LIMIT 4`,
    [from, to],
  ) as Array<{ id: string; detector: string; title: string; lastSeen: number; evidence: string }>;
  const findings: WeeklyFinding[] = findingRows
    .filter((r) => r.detector !== "episodes")
    .map((r) => ({ id: r.id, detector: r.detector, title: r.title, lastSeen: Number(r.lastSeen), evidence: json(r.evidence) }));

  const episodes: WeeklyEpisode[] = findingRows
    .filter((r) => r.detector === "episodes")
    .map((r) => {
      const e = json(r.evidence);
      return {
        id: r.id, title: r.title, totalCents: Number(e.totalCents ?? 0),
        startedAt: e.startedAt == null ? null : Number(e.startedAt),
        txIds: Array.isArray(e.txIds) ? e.txIds.map(Number).filter((n) => Number.isFinite(n)) : [],
        creditShare: Number(e.creditShare ?? 0),
      };
    });

  const cur = creditShare(db, from, to);
  const prev = creditShare(db, previousFrom, from);
  const credit = {
    thisShare: cur.shareValue, previousShare: prev.shareValue,
    deltaPts: (cur.shareValue - prev.shareValue) * 100,
    thisCents: cur.creditCents, thisOutflowCents: cur.outflowCents, thisOutflows: cur.outflows, previousCents: prev.creditCents,
  };

  let experiment: WeeklyReview["experiment"] = null;
  for (const h of habits) {
    const running = db.get(
      `SELECT id FROM experiments WHERE habit_id = ? AND status = 'running' LIMIT 1`, [h.id],
    ) as { id?: number } | undefined;
    if (running) continue;
    experiment = {
      habitId: h.id, habitName: h.name,
      title: "Try a 2-week change",
      why: `Test one small change around ${h.name}. The result will use your own payments and show an interval, not a promise.`,
    };
    break;
  }

  return {
    from, to, habits, findings, episodes, credit, experiment,
    hasAnything: habits.length > 0 || findings.length > 0 || episodes.length > 0 || cur.outflows > 0,
  };
}
