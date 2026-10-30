import {
  maskEntities, narrateFinding, plainTerms, restoreEntities, systemPromptFor, verifyTranslation, type Finding,
} from "@yako/core";

/**
 * Offline narration. The deterministic detector produces the finding; the LLM
 * only explains it, with a hard number-preservation check and a template
 * fallback. All model access goes through qvac.ts (G13).
 */
export interface Narration {
  text: string;
  source: "llm" | "template" | "translated" | "template-fallback";
  ms: number;
  tokPerSec?: number;
  note?: string;
}

/** Lazy: the QVAC SDK is only imported when a narration is actually requested (D85). */
async function modelComplete(opts: { system: string; user: string; predict: number; temp: number; timeoutMs: number }) {
  const q = await import("./qvac");
  if (q.crashState().disabled) throw new Error("model disabled after a native crash");
  const loaded = await q.loadLocal(q.MODELS.qwen3_06b, { ctxSize: 2048 });
  q.beginInference("narrate");
  try { return await q.complete(loaded.modelId, opts); } finally { q.endInference(); }
}

/** AfriSLM translation (English -> Kiswahili). Loaded lazily; numbers/entities are masked by the caller. */
async function modelTranslate(text: string, timeoutMs = 60_000) {
  const q = await import("./qvac");
  if (q.crashState().disabled) throw new Error("model disabled after a native crash");
  const loaded = await q.loadLocal(q.MODELS.afri_08b_q4, { ctxSize: 1024 });
  q.beginInference("translate");
  try {
    const out = await q.complete(loaded.modelId, {
      user: `Please translate the following English text into Swahili: ${text}\n\nTranslation:`,
      predict: 180, temp: 0.1, timeoutMs,
    });
    return out.text.trim();
  } finally { q.endInference(); }
}

/** Kept for call-site compatibility: nothing is loaded ahead of time any more. */
export async function prewarmNarration(): Promise<void> { /* intentionally empty */ }

const SYSTEM =
  "You are Pesanalysis, a private finance assistant on a Kenyan phone. Explain ONE finding to the user in one or two short, natural sentences. " +
  "Use ONLY the numbers that appear in the finding. Never invent an amount, a date, or advice. " +
  "Write every number as digits, exactly as given (2705, 9:05 AM, 26/10/26). Never spell numbers in words. " +
  "Never move an amount from one label to another: if the finding says 'borrowed X, repaid Y', X stays with borrowed and Y stays with repaid. " +
  "If the finding is statistical, say it is a pattern, not a certainty. Plain English. Speak directly to the user; " +
  "never start with 'The finding states' or describe the task. " +
  "Do not add durations, causes, or advice. A count of payments is not a number of days.";

// Protect amounts (3-7 digits) from hallucination. Ignore counts/dates/times and
// long digit runs (msisdn / till keys) which must not be echoed anyway. Join
// thousands separators first so "2,705" / "2.705" / "2 705" match "2705".
const numbers = (s: string): string[] =>
  (s
    .replace(/(\d)[,.\u00A0\u202F ](?=\d{3}(?:\D|$))/g, "$1")
    .match(/\d+/g) ?? []
  ).filter((x) => x.length >= 3 && x.length < 8);

const TIME_WORDS = /\b(day|days|week|weeks|month|months|year|years)\b/i;
function inventsTime(title: string, text: string): boolean {
  return TIME_WORDS.test(text) && !TIME_WORDS.test(title);
}

function missingNumbers(title: string, text: string): string[] {
  const have = new Set(numbers(text));
  return [...new Set(numbers(title))].filter((n) => !have.has(n));
}

// Small amounts (KES 27) and role swaps slip past the digit heuristic. Track
// labelled currency amounts and require the same label -> amount pairs in the
// rewrite, so "borrowed 27, repaid 42" cannot become "repaid 27 and 42".
const AMOUNT = /(?:KES|Ksh|KSh)\s*([\d][\d,.\u00A0\u202F ]*)/g;
const ROLE_AMOUNT = /\b(borrowed|repaid|spent|spending|received|income|earned|paid|fees?|total|balance|loan(?:s)?)(?:\s+(?:of|is|was|were|at|to|from))?\s*(?:KES|Ksh|KSh)\s*([\d][\d,.\u00A0\u202F ]*)/gi;

function normaliseAmount(raw: string): string | null {
  const n = Number(raw.replace(/[,\u00A0\u202F ]/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? String(n) : null;
}

function currencyAmounts(s: string): string[] {
  return [...s.matchAll(AMOUNT)].map((m) => normaliseAmount(m[1])).filter((x): x is string => x !== null);
}

function rolePairs(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(ROLE_AMOUNT)) {
    const amount = normaliseAmount(m[2]);
    if (amount !== null) out.add(`${m[1].toLowerCase()}:${amount}`);
  }
  return out;
}

function amountIssue(title: string, text: string): string | null {
  // Zero can be expressed as "no fees"; positives must survive exactly.
  const positive = (a: string) => Number(a) > 0;
  const titleAmounts = new Set(currencyAmounts(title).filter(positive));
  const textAmounts = new Set(currencyAmounts(text).filter(positive));
  const missing = [...titleAmounts].filter((a) => !textAmounts.has(a));
  if (missing.length) return `currency amount check failed: missing ${missing.slice(0, 3).join(", ")}`;
  const extra = [...textAmounts].filter((a) => !titleAmounts.has(a));
  if (extra.length) return `currency amount check failed: invented ${extra.slice(0, 3).join(", ")}`;
  const want = new Set([...rolePairs(title)].filter((p) => positive(p.split(":")[1] ?? "0")));
  const got = new Set([...rolePairs(text)].filter((p) => positive(p.split(":")[1] ?? "0")));
  const lost = [...want].filter((p) => !got.has(p));
  const invented = [...got].filter((p) => !want.has(p));
  if (lost.length || invented.length) return "amount role check failed";
  return null;
}

export async function narrateOffline(f: Finding, opts: { tone?: string; language?: string; verticals?: string[] } = {}): Promise<Narration> {
  const t0 = Date.now();
  // Ask the model for English even when the UI is Swahili: AfriSLM translates afterwards, so the
  // number-preservation guard runs on one language and translation cannot silently drop a figure.
  const wantsSwahili = /^(sw|swa|swahili|kiswahili)/i.test(opts.language ?? "");
  let english: string;
  let source: Narration["source"];
  let note: string | undefined;
  let tokPerSec: number | undefined;
  let ms = 0;
  try {
    // Title only: evidence contains internal keys (msisdn/till/hash) that must
    // never reach the model (it echoes them) or the screen.
    const profile = systemPromptFor({ tone: opts.tone, language: wantsSwahili ? undefined : opts.language, verticals: opts.verticals });
    const out = await modelComplete({
      system: `${SYSTEM}
${profile}`,
      user: `Finding: ${plainTerms(f.title)}\nRestate it in one or two natural sentences. Keep every fact exactly as written. Use simple English.`,
      predict: 80,
      temp: 0.2,
      timeoutMs: 90_000,
    });
    if (!out.text) { english = narrateFinding(f); source = "template"; note = "empty model output"; }
    else if (!/[.!?…]["')\]]?$/.test(out.text)) { english = narrateFinding(f); source = "template"; note = "model output incomplete"; }
    else {
      const missing = missingNumbers(f.title, out.text);
      const amount = amountIssue(f.title, out.text);
      if (missing.length) { english = narrateFinding(f); source = "template"; note = `number check failed: missing ${missing.slice(0, 3).join(", ")}`; }
      else if (amount) { english = narrateFinding(f); source = "template"; note = amount; }
      else if (inventsTime(f.title, out.text)) { english = narrateFinding(f); source = "template"; note = "time-word check failed"; }
      else { english = out.text; source = "llm"; ms = out.ms; tokPerSec = out.tokPerSec; }
    }
  } catch (e) {
    english = narrateFinding(f); source = "template";
    // Never surface exception text in the UI; the card offers model setup instead.
    note = e instanceof Error && e.name === "ModelMissingError" ? "model_missing" : String(e).slice(0, 120);
  }

  if (!wantsSwahili) return { text: english, source, ms: ms || Date.now() - t0, tokPerSec, note };

  // Translate only the validated English sentence, with every amount/entity masked.
  try {
    const masked = maskEntities(english);
    const translated = await modelTranslate(masked.masked);
    const restored = restoreEntities(translated, masked.entities);
    const verdict = verifyTranslation(english, restored.text, { restore: restored, strictOrder: true });
    if (!verdict.accepted) return { text: english, source, ms: Date.now() - t0, note: `translation rejected: ${verdict.reasons.join(",").slice(0, 100)}` };
    return { text: restored.text, source: "translated", ms: Date.now() - t0, note };
  } catch (e) {
    return { text: english, source, ms: Date.now() - t0, note: `translation failed: ${String(e).slice(0, 100)}` };
  }
}
