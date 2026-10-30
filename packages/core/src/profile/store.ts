/**
 * The local world model: typed profile, durable facts, and a compact prompt context.
 * Facts are things the user confirmed (or code inferred with a confidence); they are not
 * a transcript. Z0 only unless a Z1 tool explicitly asks for an allowlisted projection.
 */
import type { DbAdapter } from "../db/migrate.js";
import type { ProfileState } from "../packs/types.js";

export interface ExtendedProfile extends ProfileState {
  name?: string;
  identityCustom?: string;
  quietFrom?: number;
  quietTo?: number;
  currency?: string;
}

interface ProfileRow { key: string; value: string }

function readRaw(db: DbAdapter): Map<string, string> {
  const rows = db.all(`SELECT key, value FROM profile`) as ProfileRow[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

export function getProfile(db: DbAdapter): ExtendedProfile {
  const m = readRaw(db);
  let verticals: string[] = [];
  try { verticals = JSON.parse(m.get("verticals") ?? "[]") as string[]; } catch { verticals = []; }
  return {
    verticals,
    tone: m.get("tone") ?? "plain",
    language: m.get("language") ?? "en",
    updatedAt: Number(m.get("updated_at") ?? 0),
    name: m.get("name"),
    identityCustom: m.get("identity_custom") || undefined,
    quietFrom: m.has("quiet_from") ? Number(m.get("quiet_from")) : undefined,
    quietTo: m.has("quiet_to") ? Number(m.get("quiet_to")) : undefined,
    currency: m.get("currency") ?? "KES",
  };
}

export function setProfile(db: DbAdapter, patch: Partial<ExtendedProfile>, now = Date.now()): ExtendedProfile {
  const map: Record<string, string | undefined> = {
    verticals: patch.verticals ? JSON.stringify(patch.verticals) : undefined,
    tone: patch.tone,
    language: patch.language,
    name: patch.name,
    identity_custom: patch.identityCustom,
    quiet_from: patch.quietFrom != null ? String(patch.quietFrom) : undefined,
    quiet_to: patch.quietTo != null ? String(patch.quietTo) : undefined,
    currency: patch.currency,
    updated_at: String(now),
  };
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) continue;
    db.run(`INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [k, v, now]);
  }
  return getProfile(db);
}

export function getSetting(db: DbAdapter, key: string, fallback = ""): string {
  const row = db.get(`SELECT value FROM profile WHERE key = ?`, [key]);
  return row?.value ?? fallback;
}

export function setSetting(db: DbAdapter, key: string, value: string, now = Date.now()): void {
  db.run(`INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value, now]);
}

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  evidence: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export function recordFact(db: DbAdapter, subject: string, predicate: string, object: string, opts: { confidence?: number; source?: string; evidence?: Record<string, unknown> } = {}, now = Date.now()): number {
  db.run(
    `INSERT INTO facts (subject, predicate, object, confidence, source, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject, predicate, object) DO UPDATE SET confidence = excluded.confidence,
       source = excluded.source, evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`,
    [subject, predicate, object, opts.confidence ?? 0.8, opts.source ?? "user", JSON.stringify(opts.evidence ?? {}), now, now],
  );
  const row: { id: number } | undefined = db.get(`SELECT id FROM facts WHERE subject = ? AND predicate = ? AND object = ?`, [subject, predicate, object]);
  return Number(row?.id ?? 0);
}

export function factsFor(db: DbAdapter, subject?: string): Fact[] {
  return db.all(
    `SELECT id, subject, predicate, object, confidence, source, evidence_json AS evidence, created_at AS createdAt, updated_at AS updatedAt
       FROM facts ${subject ? "WHERE subject = ?" : ""} ORDER BY updated_at DESC, id DESC`,
    subject ? [subject] : [],
  ).map((r: any) => {
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(r.evidence ?? "{}"); } catch { evidence = {}; }
    return { ...r, evidence, confidence: Number(r.confidence), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) };
  });
}

export function deleteFact(db: DbAdapter, id: number): void {
  db.run(`DELETE FROM facts WHERE id = ?`, [id]);
}

export interface WorldModel {
  profile: ExtendedProfile;
  facts: Fact[];
  ventures: Array<{ name: string; kind: string; netCents: number; txCount: number }>;
  counterparties: Array<{ name: string; role: string | null; n: number }>;
  labels: string[];
}

export function loadWorldModel(db: DbAdapter): WorldModel {
  const profile = getProfile(db);
  const facts = factsFor(db);
  const ventures: WorldModel["ventures"] = db.all(
    `SELECT v.name, v.kind,
            (SELECT COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount - COALESCE(t.fee,0) END),0)
               FROM tx_tags tt JOIN tx_events t ON t.id = tt.tx_id WHERE tt.tag_id = v.tag_id) AS netCents,
            (SELECT COUNT(*) FROM tx_tags tt WHERE tt.tag_id = v.tag_id) AS txCount
       FROM ventures v WHERE v.status = 'active' ORDER BY netCents DESC`,
  );
  const counterparties: WorldModel["counterparties"] = db.all(
    `SELECT COALESCE(c.display_name, json_extract(c.raw_names, '$[0]'), 'Unknown') AS name,
            r.name AS role, COUNT(*) AS n
       FROM tx_events t JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN roles r ON r.id = c.role_id
      GROUP BY c.id ORDER BY n DESC LIMIT 30`,
  );
  const labels = db.all(`SELECT name FROM labels WHERE status = 'active' ORDER BY name`).map((r: { name: string }) => r.name);
  return { profile, facts, ventures, counterparties, labels };
}

/** Compact, token-budgeted context for a Z0 prompt. No SMS bodies, no raw ids. */
export function worldModelPrompt(db: DbAdapter): string {
  const w = loadWorldModel(db);
  const bits: string[] = [];
  if (w.profile.name) bits.push(`Name: ${w.profile.name}`);
  if (w.profile.identityCustom) bits.push(`Occupation (user's own words): ${w.profile.identityCustom}`);
  if (w.profile.verticals.length) bits.push(`Occupation packs: ${w.profile.verticals.join(", ")}`);
  bits.push(`Tone: ${w.profile.tone}; language: ${w.profile.language}`);
  if (w.facts.length) bits.push(`Known facts: ${w.facts.slice(0, 12).map((f) => `${f.predicate}=${f.object}`).join("; ")}`);
  if (w.ventures.length) bits.push(`Ventures: ${w.ventures.slice(0, 8).map((v) => `${v.name} (${v.kind}, ${v.txCount} payments)`).join("; ")}`);
  const roles = w.counterparties.filter((c) => c.role).slice(0, 10);
  if (roles.length) bits.push(`People/merchants: ${roles.map((c) => `${c.name} (${c.role}, ${c.n})`).join("; ")}`);
  return bits.join("\n").slice(0, 1200);
}
