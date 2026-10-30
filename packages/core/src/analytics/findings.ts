/**
 * G2: findings used to be recomputed and thrown away, so a dismissal could not stick.
 * Persist with first/last seen and user state; detectors remain the only source of findings.
 */
import type { DbAdapter } from "../db/migrate.js";
import type { Finding } from "../detectors/types.js";
import type { FindingEffect, FindingGate } from "../detectors/gate.js";

export type FindingState = "new" | "shown" | "dismissed" | "acted";

export interface StoredFinding extends Finding {
  state: FindingState;
  firstSeen: number;
  lastSeen: number;
  qValue?: number;
  gate?: FindingGate;
  feedback?: number | null;
}

export function persistFindings(db: DbAdapter, findings: Finding[], now = Date.now()): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  for (const f of findings) {
    const has = db.get(`SELECT id FROM findings WHERE id = ?`, [f.id]);
    const g = f as Finding & { qValue?: number; gate?: string; effect?: FindingEffect };
    const effect = g.effect ?? (f as Finding & { effect?: FindingEffect }).effect;
    db.run(
      `INSERT INTO findings (id, detector, title, n, p_value, evidence, first_seen, last_seen, state, q_value, effect_json, gate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, n = excluded.n, p_value = excluded.p_value,
         evidence = excluded.evidence, last_seen = excluded.last_seen, q_value = excluded.q_value,
         effect_json = excluded.effect_json, gate = excluded.gate`,
      [f.id, f.detector, f.title, f.n, f.pValue ?? null, JSON.stringify(f.evidence), now, now,
        g.qValue ?? null, effect ? JSON.stringify(effect) : null, g.gate ?? null],
    );
    if (has) updated++; else inserted++;
  }
  return { inserted, updated };
}

export function loadPersistedFindings(db: DbAdapter, includeDismissed = false): StoredFinding[] {
  const rows = db.all(
    `SELECT id, detector, title, n, p_value AS pValue, evidence, state, first_seen AS firstSeen, last_seen AS lastSeen,
            q_value AS qValue, effect_json AS effectJson, gate, feedback
       FROM findings ${includeDismissed ? "" : "WHERE state NOT IN ('dismissed')"}
      ORDER BY last_seen DESC, id`,
  ) as Array<{ id: string; detector: string; title: string; n: number; pValue: number | null; evidence: string; state: FindingState; firstSeen: number; lastSeen: number; qValue: number | null; effectJson: string | null; gate: FindingGate | null; feedback: number | null }>;
  return rows.map((r) => {
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(r.evidence) as Record<string, unknown>; } catch { evidence = {}; }
    let effect: FindingEffect | undefined;
    try { effect = r.effectJson ? JSON.parse(r.effectJson) as FindingEffect : undefined; } catch { effect = undefined; }
    return {
      id: r.id, detector: r.detector, title: r.title, n: r.n, pValue: r.pValue ?? undefined, evidence,
      state: r.state, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
      qValue: r.qValue ?? undefined, gate: r.gate ?? undefined, effect, feedback: r.feedback,
    };
  });
}

export function setFindingState(db: DbAdapter, id: string, state: FindingState): void {
  db.run(`UPDATE findings SET state = ?, last_seen = ? WHERE id = ?`, [state, Date.now(), id]);
}
