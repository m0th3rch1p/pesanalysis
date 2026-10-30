/**
 * Deterministic note parser (WS3.4). The founder's grammar is `context-items`, e.g.
 * "shop-cigarettes 30 + lemon 10". It also accepts Swahili/Sheng item names and plain
 * sentences. Amounts are kept only when they add up to the transaction amount.
 */
import { interpret, type InterpretContext } from "../labels/interpret.js";
import { displayItemName, normalizeItemName } from "./normalize.js";
import { suggestedHabitCategories } from "../habits/categories.js";

export interface ParsedNoteItem {
  name: string;
  display: string;
  qty?: number;
  unit?: string;
  amountCents?: number;
}

export interface ParsedNote {
  category: string | null;
  items: ParsedNoteItem[];
  groups: string[];
  counterpartyRole: string | null;
  /** Habit categories the words suggest, e.g. ["Tobacco"]. Never created automatically. */
  habitSuggestions: string[];
  raw: string;
  /** true when all parsed amounts summed exactly to the transaction amount */
  amountsBalanced: boolean;
}

const CONTEXTS: Array<[RegExp, string]> = [
  [/^supermarket\b/i, "Groceries"],
  [/^shop\b/i, "Groceries"],
  [/^duka\b/i, "Groceries"],
  [/^food\b/i, "Eating out"],
  [/^friend\b/i, "Personal transfer"],
  [/^family\b/i, "Family support"],
  [/^online[- ]?services?\b/i, "Subscriptions"],
  [/^payout\b/i, "Other income"],
  [/^rea?creat\w*\b/i, "Entertainment"],
  [/^maintenance\b/i, "Transport"],
  [/^transport\b/i, "Transport"],
  [/^rent\b/i, "Rent"],
  [/^school\b/i, "School fees"],
  [/^health\b/i, "Health"],
  [/^business\b/i, "Business stock"],
  [/^okoa\b/i, "Debt repayment"],
  [/^debt\b/i, "Debt repayment"],
  [/^airtime\b/i, "Airtime & data"],
  [/^vocha\b/i, "Airtime & data"],
];

const SW: Record<string, string> = {
  mkate: "bread", maziwa: "milk", sukari: "sugar", unga: "flour", mayai: "egg", nyanya: "tomato",
  sigara: "cigarette", chapo: "chapo", mandazi: "mandazi", mutura: "mutura", smokie: "smokie",
  soda: "soda", maji: "water", mchele: "rice", mahindi: "maize", ndengu: "green grams",
  viazi: "potato", kitunguu: "onion", parachichi: "avocado", ndizi: "banana", chai: "tea",
  kahawa: "coffee", samaki: "fish", nyama: "meat", kuku: "chicken", mkopo: "loan", nauli: "fare",
  vocha: "airtime", bando: "data", unyanya: "tomato", vitunguu: "onion", karoti: "carrot",
  kabichi: "cabbage", embe: "mango", nanasi: "pineapple", chungwa: "orange", tunda: "fruit",
};

const UNITS = new Set(["kg", "g", "ml", "l", "litre", "liter", "pcs", "pc", "packet", "packets", "sachet", "sachets", "bunch", "bunches"]);

const NUM = "(\\d+(?:[.,]\\d+)?|½|¼|¾)";
const LEAD_QTY = new RegExp(`^${NUM}\\s*(kg|g|ml|l|litre|liter|pcs?|packets?|sachets?|bunch(?:es)?)?\\s+`, "i");
const ATTACHED_QTY = new RegExp(`^([a-z]+)${NUM}\\s*\\/\\s*(\\d+)\\s*(kg|g|ml|l)$`, "i");
const TRAILING_QTY = /\s+x(\d+)$/i;
const TRAILING_PRICE = /(?:\s|^)(?:kes|ksh|bob)?\s*(\d+(?:\.\d+)?)\s*(?:kes|ksh|bob|\/=)?$/i;

function number(raw: string): number | null {
  if (raw === "½") return 0.5;
  if (raw === "¼") return 0.25;
  if (raw === "¾") return 0.75;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonical(name: string): string {
  const n = normalizeItemName(name);
  if (!n) return "";
  const parts = n.split(" ");
  const mapped = SW[parts[0]!] ?? parts[0]!;
  return [mapped, ...parts.slice(1)].join(" ");
}

function parseOne(segment: string): ParsedNoteItem | null {
  let s = segment.trim().replace(/^[-•*]\s*/, "");
  if (!s) return null;
  let qty: number | undefined;
  let unit: string | undefined;
  let amountCents: number | undefined;

  const attachedQty = /^(\d+(?:[.,]\d+)?)([a-z][a-z ]*)$/i.exec(s);
  const attached = ATTACHED_QTY.exec(s);
  if (attachedQty && !UNITS.has(attachedQty[2]!.toLowerCase())) {
    qty = number(attachedQty[1]!) ?? undefined;
    s = attachedQty[2]!;
  } else if (attached) {
    const q = number(attached[2]!);
    const den = Number(attached[3]);
    qty = q != null && den > 0 ? q / den : q ?? undefined;
    unit = attached[4]!.toLowerCase();
    s = attached[1]!;
  } else {
    const lead = LEAD_QTY.exec(s);
    if (lead) {
      qty = number(lead[1]!) ?? undefined;
      if (lead[2]) unit = lead[2].toLowerCase().replace(/s$/, "");
      s = s.slice(lead[0].length);
    }
    const trailingQty = TRAILING_QTY.exec(s);
    if (trailingQty) { qty = number(trailingQty[1]!) ?? qty; s = s.slice(0, trailingQty.index).trim(); }
  }

  // A trailing integer is a price only when a name remains. "cigarettes 30" -> price 30.
  const price = TRAILING_PRICE.exec(s);
  if (price) {
    const rest = s.slice(0, price.index).trim();
    if (rest && /[a-z]/i.test(rest) && !/\d+\s*\/\s*\d+/.test(`${rest}${price[1]}`)) {
      const n = Number(price[1]!.replace(",", "."));
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) { amountCents = Math.round(n * 100); s = rest; }
    }
  }

  const clean = s.replace(/\s+/g, " ").replace(/[.;:,]+$/, "").trim();
  if (!clean || !/[a-z]/i.test(clean)) return null;
  if (UNITS.has(clean.toLowerCase())) return null;
  const name = canonical(clean);
  if (!name) return null;
  return {
    name, display: displayItemName(clean), qty, unit,
    ...(amountCents != null ? { amountCents } : {}),
  };
}

export function parseNote(text: string, opts: { direction?: "in" | "out" | "neutral"; txAmountCents?: number; interpretCtx?: InterpretContext; lexicon?: Record<string, string> } = {}): ParsedNote {
  const raw = (text ?? "").trim();
  if (!raw) return { category: null, items: [], groups: [], counterpartyRole: null, habitSuggestions: [], raw, amountsBalanced: false };

  let context: string | null = null;
  let body = raw;
  const dash = raw.indexOf("-");
  if (dash > 0) {
    const head = raw.slice(0, dash).trim();
    const hit = CONTEXTS.find(([re]) => re.test(head));
    if (hit) {
      context = hit[1];
      body = raw.slice(dash + 1).trim();
      if (/^friend\b/i.test(head) || /^family\b/i.test(head)) {
        const person = body.split(/[+,]/)[0]?.trim();
        if (person) {
          const inbound = (opts.direction ?? opts.interpretCtx?.direction) === "in";
          return {
            category: inbound ? "Transfer in" : context, items: [], groups: [], counterpartyRole: person,
            habitSuggestions: suggestedHabitCategories(body), raw, amountsBalanced: false,
          };
        }
      }
    }
  } else {
    const first = raw.split(/\s+/)[0] ?? "";
    const hit = CONTEXTS.find(([re]) => re.test(first));
    if (hit && raw.length > first.length) { context = hit[1]; body = raw.slice(first.length).trim(); }
  }

  const segments = body.split(/\s*(?:\+|,|;|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  const items = segments.map(parseOne).filter((x): x is ParsedNoteItem => !!x);

  const sum = items.reduce((n, i) => n + (i.amountCents ?? 0), 0);
  const allPriced = items.length > 0 && items.every((i) => i.amountCents != null);
  const balanced = allPriced && opts.txAmountCents != null && sum === opts.txAmountCents;
  if (allPriced && !balanced) for (const i of items) delete i.amountCents;

  const guess = interpret(body, { ...opts.interpretCtx, direction: opts.direction ?? opts.interpretCtx?.direction }, opts.lexicon);
  let category = context;
  const head = raw.slice(0, raw.indexOf("-") > 0 ? raw.indexOf("-") : 0).trim();
  // Shop/supermarket context is the category; food/business/okoa let a strong body win.
  if (/^(food)$/i.test(head) && guess.category && ["Groceries", "Pets"].includes(guess.category)) category = guess.category;
  else if (/^(okoa|debt|airtime|vocha|business|friend|family)$/i.test(head) && guess.category) category = guess.category;
  else if (!context) category = guess.category;
  if ((opts.direction ?? opts.interpretCtx?.direction) === "in" && /^(friend|family)$/i.test(head)) category = "Transfer in";
  return { category, items, groups: [], counterpartyRole: null, habitSuggestions: suggestedHabitCategories(raw), raw, amountsBalanced: balanced };
}
