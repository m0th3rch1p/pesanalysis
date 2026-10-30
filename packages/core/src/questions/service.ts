/**
 * The question queue: the agent earns its world model by asking, not by snooping.
 * Ranking is deterministic (money at stake x recurrence x recency). Budgets and quiet hours
 * are UI policy; this module owns generation, dedupe, answers and the fact they produce.
 */
import type { DbAdapter } from "../db/migrate.js";
import { formatKes } from "../sms/money.js";
import { recordFact } from "../profile/store.js";
import { createVenture, suggestTags, tagTx } from "../tags/store.js";
import { SEED_ROLES } from "../labels/taxonomy.js";
import { normalizeName } from "../entities/normalize.js";
import type { Question, QuestionKind } from "./types.js";

interface QuestionRow {
  id: number; kind: QuestionKind; subject_ref: string; prompt: string; options_json: string | null;
  why: string; score: number; status: Question["status"]; created_at: number; answered_at: number | null; answer_json: string | null;
}

function mapQuestion(r: QuestionRow): Question {
  let options: string[] | undefined;
  try { options = r.options_json ? (JSON.parse(r.options_json) as string[]) : undefined; } catch { options = undefined; }
  return {
    id: r.id, kind: r.kind, subjectRef: r.subject_ref, prompt: r.prompt, options,
    why: r.why, score: r.score, status: r.status,
  };
}

function score(totalCents: number, n: number, lastAt: number, now: number): number {
  const money = Math.min(totalCents / 100, 1_000_000);
  const recency = lastAt >= now - 30 * 86_400_000 ? 1 : 0.55;
  return Math.round(money * (1 + Math.log2(1 + n)) * recency);
}

function upsert(db: DbAdapter, q: { kind: QuestionKind; subjectRef: string; prompt: string; why: string; options?: string[]; total: number; n: number; lastAt: number }, now: number): boolean {
  const existing = db.get(`SELECT status, answered_at AS answeredAt FROM questions WHERE kind = ? AND subject_ref = ?`, [q.kind, q.subjectRef]);
  if (existing) {
    if (existing.status === "answered") return false;
    if (existing.status === "dismissed" && Number(existing.answeredAt ?? 0) > now - 14 * 86_400_000) return false;
  }
  const s = score(q.total, q.n, q.lastAt, now);
  db.run(
    `INSERT INTO questions (kind, subject_ref, prompt, options_json, why, score, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(kind, subject_ref) DO UPDATE SET prompt = excluded.prompt, options_json = excluded.options_json,
       why = excluded.why, score = excluded.score, status = 'pending', answered_at = NULL`,
    [q.kind, q.subjectRef, q.prompt, q.options ? JSON.stringify(q.options) : null, q.why, s, now],
  );
  return true;
}

/** Generate/refresh the queue. Returns pending questions ordered by score. */
export function generateQuestions(db: DbAdapter, now = Date.now(), max = 8): Question[] {
  // One open question per subject: income_type and unknown_role both describe the same person.
  db.run(
    `UPDATE questions SET status = 'expired', answered_at = ? WHERE status = 'pending' AND id NOT IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY subject_ref ORDER BY score DESC, id) AS rn
                         FROM questions WHERE status = 'pending') WHERE rn = 1)`,
    [now],
  );
  const claimed = new Set<string>(
    db.all(`SELECT subject_ref AS s FROM questions WHERE status = 'pending'`).map((r: { s: string }) => r.s),
  );
  const claim = (s: string) => {
    if (claimed.has(s)) return false;
    claimed.add(s);
    return true;
  };

  // Till/paybill counterparts are businesses: offer the venture first. People/names get the
  // role question first; the venture prompt can follow once the role is known.
  const proposals = suggestTags(db, now, 3, 6);
  const tillProposals = proposals.filter((p) => String(p.evidence.cpKey ?? "").startsWith("t:"));
  for (const p of tillProposals) {
    const subject = `cp:${String(p.evidence.counterpartyId)}`;
    if (!claim(subject)) continue;
    upsert(db, {
      kind: "untagged_cluster", subjectRef: subject,
      prompt: `Track ${p.tag} as a venture?`,
      why: p.why, options: ["Yes, track it", "Not now"],
      total: p.totalCents, n: p.count, lastAt: now,
    }, now);
  }

  // 1. Who is this frequent counterparty?
  const unknown = db.all(
    `SELECT c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            COUNT(*) AS n, SUM(t.amount) AS total, MAX(t.occurred_at) AS lastAt
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      WHERE c.role_id IS NULL AND c.merged_into IS NULL
      GROUP BY c.id HAVING n >= 2 ORDER BY total DESC LIMIT 12`,
  );
  const seenNames = new Set<string>();
  for (const r of unknown) {
    const nameKey = normalizeName(String(r.name ?? ""));
    if (nameKey && seenNames.has(nameKey)) continue;
    if (nameKey) seenNames.add(nameKey);
    if (!claim(`cp:${r.cpId}`)) continue;
    upsert(db, {
      kind: "unknown_role", subjectRef: `cp:${r.cpId}`,
      prompt: `Who is ${r.name} to you?`,
      why: `${r.n} payments totalling ${formatKes(Number(r.total))}. Knowing the role makes your reports more accurate.`,
      options: [...SEED_ROLES], total: Number(r.total), n: Number(r.n), lastAt: Number(r.lastAt),
    }, now);
  }

  // 2. Recurring untagged counterparties: propose a venture.
  for (const p of proposals) {
    if (tillProposals.includes(p)) continue;
    if (!claim(`cp:${String(p.evidence.counterpartyId)}`)) continue;
    upsert(db, {
      kind: "untagged_cluster", subjectRef: `cp:${String(p.evidence.counterpartyId)}`,
      prompt: `Track ${p.tag} as a venture?`,
      why: p.why,
      options: ["Yes, track it", "Not now"],
      total: p.totalCents, n: p.count, lastAt: now,
    }, now);
  }

  // 3. Pending large payments.
  const pending = db.all(
    `SELECT t.id, t.amount, t.occurred_at AS at,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), t.kind) AS name
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.status = 'pending' ORDER BY t.amount DESC LIMIT 5`,
  );
  const labels = db.all(`SELECT name FROM labels WHERE status = 'active' ORDER BY name`).map((r: { name: string }) => r.name) as string[];
  for (const r of pending) {
    if (!claim(`tx:${r.id}`)) continue;
    upsert(db, {
      kind: "pending_label", subjectRef: `tx:${r.id}`,
      prompt: `What was this ${formatKes(Number(r.amount))} payment to ${r.name} for?`,
      why: `It is still unfiled, so it is missing from your category totals.`,
      options: labels.slice(0, 10), total: Number(r.amount), n: 1, lastAt: Number(r.at),
    }, now);
  }

  // 4. Income type for repeated unknown inflows.
  const inflows = db.all(
    `SELECT c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            COUNT(*) AS n, SUM(t.amount) AS total, MAX(t.occurred_at) AS lastAt
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
      WHERE t.direction = 'in' AND c.role_id IS NULL AND c.merged_into IS NULL
        AND NOT EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.tx_id = t.id AND tl.confirmed_at IS NOT NULL)
      GROUP BY c.id HAVING n >= 2 ORDER BY total DESC LIMIT 6`,
  );
  for (const r of inflows) {
    const nameKey = normalizeName(String(r.name ?? ""));
    if (nameKey && seenNames.has(nameKey)) continue;
    if (nameKey) seenNames.add(nameKey);
    if (!claim(`cp:${r.cpId}`)) continue;
    upsert(db, {
      kind: "income_type", subjectRef: `cp:${r.cpId}`,
      prompt: `Is ${r.name} a customer, an employer, or a refund?`,
      why: `${r.n} incoming payments totalling ${formatKes(Number(r.total))} are not classified.`,
      options: ["Customer", "Employer", "Refund", "Family", "Other"],
      total: Number(r.total), n: Number(r.n), lastAt: Number(r.lastAt),
    }, now);
  }

  return pendingQuestions(db, max);
}

export function pendingQuestions(db: DbAdapter, limit = 5): Question[] {
  return db.all(
    `SELECT id, kind, subject_ref, prompt, options_json, why, score, status, created_at, answered_at, answer_json
       FROM questions WHERE status = 'pending' ORDER BY score DESC, created_at DESC LIMIT ?`,
    [limit],
  ).map(mapQuestion);
}

export function allQuestions(db: DbAdapter, limit = 50): Question[] {
  return db.all(`SELECT id, kind, subject_ref, prompt, options_json, why, score, status, created_at, answered_at, answer_json FROM questions ORDER BY created_at DESC LIMIT ?`, [limit]).map(mapQuestion);
}

export interface AnswerResult { ok: boolean; applied: string; fact?: string }

/** Apply an answer to the world model. Unknown answers are stored but change nothing else. */
export function answerQuestion(db: DbAdapter, id: number, answer: string, now = Date.now()): AnswerResult {
  const q = db.get(`SELECT id, kind, subject_ref AS subjectRef, options_json AS optionsJson FROM questions WHERE id = ?`, [id]);
  if (!q) return { ok: false, applied: "question not found" };
  const answerClean = answer.trim();
  db.run(`UPDATE questions SET status = 'answered', answered_at = ?, answer_json = ? WHERE id = ?`, [now, JSON.stringify({ answer: answerClean }), id]);
  // The role/venture answer resolves every other question about the same subject.
  db.run(`UPDATE questions SET status = 'expired', answered_at = ? WHERE subject_ref = ? AND id <> ? AND status = 'pending'`, [now, q.subjectRef, id]);

  if (q.kind === "unknown_role" || q.kind === "income_type") {
    const cpId = Number(String(q.subjectRef).replace("cp:", ""));
    const roleName = roleForAnswer(answerClean, q.kind) ?? answerClean.replace(/\s+/g, " ").trim();
    if (!roleName) return { ok: false, applied: "role name is empty" };
    let role = db.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND merged_into IS NULL`, [roleName]);
    if (!role) {
      db.run(`INSERT OR IGNORE INTO roles (name, is_custom, created_at) VALUES (?, 1, ?)`, [roleName, now]);
      role = db.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND merged_into IS NULL`, [roleName]);
    }
    if (role) db.run(`UPDATE counterparties SET role_id = ? WHERE id = ?`, [role.id, cpId]);
    // One answer per person: apply it to every unroled spelling of the same name so the
    // user is never asked twice for "alex kamau" and "ALEX KAMAU" (WS0.4).
    const targetName = normalizeName(counterpartyDisplayName(db, cpId));
    if (targetName) {
      const peers = db.all(
        `SELECT id, display_name AS displayName, raw_names AS rawNames FROM counterparties
          WHERE merged_into IS NULL AND role_id IS NULL AND id <> ?`, [cpId],
      ) as Array<{ id: number; displayName: string | null; rawNames: string | null }>;
      for (const peer of peers) {
        const peerName = normalizeName(peer.displayName?.trim() || firstName(peer.rawNames));
        if (peerName === targetName && role) db.run(`UPDATE counterparties SET role_id = ? WHERE id = ?`, [role.id, peer.id]);
      }
    }
    const fact = `role=${roleName}`;
    recordFact(db, `cp:${cpId}`, "role", roleName, { confidence: 0.9, source: "user", evidence: { questionId: id, answer: answerClean } }, now);
    return { ok: true, applied: `role for counterparty ${cpId}`, fact };
  }

  if (q.kind === "untagged_cluster" || q.kind === "recurring_unowned") {
    if (!/^(yes|track|yep|sure|ok)/i.test(answerClean)) return { ok: true, applied: "left untagged" };
    const cpId = Number(String(q.subjectRef).replace("cp:", ""));
    const proposal = suggestTags(db, now, 1, 50).find((p) => Number(p.evidence.counterpartyId) === cpId);
    if (!proposal) return { ok: false, applied: "no untagged candidates remain" };
    const { tagId } = createVenture(db, proposal.tag, "business");
    for (const txId of proposal.candidateTxIds) tagTx(db, txId, proposal.tag, "cluster", 0.8);
    recordFact(db, `venture:${proposal.tag}`, "tags", String(tagId), { confidence: 0.9, source: "user", evidence: { questionId: id } }, now);
    return { ok: true, applied: `venture ${proposal.tag} with ${proposal.candidateTxIds.length} payments`, fact: `venture=${proposal.tag}` };
  }

  if (q.kind === "pending_label") {
    const txId = Number(String(q.subjectRef).replace("tx:", ""));
    const label = db.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND status = 'active'`, [answerClean]);
    if (!label) return { ok: false, applied: "answer is not a known category" };
    db.run(`UPDATE tx_labels SET confirmed_at = NULL WHERE tx_id = ? AND label_id <> ?`, [txId, label.id]);
    db.run(
      `INSERT INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at) VALUES (?, ?, 'user', 1, ?, ?)
       ON CONFLICT(tx_id, label_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, source = 'user', confidence = 1`,
      [txId, label.id, now, now],
    );
    db.run(`UPDATE transactions SET status = 'confirmed' WHERE id = ?`, [txId]);
    recordFact(db, `tx:${txId}`, "category", answerClean, { confidence: 1, source: "user", evidence: { questionId: id } }, now);
    return { ok: true, applied: `category for transaction ${txId}`, fact: `category=${answerClean}` };
  }

  return { ok: true, applied: "answer stored" };
}

function firstName(rawNames: string | null): string {
  try { return (JSON.parse(rawNames ?? "[]") as string[]).find((x) => x?.trim())?.trim() ?? ""; } catch { return ""; }
}

function counterpartyDisplayName(db: DbAdapter, cpId: number): string {
  const row = db.get(`SELECT display_name AS displayName, raw_names AS rawNames FROM counterparties WHERE id = ?`, [cpId]);
  return row?.displayName?.trim() || firstName(row?.rawNames ?? null);
}

function roleForAnswer(answer: string, kind: QuestionKind): string | null {
  const a = answer.toLowerCase();
  if (kind === "income_type") {
    if (/customer|client|buyer/.test(a)) return "customer";
    if (/employer|salary|boss/.test(a)) return "employer";
    if (/refund|reversal/.test(a)) return "self";
    if (/family/.test(a)) return "family";
    return null;
  }
  const role = SEED_ROLES.find((r) => a === r.toLowerCase() || a.includes(r.toLowerCase()));
  return role ?? null;
}

export function dismissQuestion(db: DbAdapter, id: number, now = Date.now()): void {
  db.run(`UPDATE questions SET status = 'dismissed', answered_at = ? WHERE id = ?`, [now, id]);
}
