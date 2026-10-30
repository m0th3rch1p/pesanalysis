import type { SQLiteDatabase } from "expo-sqlite";
import {
  askQuestion, askWithPlan, compileEvidence, parseQuestionTime,
  type EvidenceRow, type AskResult, type QueryPlan, type Question,
} from "@yako/core";
import { asDbAdapter } from "./db/open";

export interface MobileAsk extends AskResult {
  engine: "rules" | "qvac";
  ms: number;
  tokPerSec?: number;
}

export interface StoredTurn {
  id: number;
  role: "user" | "assistant";
  content: string;
  plan: QueryPlan | null;
  createdAt: number;
  result?: MobileAsk;
}

/**
 * Rules only for user-facing answers. The 60-case on-phone eval rejected the local model
 * planner: 0.6B was 23/60 semantically exact at p50 16.7s, and 1.7B timed out on every
 * query tested. The shipped live build is deterministic; the eval harness stays in tools.
 */
export async function ask(db: SQLiteDatabase, question: string, previous?: QueryPlan | null): Promise<MobileAsk> {
  const t0 = Date.now();
  const a = asDbAdapter(db);
  const quick = askQuestion(question, { db: a });
  if (quick.ok) return { ...quick, engine: "rules", ms: Date.now() - t0 };

  // Follow-up: "and last month?" keeps the previous measure/grouping and only moves the window.
  if (previous) {
    const time = parseQuestionTime(question, Date.now());
    if (time) {
      const plan: QueryPlan = { ...previous, filters: { ...(previous.filters ?? {}), time } };
      const follow = askWithPlan(plan, question, { db: a });
      if (follow.ok) return { ...follow, engine: "rules", ms: Date.now() - t0 };
    }
  }

  return { ...quick, engine: "rules", ms: Date.now() - t0 };
}

export function ensureConversation(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ id: number }>(`SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1`);
  if (row) return row.id;
  const r = db.runSync(`INSERT INTO conversations (title, created_at, updated_at) VALUES ('Ask', ?, ?)`, [Date.now(), Date.now()]);
  return Number(r.lastInsertRowId);
}

export function newConversation(db: SQLiteDatabase): number {
  const r = db.runSync(`INSERT INTO conversations (title, created_at, updated_at) VALUES ('Ask', ?, ?)`, [Date.now(), Date.now()]);
  return Number(r.lastInsertRowId);
}

function assistantText(r: MobileAsk): string {
  if (r.answer) return [r.answer.headline, ...r.answer.bullets, ...r.answer.detail].join("\n");
  if (r.needs) return r.needs.question;
  return r.error ?? "I could not answer that yet.";
}

export async function askAndStore(db: SQLiteDatabase, question: string): Promise<{ result: MobileAsk; conversationId: number }> {
  const conversationId = ensureConversation(db);
  const previous = lastPlan(db, conversationId);
  const now = Date.now();
  db.runSync(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)`, [conversationId, question, now]);
  const result = await ask(db, question, previous);
  db.runSync(
    `INSERT INTO messages (conversation_id, role, content, plan_json, result_json, numbers_verified, created_at)
     VALUES (?, 'assistant', ?, ?, ?, ?, ?)`,
    [
      conversationId, assistantText(result),
      result.plan ? JSON.stringify(result.plan) : null,
      JSON.stringify({
        engine: result.engine, ms: result.ms, provenance: result.provenance, answer: result.answer ?? null,
        needs: result.needs ?? null, error: result.error ?? null, matches: result.matches ?? null,
        evidence: result.evidence ?? null,
      }),
      result.answer?.numbersVerified ? 1 : 0,
      Date.now(),
    ],
  );
  db.runSync(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [Date.now(), conversationId]);
  return { result, conversationId };
}

export function loadConversation(db: SQLiteDatabase, conversationId?: number): StoredTurn[] {
  const id = conversationId ?? ensureConversation(db);
  return db.getAllSync<{ id: number; role: "user" | "assistant"; content: string; plan_json: string | null; result_json: string | null; created_at: number }>(
    `SELECT id, role, content, plan_json, result_json, created_at FROM messages WHERE conversation_id = ? ORDER BY id`,
    [id],
  ).map((r) => {
    let plan: QueryPlan | null = null;
    let result: MobileAsk | undefined;
    try { plan = r.plan_json ? (JSON.parse(r.plan_json) as QueryPlan) : null; } catch { plan = null; }
    try {
      if (r.result_json) {
        const j = JSON.parse(r.result_json) as {
          engine?: "rules" | "qvac"; ms?: number; provenance?: string; answer?: MobileAsk["answer"];
          needs?: MobileAsk["needs"]; error?: string; matches?: number | null; evidence?: EvidenceRow[] | null;
        };
        if (r.role === "assistant") {
          result = {
            ok: !!j.answer, source: "plan", question: "", provenance: j.provenance ?? "", engine: j.engine ?? "rules",
            ms: j.ms ?? 0, plan: plan ?? undefined, answer: j.answer, needs: j.needs, error: j.error,
            matches: j.matches ?? undefined, evidence: j.evidence ?? undefined,
          };
        }
      }
    } catch { result = undefined; }
    return { id: r.id, role: r.role, content: r.content, plan, createdAt: r.created_at, result };
  });
}

/** Recompute the exact rows behind an answer if a saved result did not carry them. */
export function evidenceFor(db: SQLiteDatabase, plan: QueryPlan, limit = 200): EvidenceRow[] {
  try {
    const q = compileEvidence(plan, Date.now(), limit);
    return db.getAllSync<EvidenceRow>(q.sql, q.params);
  } catch { return []; }
}

export function lastPlan(db: SQLiteDatabase, conversationId: number): QueryPlan | null {
  const row = db.getFirstSync<{ plan_json: string }>(
    `SELECT plan_json FROM messages WHERE conversation_id = ? AND role = 'assistant' AND plan_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  if (!row) return null;
  try { return JSON.parse(row.plan_json) as QueryPlan; } catch { return null; }
}

/** Suggested follow-ups; deterministic, no model. */
export function suggestedQuestions(db: SQLiteDatabase): string[] {
  const a = asDbAdapter(db);
  const hasVenture = !!a.get(`SELECT 1 FROM ventures LIMIT 1`);
  const out = [
    "How am I doing this month?",
    "Where did my money go this month?",
    "Top merchants this month",
    "How much did I pay in fees last month?",
  ];
  if (hasVenture) out.push("Are my ventures making a profit?");
  return out;
}
