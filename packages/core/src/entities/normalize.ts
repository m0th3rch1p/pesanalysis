/**
 * Counterparty entity resolution: many raw spellings -> one stable key.
 * Key forms: "p:254712345678" (phone), "m:254712***678:jane_doe" (masked phone + 2-token name),
 * "t:123456" (till/paybill), "n:slug" (name). Safaricom masks 3-4 middle digits; dropping
 * them collapsed every "JOHN KAMAU" into one entity. The masked composite keeps the visible
 * prefix/suffix and the name, and can be linked to a full local contact later.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.normalize("NFKC").replace(/[^0-9+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("0")) s = "254" + s.slice(1);
  // Kenyan mobiles/landlines end up as 254 + 9 digits
  if (/^254\d{7,12}$/.test(s)) return s;
  if (/^\d{9,12}$/.test(s)) return "254" + s.replace(/^254/, "").replace(/^0/, "");
  return null;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // NFKC collapses full-width/compatibility forms before case-folding, so "ＡＣＭＥ" and
  // "acme" land on one key. Collapse every whitespace class, not only ASCII spaces.
  const s = raw.normalize("NFKC").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

/** First two tokens are stable in masked M-PESA customer names (Safaricom trims to 2 words). */
export function nameKey(raw: string | null | undefined): string | null {
  const n = normalizeName(raw);
  if (!n) return null;
  return n.split(" ").slice(0, 2).join("_");
}

/**
 * Safaricom/Airtel masked MSISDN -> canonical "254712***678".
 * Accepts 0712***678, +254712***678, 254712***678, 0722***999.
 */
export function parseMaskedPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").trim().replace(/[\s-]/g, "");
  const m = /^(?:\+?254|0)([17]\d{2,3})\*{2,5}(\d{2,4})$/.exec(s);
  if (!m) return null;
  return `254${m[1]}***${m[2]}`;
}

function phoneParts(p: string): { prefix: string; suffix: string } | null {
  const m = /^254(\d{3})\*{2,5}(\d{3})$/.exec(p);
  return m ? { prefix: m[1]!, suffix: m[2]! } : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Fellegi-Sunter-style link between a masked SMS counterparty and an unmasked local
 * contact/historical phone. Prefix + suffix must agree; the name must be similar.
 */
export function canLinkMaskedToFull(
  maskedKey: string,
  fullPhone: string | null | undefined,
  fullName: string | null | undefined,
  opts: { minNameSimilarity?: number } = {},
): boolean {
  const mm = /^m:(254\d{3}\*{2,5}\d{3})(?::(.+))?$/.exec(maskedKey);
  if (!mm) return false;
  const parts = phoneParts(mm[1]!);
  const ph = normalizePhone(fullPhone);
  if (!parts || !ph || ph.length < 12) return false;
  if (!ph.startsWith(`254${parts.prefix}`) || !ph.endsWith(parts.suffix)) return false;
  const keyedName = mm[2]?.replace(/_/g, " ") ?? null;
  if (!keyedName && !fullName) return true;
  return nameSimilarity(keyedName, fullName) >= (opts.minNameSimilarity ?? 0.85);
}

const PHONE_RE = /^(?:\+?254|0)?(?:7|1)\d{8}$/;

export function counterpartyKey(rawId: string | null | undefined, rawName: string | null | undefined): string | null {
  const masked = parseMaskedPhone(rawId);
  if (masked) {
    const nk = nameKey(rawName);
    return nk ? `m:${masked}:${nk}` : `m:${masked}`;
  }
  const ph = normalizePhone(rawId);
  if (ph) return `p:${ph}`;
  const digits = rawId?.replace(/[^0-9]/g, "");
  if (digits && digits.length >= 5 && !rawName?.toLowerCase().includes("fuliza") && !rawName?.toLowerCase().includes("okoa")) return `t:${digits}`;
  const n = normalizeName((rawId?.length ?? 0) > (rawName?.length ?? 0) ? rawId : rawName);
  return n ? `n:${n}` : null;
}

/** Display name: prefer the longest raw spelling seen (usually the most complete). */
export function bestDisplayName(prev: string | null, next: string | null): string | null {
  if (!prev) return next;
  if (!next) return prev;
  return next.length > prev.length ? next : prev;
}
