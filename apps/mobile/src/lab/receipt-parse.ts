/** Deterministic post-parser for OCR'd till slips (pure). OCR only proposes; this decides what is extracted. */
export interface ParsedReceipt { total?: number; merchant?: string; date?: string /* YYYY-MM-DD */ }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

function parseAmount(raw: string): number | undefined {
  // OCR confusions inside numbers: O->0, l/I->1, S->5 are NOT corrected blindly; only strip separators/currency.
  const t = raw.replace(/[^0-9.,]/g, "");
  if (!t) return undefined;
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(t.replace(/,(?=\d{3}\b)/g, ",").replace(/\.$/, ""));
  if (!m) return undefined;
  return Number(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
}

export function parseReceipt(lines: string[]): ParsedReceipt {
  const L = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: ParsedReceipt = {};

  // total: the LAST amount on a line mentioning TOTAL/JUMLA/AMOUNT DUE/GRAND, excluding SUBTOTAL; fall back to biggest amount.
  const amtRe = /(?:KES|KSH|KSHS|Ksh|Kshs)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let best: number | undefined;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (/sub\s?-?total/i.test(l)) continue;
    if (/\b(grand\s*)?total\b|jumla|amount due|to pay|\bamount\b/i.test(l)) {
      const nums = [...l.matchAll(amtRe)].map((m) => parseAmount(m[1])).filter((n): n is number => n != null);
      let v = nums[nums.length - 1];
      if (v == null && L[i + 1]) { const n2 = [...L[i + 1].matchAll(amtRe)].map((m) => parseAmount(m[1])).filter((n): n is number => n != null); v = n2[n2.length - 1]; }
      if (v != null) best = v;
    }
  }
  if (best != null) out.total = best;

  // date: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy(yy), dd Mon yyyy, yyyy-mm-dd
  for (const l of L) {
    let m = /(\d{4})-(\d{2})-(\d{2})/.exec(l);
    if (m) { out.date = `${m[1]}-${m[2]}-${m[3]}`; break; }
    m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/.exec(l);
    if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); out.date = `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`; break; }
    m = /\b(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{2,4})\b/.exec(l);
    if (m && MONTHS[m[2].toLowerCase()]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); out.date = `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))}`; break; }
  }

  // merchant: first line (top 4) that is mostly letters, not a date/total/phone/pin/till/receipt-no line
  for (const l of L.slice(0, 5)) {
    if (/\d{2}[/.\-]\d{2}|total|tel|phone|pin|till|receipt|rcpt|cash|date|no[.:]/i.test(l)) continue;
    const letters = (l.match(/[A-Za-z]/g) ?? []).length;
    if (letters >= 4 && letters / l.length > 0.6) { out.merchant = l.toUpperCase().replace(/[^A-Z0-9 &'.-]/g, "").trim(); break; }
  }
  return out;
}
