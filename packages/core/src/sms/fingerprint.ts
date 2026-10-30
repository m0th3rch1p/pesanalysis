/**
 * Structural fingerprint of an SMS body. Safe(ish) to share/log: carries template shape, not identities.
 * Design: mask digits and NAME-like runs, but PRESERVE template tokens (Confirmed, Fuliza, M-PESA casing,
 * Ksh/Sh/TZS prefixes, dashes, "on d/m/y at", PM/AM) so templates can be written without reading bodies.
 */
export function fingerprint(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .replace(/M-?[Pp][Ee][Ss][Aa]/g, "\u00a7MP\u00a7")
    .replace(/(?:Ksh|Sh|KES|TZSH?)\s?[\d,]+(?:\.\d+)?/gi, "AMT")
    .replace(/\b[A-Z0-9]{10}\b/g, "REF")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "9/9/9")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?[AaPp][Mm]?\b/g, "9:9")
    .replace(/(?:\+?254|0)(?:7|1)\d{8}|\b[\d*+]{7,15}\b/g, "ID")
    .replace(/\b[A-Z]{2,}(?:\s[A-Z0-9][A-Z0-9.&'-]*)*\b/g, (m) => (/^(AMT|REF|ID|OK|YES|NO|PM|AM|KSH|API)$/.test(m) ? m : "NAME"))
    .replace(/\d+/g, "9")
    .replace(/\u00a7MP\u00a7/g, "M-PESA")
    .slice(0, 220);
}
