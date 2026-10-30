/** "This is fine" learning keyed by alert kind + sender suffix; never keyed by message text. */
import type { DbAdapter } from "../db/migrate.js";

const KEY = "security_fine_patterns_v1";
export interface FinePattern { kind: string; sender: string; at: number }

export function loadFinePatterns(db: DbAdapter): FinePattern[] {
  try {
    const row = db.get(`SELECT value FROM meta WHERE key = ?`, [KEY]) as { value?: string } | undefined;
    const parsed = JSON.parse(row?.value ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is FinePattern => !!p && typeof p === "object"
      && typeof (p as FinePattern).kind === "string" && typeof (p as FinePattern).sender === "string");
  } catch { return []; }
}

function senderKey(sender: string): string {
  const d = sender.replace(/\D/g, "");
  return d.length >= 3 ? d.slice(-3) : sender.trim().toLowerCase();
}

export function isFinePattern(db: DbAdapter, kind: string, sender: string): boolean {
  const k = senderKey(sender);
  return loadFinePatterns(db).some((p) => p.kind === kind && senderKey(p.sender) === k);
}

export function addFinePattern(db: DbAdapter, kind: string, sender: string, now = Date.now()): void {
  const rows = loadFinePatterns(db).filter((p) => !(p.kind === kind && senderKey(p.sender) === senderKey(sender)));
  rows.push({ kind, sender: senderKey(sender), at: now });
  db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(rows.slice(-200))]);
}
