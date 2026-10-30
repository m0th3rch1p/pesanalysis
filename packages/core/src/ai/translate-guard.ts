/**
 * Translation guard (F-QVAC feature 2: Swahili/Sheng in and out). A translation model must never
 * see, alter, or invent a number. Flow:
 *   1. `maskEntities(source)`       digits, KES amounts, dates, times, phone numbers and ref codes
 *                                   become opaque placeholders `[[E1]]`, `[[E2]]`, ...
 *   2. model translates the masked text
 *   3. `restoreEntities(out, ents)` placeholders are replaced by the ORIGINAL strings
 *   4. `verifyTranslation(...)`     fails if any source number is missing or invented, if a
 *                                   placeholder was dropped/duplicated/invented, or if the output
 *                                   contains links.
 * Pure functions, no I/O.
 */
import type { Verdict } from "./sms-validate.js";

export type EntityKind = "phone" | "ref" | "date" | "time" | "amount" | "number";
export interface MaskedEntity { id: number; kind: EntityKind; text: string }
export interface MaskResult { masked: string; entities: MaskedEntity[] }

// Order matters: earlier patterns claim their span first, so a phone number is never split into
// "digit groups" and a dd/mm/yy date is never read as three small numbers.
const PATTERNS: Array<{ kind: EntityKind; re: RegExp }> = [
  { kind: "phone", re: /(?<![\w+])(?:\+?254[ -]?|0)[17]\d{2}[ -]?\d{3}[ -]?\d{3}(?!\d)/g },
  { kind: "date", re: /(?<![\d/.-])\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?![\d])|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g },
  { kind: "time", re: /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?(?![\d:])/g },
  { kind: "amount", re: /(?:KES|Ksh|KSh|KSH|Kshs|Sh)\.?\s?\d[\d,.\u00A0\u202F]*\d|(?:KES|Ksh|KSh|KSH|Kshs|Sh)\.?\s?\d/g },
  // Provider reference codes: uppercase alphanumerics with at least one letter AND one digit.
  { kind: "ref", re: /(?<![A-Za-z0-9])(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8,12}(?![A-Za-z0-9])/g },
  { kind: "number", re: /\d+(?:[.,]\d+)*%?/g },
];

/**
 * Placeholders are LETTER-ONLY (`[[EA]]`, `[[EB]]`, ... `[[EAA]]`), so a masked text contains no digit
 * at all: the model has nothing numeric to copy wrongly, and "no digit survives masking" is testable.
 */
export function placeholderLetters(id: number): string {
  let n = id, out = "";
  while (n > 0) { n -= 1; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}
export function placeholderId(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export const PLACEHOLDER = (id: number): string => `[[E${placeholderLetters(id)}]]`;
const PLACEHOLDER_RE = /\[\s*\[\s*E\s*([A-Za-z]+)\s*\]\s*\]/gi;

export function maskEntities(source: string): MaskResult {
  const taken: Array<{ start: number; end: number; kind: EntityKind }> = [];
  const overlaps = (s: number, e: number) => taken.some((t) => s < t.end && e > t.start);
  for (const { kind, re } of PATTERNS) {
    for (const m of source.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!overlaps(start, end)) taken.push({ start, end, kind });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  let out = "";
  let cur = 0;
  const entities: MaskedEntity[] = [];
  for (const t of taken) {
    const id = entities.length + 1;
    out += source.slice(cur, t.start) + PLACEHOLDER(id);
    entities.push({ id, kind: t.kind, text: source.slice(t.start, t.end) });
    cur = t.end;
  }
  out += source.slice(cur);
  return { masked: out, entities };
}

export interface RestoreResult {
  text: string;
  /** Placeholder ids that were in the source but absent from the model output. */
  missing: number[];
  /** Placeholder ids the model emitted more than once. */
  duplicated: number[];
  /** Placeholder ids that were never issued. */
  invented: number[];
}

export function restoreEntities(translated: string, entities: readonly MaskedEntity[]): RestoreResult {
  const byId = new Map(entities.map((e) => [e.id, e.text]));
  const seen = new Map<number, number>();
  const invented: number[] = [];
  const text = translated.replace(PLACEHOLDER_RE, (_m, d: string) => {
    const id = placeholderId(d);
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const orig = byId.get(id);
    if (orig === undefined) { invented.push(id); return ""; }
    return orig;
  });
  return {
    text,
    missing: entities.filter((e) => !seen.has(e.id)).map((e) => e.id),
    duplicated: [...seen.entries()].filter(([id, n]) => n > 1 && byId.has(id)).map(([id]) => id),
    invented,
  };
}

/** Canonical numeric tokens: separators joined, so "2,705" == "2.705" == "2 705" == "2705". Decimals kept. */
export function numericTokens(s: string): string[] {
  const joined = s.replace(/(\d)[,.\u00A0\u202F ](?=\d{3}(?:\D|$))/g, "$1");
  return (joined.match(/\d+(?:\.\d+)?/g) ?? []).map(normaliseToken);
}
function normaliseToken(t: string): string {
  // Keep leading zeros (phone numbers/refs): only canonicalise pure decimals like "500.00" -> "500".
  if (/^\d+\.\d+$/.test(t)) {
    const [i, f] = t.split(".") as [string, string];
    const frac = f.replace(/0+$/, "");
    return frac ? `${i}.${frac}` : i;
  }
  return t;
}

function multiset(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

export interface VerifyOptions {
  /** When set, also verifies the restore result (no dropped / duplicated / invented placeholders). */
  restore?: RestoreResult;
  /** Require numbers to appear in the same order as the source (guards amount/role swaps). Default false. */
  strictOrder?: boolean;
}

/**
 * Verify a FINAL (restored) translation against its source. Fails on any missing or invented
 * number, leftover placeholders, links, or empty output.
 */
export function verifyTranslation(source: string, output: string, opts: VerifyOptions = {}): Verdict {
  const reasons: string[] = [];
  if (typeof output !== "string" || output.trim().length === 0) return { accepted: false, reasons: ["empty_output"] };
  if (/\[\s*\[\s*E\s*[A-Za-z]*\s*\]\s*\]/i.test(output)) reasons.push("unrestored_placeholder");
  if (/https?:\/\/|www\./i.test(output) && !/https?:\/\/|www\./i.test(source)) reasons.push("invented_link");
  if (opts.restore) {
    if (opts.restore.missing.length) reasons.push(`placeholder_missing:${opts.restore.missing.join(",")}`);
    if (opts.restore.duplicated.length) reasons.push(`placeholder_duplicated:${opts.restore.duplicated.join(",")}`);
    if (opts.restore.invented.length) reasons.push(`placeholder_invented:${opts.restore.invented.join(",")}`);
  }
  const src = numericTokens(source);
  const out = numericTokens(output);
  const sm = multiset(src), om = multiset(out);
  const missing: string[] = [], invented: string[] = [];
  for (const [t, n] of sm) if ((om.get(t) ?? 0) < n) missing.push(t);
  for (const [t, n] of om) if ((sm.get(t) ?? 0) < n) invented.push(t);
  if (missing.length) reasons.push(`number_missing:${missing.slice(0, 5).join(",")}`);
  if (invented.length) reasons.push(`number_invented:${invented.slice(0, 5).join(",")}`);
  if (opts.strictOrder && !missing.length && !invented.length && src.join("|") !== out.join("|")) reasons.push("number_order_changed");
  return { accepted: reasons.length === 0, reasons };
}

/** Convenience: mask, translate via the supplied function, restore, verify. Never throws. */
export async function guardedTranslate(
  source: string,
  translate: (masked: string) => Promise<string>,
  opts: { strictOrder?: boolean } = {},
): Promise<{ text: string | null; verdict: Verdict }> {
  const { masked, entities } = maskEntities(source);
  let raw: string;
  try { raw = await translate(masked); } catch (e) { return { text: null, verdict: { accepted: false, reasons: [`translate_failed:${String(e).slice(0, 80)}`] } }; }
  const restored = restoreEntities(String(raw ?? ""), entities);
  const verdict = verifyTranslation(source, restored.text, { restore: restored, strictOrder: opts.strictOrder });
  return { text: verdict.accepted ? restored.text : null, verdict };
}
