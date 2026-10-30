/**
 * Deterministic receipt text parser for Kenyan till slips (F-QVAC stretch: receipt OCR into
 * attachment metadata). Input is OCR text lines; the model/OCR never decides amounts, rules do.
 * Output carries a confidence and the evidence lines for every field so the UI can show
 * "we read 1,250.00 from: TOTAL 1,250.00" and the user can correct it. Amounts are integer cents.
 */

export interface OcrLine { text: string; confidence?: number }
export interface Evidence { line: number; text: string }
export interface Field<T> { value: T; confidence: number; evidence: Evidence[] }
export interface VatLine { rate: number | null; amountCents: number; confidence: number; evidence: Evidence[] }
export interface ReceiptLineItem { name: string; qty: number; amountCents: number; unitCents: number; confidence: number; evidence: Evidence[] }

export interface ParsedReceipt {
  totalCents: Field<number> | null;
  merchant: Field<string> | null;
  /** ISO yyyy-mm-dd (as printed, dd/mm order assumed). */
  date: Field<string> | null;
  time: Field<string> | null;
  vat: VatLine[];
  kraPin: Field<string> | null;
  etrSerial: Field<string> | null;
  tillNo: Field<string> | null;
  tenderedCents: Field<number> | null;
  changeCents: Field<number> | null;
  /** Purchased lines, when the slip prints them. Amounts are line totals, not unit prices. */
  items: ReceiptLineItem[];
  warnings: string[];
}

const AMT = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d]|,\d)/g;
const PERCENT = /\d{1,2}(?:\.\d+)?\s*%/g;

const TOTAL_KEY = /\b(?:grand\s*total|total\s*due|amount\s*due|total\s*amount|total\s*payable|amount\s*payable|net\s*total|amt\s*due|balance\s*due|total)\b/i;
const STRONG_TOTAL = /\b(?:grand\s*total|total\s*due|amount\s*due|total\s*payable|amount\s*payable|amt\s*due)\b/i;
const NOT_TOTAL = /\b(?:sub\s*-?\s*total|total\s*(?:vat|tax|items?|qty|quantity|savings?|discount|points?|lines?)|vat\s*total|tax\s*total|items?\s*total|no\.?\s*of\s*items?|discount|change|chg|cash|tender(?:ed)?|paid|mpesa|m-pesa|card|visa|rounding|points?|saving)\b/i;
const CHANGE_KEY = /\b(?:change|chg|balance\s*returned)\b/i;
const TENDER_KEY = /\b(?:cash(?:\s*(?:given|tendered|paid))?|tender(?:ed)?|amount\s*paid|amt\s*paid|paid|mpesa|m-pesa|card|visa)\b/i;
const VAT_KEY = /\b(?:vat|v\.a\.t|tax)\b/i;
const VAT_IDENT = /\b(?:vat|tax)\s*(?:no|reg|number|pin|id)\b|\bpin\b|\bkra\b/i;

const TOTAL_ALL_KEYS_NOT = /\b(?:sub\s*-?\s*total)\b/i;

function amountsIn(line: string): number[] {
  const stripped = line.replace(PERCENT, " ");
  const out: number[] = [];
  for (const m of stripped.matchAll(AMT)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0 && v < 100_000_000) out.push(Math.round(v * 100));
  }
  return out;
}
/** A line that is only an amount (with optional currency marker): OCR often splits "TOTAL" / "1,250.00". */
function isAmountOnly(line: string): boolean {
  return /^\s*(?:kes|ksh|ksh\.|kshs|sh)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*(?:\/=)?\s*$/i.test(line);
}

const clamp = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

function dateFrom(line: string): { iso: string; plain: boolean } | null {
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const valid = (y: number, mo: number, d: number) => {
    if (y < 2000 || y > 2099) return null;
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d])/.exec(line);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const iso = valid(y, Number(m[2]), Number(m[1]));
    if (iso) return { iso, plain: true };
  }
  m = /(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(line);
  if (m) { const iso = valid(Number(m[1]), Number(m[2]), Number(m[3])); if (iso) return { iso, plain: true }; }
  m = /(?<![\d])(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4}|\d{2})(?![\d])/.exec(line);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const iso = mo ? valid(y, mo, Number(m[1])) : null;
    if (iso) return { iso, plain: true };
  }
  return null;
}

const BOILERPLATE = /\b(?:receipt|invoice|tax\s*invoice|cash\s*sale|tel|telephone|phone|p\.?\s*o\.?\s*box|welcome|thank|customer\s*copy|duplicate|copy|pin|vat|kra|etr|date|time|till|served|cashier|order|no\.?|branch|www|http|email|@)\b/i;
const BIZ_HINT = /\b(?:ltd|limited|supermarket|stores?|pharmacy|hotel|restaurant|cafe|petrol|station|hardware|butchery|wholesalers?|mart|shop|enterprises?|agencies|kitchen|bakery|chemist|mini\s*market|co\.?)\b/i;
const PRODUCT_HINT = /\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|ltr|litres?|liters?|pcs?|pieces?|packs?|x)\b/i;

const normLine = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const lineKey = (l: OcrLine) => `${normLine(l.text)}|${(amountsIn(l.text).at(-1) ?? 0)}`;

/**
 * Merge OCR blocks from 1-4 receipt photos. Overlapping boundary lines
 * (same normalised text and same last amount) are dropped once; repeated lines inside
 * one photo are preserved. Photos may be supplied top-first or bottom-first: a matching
 * suffix/prefix overlap is stitched in either direction so attach order is not brittle.
 */
export function mergeOcrLines(photos: ReadonlyArray<ReadonlyArray<string | OcrLine>>): OcrLine[] {
  const out: OcrLine[] = [];
  for (const photo of photos) {
    const lines: OcrLine[] = photo.map((l) => {
      const o = typeof l === "string" ? { text: l } : l;
      return { text: String(o.text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(), ...(o.confidence != null ? { confidence: o.confidence } : {}) };
    }).filter((l) => l.text);
    if (!lines.length) continue;
    if (out.length === lines.length && out.every((l, i) => lineKey(l) === lineKey(lines[i]!))) continue;

    let best = 0;
    let mode: "append" | "prepend" | null = null;
    const max = Math.min(5, lines.length, out.length);
    for (let k = max; k >= 1; k--) {
      const tailOut = out.slice(out.length - k).map(lineKey).join("\u0000");
      const headLines = lines.slice(0, k).map(lineKey).join("\u0000");
      if (tailOut === headLines && k > best) { best = k; mode = "append"; }
      const tailLines = lines.slice(lines.length - k).map(lineKey).join("\u0000");
      const headOut = out.slice(0, k).map(lineKey).join("\u0000");
      if (tailLines === headOut && k > best) { best = k; mode = "prepend"; }
    }
    if (mode === "append") out.push(...lines.slice(best));
    else if (mode === "prepend") out.unshift(...lines.slice(0, lines.length - best));
    else out.push(...lines);
  }
  return out;
}

const ITEM_SKIP = /\b(?:total|subtotal|sub\s*-?\s*total|vat|tax|change|tender(?:ed)?|cash|mpesa|m-pesa|card|visa|rounding|discount|savings?|points?|balance|customer|receipt|invoice|date|time|cashier|served|order|till|pin|kra|etr|welcome|thank|tel|phone)\b/i;
const TRAILING_AMOUNT = /(?:kes|ksh\.?|kshs)?\s*(?<![A-Za-z])(?:([\d]{1,3}(?:,[\d]{3})+)|\d+)(?:\.(\d{1,2}))?\s*(?:\/=)?\s*$/i;

function itemName(raw: string): { name: string; qty: number } | null {
  let s = raw.replace(/\s+/g, " ").trim().replace(/^[•*\-]+\s*/, "");
  let qty = 1;
  const lead = /^(\d{1,3})\s*[xX@]\s*/.exec(s);
  if (lead) { qty = Number(lead[1]); s = s.slice(lead[0].length); }
  const tail = /\s+[xX]\s*(\d{1,3})\s*$/.exec(s);
  if (tail) { qty = Number(tail[1]); s = s.slice(0, tail.index); }
  s = s.replace(/\s+@\s*[\d,.]+\s*$/i, "").trim();
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < 2 || s.length > 60 || !/^[\p{L}\p{N} &'./-]+$/u.test(s)) return null;
  return { name: s, qty: Math.max(1, qty) };
}

export function extractReceiptItems(input: ReadonlyArray<string | OcrLine>): ReceiptLineItem[] {
  const lines = input.map((l, i) => {
    const o = typeof l === "string" ? { text: l } : l;
    return { i, text: String(o.text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(), conf: o.confidence };
  });
  const out: ReceiptLineItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.text || isAmountOnly(l.text) || ITEM_SKIP.test(l.text) || dateFrom(l.text) || TOTAL_KEY.test(l.text)) continue;
    let amount: number | null = null;
    let ids = [l.i];
    let namePart = l.text;
    const m = TRAILING_AMOUNT.exec(l.text);
    if (m && /[\p{L}]/u.test(l.text.slice(0, m.index))) {
      const num = m[0].replace(/[^\d.,]/g, "").replace(/,/g, "");
      const v = Number(num);
      if (Number.isFinite(v) && v > 0 && v < 10_000_000) amount = Math.round(v * 100);
      namePart = l.text.slice(0, m.index);
    } else {
      const next = lines[i + 1];
      if (next && isAmountOnly(next.text) && /[\p{L}]{2}/u.test(l.text) && !ITEM_SKIP.test(l.text)) {
        const a = amountsIn(next.text);
        if (a.length) { amount = a[a.length - 1]!; ids = [l.i, next.i]; i++; }
      }
    }
    if (amount == null) continue;
    const parsed = itemName(namePart);
    if (!parsed) continue;
    const conf = Math.min(1, Math.max(0, Math.min(...ids.map((x) => lines[x]!.conf ?? 1))));
    out.push({ name: parsed.name, qty: parsed.qty, amountCents: amount, unitCents: Math.round(amount / parsed.qty), confidence: conf, evidence: ids.map((x) => ({ line: x, text: lines[x]!.text })) });
  }
  return out;
}

export function parseReceipt(input: ReadonlyArray<string | OcrLine>, opts: { now?: number } = {}): ParsedReceipt {
  const lines = input.map((l, i) => {
    const o = typeof l === "string" ? { text: l } : l;
    return { i, text: String(o.text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(), conf: o.confidence };
  });
  const ev = (...idx: number[]): Evidence[] => idx.map((i) => ({ line: i, text: lines[i]!.text }));
  const ocr = (...idx: number[]): number => {
    const cs = idx.map((i) => lines[i]!.conf).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
    return cs.length ? Math.max(0, Math.min(1, Math.min(...cs))) : 1;
  };
  const warnings: string[] = [];

  // ---- change / tendered ----
  let change: ParsedReceipt["changeCents"] = null;
  let tendered: ParsedReceipt["tenderedCents"] = null;
  for (const l of lines) {
    if (!l.text) continue;
    const next = lines[l.i + 1];
    const amts = amountsIn(l.text);
    const ids = [l.i];
    if (!amts.length && next && isAmountOnly(next.text)) { amts.push(...amountsIn(next.text)); ids.push(next.i); }
    if (!amts.length) continue;
    const v = amts[amts.length - 1]!;
    if (CHANGE_KEY.test(l.text) && !change) change = { value: v, confidence: clamp(0.9 * ocr(...ids)), evidence: ev(...ids) };
    else if (TENDER_KEY.test(l.text) && !TOTAL_KEY.test(l.text) && !CHANGE_KEY.test(l.text) && !tendered) {
      tendered = { value: v, confidence: clamp(0.85 * ocr(...ids)), evidence: ev(...ids) };
    }
  }

  // ---- total ----
  interface Cand { cents: number; strong: boolean; nextLine: boolean; ids: number[] }
  const cands: Cand[] = [];
  for (const l of lines) {
    if (!l.text) continue;
    if (!TOTAL_KEY.test(l.text) || TOTAL_ALL_KEYS_NOT.test(l.text)) continue;
    // Exclusion applies to the text with the matched total phrase removed, so "TOTAL" alone passes but "TOTAL VAT" / "CASH" do not.
    if (NOT_TOTAL.test(l.text) && !STRONG_TOTAL.test(l.text)) continue;
    if (/\b(?:change|chg|cash|tender(?:ed)?|paid)\b/i.test(l.text) && !/\b(?:grand\s*total|total\s*due|amount\s*due|total\s*payable)\b/i.test(l.text)) continue;
    let amts = amountsIn(l.text);
    const ids = [l.i];
    let nextLine = false;
    if (!amts.length) {
      const next = lines[l.i + 1];
      if (next && isAmountOnly(next.text)) { amts = amountsIn(next.text); ids.push(next.i); nextLine = true; }
      else { warnings.push(`total_line_without_amount:${l.i}`); continue; }
    }
    // For "TOTAL 3 ITEMS 1,250.00" style lines the amount is the last number.
    cands.push({ cents: amts[amts.length - 1]!, strong: STRONG_TOTAL.test(l.text), nextLine, ids });
  }
  let total: ParsedReceipt["totalCents"] = null;
  if (cands.length) {
    const best = cands.reduce((a, b) => (b.cents > a.cents ? b : a));
    let c = best.strong ? 0.95 : 0.85;
    if (best.nextLine) c -= 0.1;
    const distinct = new Set(cands.map((x) => x.cents));
    if (distinct.size > 1) { c -= 0.15; warnings.push("multiple_distinct_totals_largest_chosen"); }
    const t = tendered?.value, ch = change?.value ?? 0;
    if (t !== undefined && t - ch === best.cents) c += 0.05; // cash - change == total
    else if (t !== undefined && t < best.cents) { c -= 0.2; warnings.push("tendered_less_than_total"); }
    const ids = [...new Set(cands.filter((x) => x.cents === best.cents).flatMap((x) => x.ids))];
    total = { value: best.cents, confidence: clamp(c * ocr(...ids)), evidence: ev(...ids) };
  } else {
    // Fallback: largest amount on a line that is not change/tender/vat/id. Low confidence by design.
    let bestI = -1, bestV = 0;
    for (const l of lines) {
      if (!l.text || NOT_TOTAL.test(l.text) || VAT_KEY.test(l.text) || VAT_IDENT.test(l.text) || /\b(?:tel|phone|till|pin|etr|receipt|invoice|qty|x)\b/i.test(l.text)) continue;
      if (dateFrom(l.text)) continue;
      const a = amountsIn(l.text);
      const v = a.length ? Math.max(...a) : 0;
      if (v > bestV) { bestV = v; bestI = l.i; }
    }
    if (bestI >= 0) {
      total = { value: bestV, confidence: clamp(0.35 * ocr(bestI)), evidence: ev(bestI) };
      warnings.push("total_inferred_without_total_keyword");
    }
  }

  // ---- VAT ----
  const vat: VatLine[] = [];
  for (const l of lines) {
    if (!l.text || !VAT_KEY.test(l.text) || VAT_IDENT.test(l.text) || /\b(?:vatable|taxable)\b/i.test(l.text)) continue;
    const rate = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(l.text);
    let amts = amountsIn(l.text);
    const ids = [l.i];
    if (!amts.length) { const n = lines[l.i + 1]; if (n && isAmountOnly(n.text)) { amts = amountsIn(n.text); ids.push(n.i); } }
    if (!amts.length) continue;
    vat.push({ rate: rate ? Number(rate[1]) : null, amountCents: amts[amts.length - 1]!, confidence: clamp((rate ? 0.9 : 0.75) * ocr(...ids)), evidence: ev(...ids) });
  }
  if (total && vat.length) {
    const sum = vat.reduce((s, v) => s + v.amountCents, 0);
    if (sum > total.value) warnings.push("vat_exceeds_total");
  }

  // ---- identifiers ----
  let kraPin: ParsedReceipt["kraPin"] = null;
  let etr: ParsedReceipt["etrSerial"] = null;
  let till: ParsedReceipt["tillNo"] = null;
  for (const l of lines) {
    if (!kraPin) {
      const m = /\b(?:KRA\s*)?PIN\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([AP]\d{9}[A-Z])\b/i.exec(l.text);
      if (m) kraPin = { value: m[1]!.toUpperCase(), confidence: clamp(0.95 * ocr(l.i)), evidence: ev(l.i) };
      else if (/\bkra\b/i.test(l.text)) {
        const b = /\b([AP]\d{9}[A-Z])\b/i.exec(l.text);
        if (b) kraPin = { value: b[1]!.toUpperCase(), confidence: clamp(0.8 * ocr(l.i)), evidence: ev(l.i) };
      }
    }
    if (!etr) {
      const m = /\b(?:ETR|CUSN|CU\s*SERIAL(?:\s*(?:NO|NUMBER))?|TIMS)\b\s*(?:NO\.?|NUMBER|S\/N|SN|ID)?\s*[:#\-]?\s*((?=[A-Z0-9]*\d)[A-Z0-9]{6,})/i.exec(l.text);
      if (m) etr = { value: m[1]!.toUpperCase(), confidence: clamp(0.85 * ocr(l.i)), evidence: ev(l.i) };
    }
    if (!till) {
      const m = /\b(?:TILL|BUY\s*GOODS)\s*(?:NO\.?|NUMBER)?\s*[:#]?\s*(\d{5,7})\b/i.exec(l.text);
      if (m) till = { value: m[1]!, confidence: clamp(0.9 * ocr(l.i)), evidence: ev(l.i) };
    }
  }

  // ---- date / time ----
  let date: ParsedReceipt["date"] = null;
  let time: ParsedReceipt["time"] = null;
  {
    let best: { iso: string; conf: number; i: number } | null = null;
    for (const l of lines) {
      if (/\b(?:exp(?:iry|ires)?|valid\s*(?:until|till)|due\s*date|best\s*before)\b/i.test(l.text)) continue;
      const d = dateFrom(l.text);
      if (!d) continue;
      let conf = /\bdate\b/i.test(l.text) ? 0.92 : 0.75;
      if (opts.now !== undefined) {
        const t = Date.parse(`${d.iso}T00:00:00+03:00`);
        if (t > opts.now + 86_400_000) { conf -= 0.4; warnings.push("date_in_future"); }
      }
      if (!best || conf > best.conf) best = { iso: d.iso, conf, i: l.i };
      let tm: RegExpExecArray | null = null;
      if (!time) tm = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?!\d)\s*([AaPp][Mm])?/.exec(l.text);
      if (tm) {
        let h: number = Number(tm[1]);
        const ap = tm[3]?.toLowerCase();
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        time = { value: `${String(h).padStart(2, "0")}:${tm[2]}`, confidence: clamp(0.8 * ocr(l.i)), evidence: ev(l.i) };
      }
    }
    if (best) date = { value: best.iso, confidence: clamp(best.conf * ocr(best.i)), evidence: ev(best.i) };
  }

  // ---- merchant ----
  let merchant: ParsedReceipt["merchant"] = null;
  {
    const labelled = lines.find((l) => /^(?:merchant|store|shop|outlet)\s*[:\-]\s*\S/i.test(l.text));
    if (labelled) {
      merchant = { value: labelled.text.replace(/^[^:\-]+[:\-]\s*/, "").slice(0, 60), confidence: clamp(0.9 * ocr(labelled.i)), evidence: ev(labelled.i) };
    } else {
      const candidates: Array<{ line: OcrLine; i: number; confidence: number; business: boolean }> = [];
      let seen = 0;
      for (const l of lines) {
        if (!l.text) continue;
        if (++seen > 8) break;
        const letters = (l.text.match(/\p{L}/gu) ?? []).length;
        const digits = (l.text.match(/\d/g) ?? []).length;
        if (letters < 3 || letters / l.text.length < 0.6 || digits > letters || l.text.length > 50) continue;
        if (BOILERPLATE.test(l.text) || TOTAL_KEY.test(l.text) || dateFrom(l.text)) continue;
        if (TRAILING_AMOUNT.test(l.text) || PRODUCT_HINT.test(l.text)) continue;
        const business = BIZ_HINT.test(l.text);
        const c = (seen <= 2 ? 0.7 : 0.5) + (business ? 0.15 : 0);
        candidates.push({ line: l, i: l.i, confidence: clamp(c * ocr(l.i)), business });
      }
      const chosen = candidates.find((c) => c.business) ?? candidates[0];
      if (chosen) {
        merchant = {
          value: chosen.line.text.replace(/[^\p{L}\p{N}&'.,\- ]/gu, "").trim(),
          confidence: chosen.confidence,
          evidence: ev(chosen.i),
        };
      }
    }
  }

  if (!total) warnings.push("no_total_found");
  const items = extractReceiptItems(lines);
  return { totalCents: total, merchant, date, time, vat, kraPin, etrSerial: etr, tillNo: till, tenderedCents: tendered, changeCents: change, items, warnings };
}
