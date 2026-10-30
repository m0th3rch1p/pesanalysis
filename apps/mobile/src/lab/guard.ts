/**
 * Numeric/entity preservation guard for machine translation (pure, no QVAC import).
 *
 *  numericTokens(s): every digit sequence incl. separators (1,450.00  12/10/2026  4:10  0700000555  7.5) and every
 *                    alphanumeric reference containing a digit (QXA1B2C3D4, HOUSE-A12).
 *  preservation():   STRICT = the multiset of tokens is unchanged; DIGITS = same digits after dropping separators.
 *  maskForTranslation()/unmask(): replace each token with a placeholder before translating, restore afterwards;
 *                    unmask() returns ok=false (fail closed) if any placeholder is missing, duplicated or invented.
 */
export const TOKEN_RE = /(?:(?:KES|Ksh|KSh|Ksh\.|KSH)\s?)?\d[\d,.:/]*\d(?:%)?|(?:KES|Ksh|KSh|KSH)\s?\d|\d%?|\b[A-Z]{1,6}[A-Z0-9-]*\d[A-Z0-9-]*\b/g;

/** Bare numeric/alnum parts only, currency prefix stripped (what must survive). */
export function numericTokens(s: string): string[] {
  const out: string[] = [];
  const re = /\d[\d,.:/]*\d%?|\d%?|\b[A-Z]{1,6}[A-Z0-9-]*\d[A-Z0-9-]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(trimEnd(m[0]));
  return out;
}
const trimEnd = (t: string) => t.replace(/[.,:/]+$/, "");

const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
export function sameMultiset(a: string[], b: string[]): boolean {
  const A = count(a), B = count(b);
  if (A.size !== B.size) return false;
  for (const [k, v] of A) if (B.get(k) !== v) return false;
  return true;
}
const digitsOnly = (t: string) => t.replace(/[^0-9A-Za-z]/g, "");

export interface Preservation { strict: boolean; digits: boolean; missing: string[]; extra: string[]; src: string[]; out: string[] }
export function preservation(src: string, out: string): Preservation {
  const a = numericTokens(src), b = numericTokens(out);
  const ca = count(a), cb = count(b);
  const missing: string[] = [], extra: string[] = [];
  for (const [k, v] of ca) if ((cb.get(k) ?? 0) < v) missing.push(k);
  for (const [k, v] of cb) if ((ca.get(k) ?? 0) < v) extra.push(k);
  return { strict: sameMultiset(a, b), digits: sameMultiset(a.map(digitsOnly), b.map(digitsOnly)), missing, extra, src: a, out: b };
}

export type PlaceholderStyle = "sq" | "brace" | "hash";
const wrap = (style: PlaceholderStyle, i: number) => style === "sq" ? `[${i}]` : style === "brace" ? `{{${i}}}` : `#${i}#`;
const unwrapRe = (style: PlaceholderStyle) => style === "sq" ? /\[\s*(\d+)\s*\]/g : style === "brace" ? /\{\{\s*(\d+)\s*\}\}/g : /#\s*(\d+)\s*#/g;

export interface Masked { text: string; tokens: string[]; style: PlaceholderStyle }
export function maskForTranslation(s: string, style: PlaceholderStyle): Masked {
  const tokens: string[] = [];
  const text = s.replace(TOKEN_RE, (m) => {
    // keep the currency word in the sentence, mask only the number
    const cur = /^(KES|Ksh\.?|KSh|KSH)\s?/.exec(m);
    const body = cur ? m.slice(cur[0].length) : m;
    if (!body) return m;
    tokens.push(trimEnd(body));
    return (cur ? cur[0] : "") + wrap(style, tokens.length) + (/[.,:/]$/.test(body) ? body.slice(-1) : "");
  });
  return { text, tokens, style };
}
export function unmask(out: string, m: Masked): { ok: boolean; text: string; reason?: string } {
  const seen = new Map<number, number>();
  const text = out.replace(unwrapRe(m.style), (full, d) => {
    const i = Number(d);
    seen.set(i, (seen.get(i) ?? 0) + 1);
    return i >= 1 && i <= m.tokens.length ? m.tokens[i - 1] : full;
  });
  for (let i = 1; i <= m.tokens.length; i++) {
    const c = seen.get(i) ?? 0;
    if (c === 0) return { ok: false, text, reason: `placeholder ${i} missing` };
    if (c > 1) return { ok: false, text, reason: `placeholder ${i} duplicated` };
  }
  for (const i of seen.keys()) if (i < 1 || i > m.tokens.length) return { ok: false, text, reason: `invented placeholder ${i}` };
  return { ok: true, text };
}
