/**
 * Deterministic question -> QueryPlan router. Runs before any model, always available offline.
 * The LLM (if used) only gets a second chance when this returns `needs`; its plan must pass
 * the same validator. This is why chat still works at 0.6B.
 */
import { SEED_LABELS } from "../labels/taxonomy.js";
import { resolveRange } from "./plan.js";
import type { QueryPlan, PlanFilters } from "./plan.js";
import type { PlanDirection, TimeRange } from "./semantic.js";

export interface RouteOptions {
  labels?: string[];
  tags?: string[];
  counterparties?: string[];
  items?: string[];
  habits?: string[];
}

export interface RouteResult {
  ok: boolean;
  plan?: QueryPlan;
  summary?: boolean;
  source: "rules";
  explanation: string;
  needs?: { slot: string; question: string; options?: string[] };
}

const SYNONYMS: Record<string, string> = {
  food: "Eating out", lunch: "Eating out", dinner: "Eating out", restaurant: "Eating out", chapo: "Eating out",
  takeaway: "Eating out", takeout: "Eating out", "eat out": "Eating out", chakula: "Eating out",
  groceries: "Groceries", supermarket: "Groceries", shopping: "Shopping",
  transport: "Transport", matatu: "Transport", uber: "Transport", bolt: "Transport", fare: "Transport", usafiri: "Transport",
  kodi: "Rent", karo: "School fees", vocha: "Airtime & data", bando: "Airtime & data",
  fuel: "Fuel", petrol: "Fuel", diesel: "Fuel",
  rent: "Rent", landlord: "Rent",
  airtime: "Airtime & data", data: "Airtime & data", bundles: "Airtime & data",
  electricity: "Utilities", water: "Utilities", kplc: "Utilities", utilities: "Utilities",
  family: "Family support", salary: "Salary", wages: "Salary",
  school: "School fees", fees: "Fees & charges", charges: "Fees & charges",
  health: "Health", hospital: "Health", pharmacy: "Health",
  pets: "Pets", dog: "Pets", cat: "Pets",
  entertainment: "Entertainment", drinks: "Entertainment", movies: "Entertainment",
  savings: "Savings & investment", sacco: "Savings & investment", mshwari: "Savings & investment",
  business: "Sales (business)", stock: "Business stock",
  loan: "Debt repayment", fuliza: "Debt repayment", debt: "Debt repayment",
};

const ITEM_SYNONYMS: Record<string, string> = {
  sigara: "cigarette", cigarettes: "cigarette", cigarette: "cigarette", fegi: "cigarette", smoke: "cigarette", smokes: "cigarette", smoking: "cigarette",
  mkate: "bread", maziwa: "milk", sukari: "sugar", unga: "flour", mayai: "egg", nyanya: "tomato",
  chapo: "chapo", mandazi: "mandazi", mutura: "mutura", smokie: "smokie", soda: "soda",
  groceries: "groceries", food: "food", snacks: "snack",
};

const STOP = new Set([
  "the", "a", "an", "my", "our", "this", "last", "next", "previous", "past", "month", "week", "year", "today", "yesterday",
  "spend", "spent", "spending", "pay", "paid", "payment", "payments", "with", "from", "to", "at", "on", "for", "in", "of", "and", "or", "me", "i",
  "how", "much", "many", "what", "where", "when", "which", "who", "did", "do", "does", "was", "were", "is", "are", "show", "tell", "give", "list",
  "total", "top", "most", "least", "compare", "compared", "versus", "vs", "than", "about", "over", "under", "between", "above", "below", "more", "less",
  "money", "transaction", "transactions", "received", "receive", "income", "earn", "earned", "fees", "fee", "charges", "charge", "net", "saved", "save",
  "average", "avg", "largest", "biggest", "highest", "count", "number", "category", "categories", "merchant", "merchants", "payee", "payees",
  "tag", "tags", "tagged", "venture", "ventures", "business", "project", "projects", "all", "any", "some", "there", "here", "please", "can", "could", "would",
  "am", "doing", "going", "go", "went", "came", "come", "look", "looking", "see", "status", "overview", "summary", "track", "tracking",
  "nimetumia", "nimetumia", "nimelipa", "nimenunua", "nimegharimu", "nimepokea", "nilipokea", "nimeingiza",
  "pesa", "ngapi", "kwa", "ya", "mwezi", "huu", "uliopita", "wiki", "hii", "iliyopita", "leo", "jana", "usiku", "asubuhi", "mchana", "jioni",
]);

function clean(q: string): string {
  return q.toLowerCase().replace(/[’']/g, "")
    .replace(/\bspnd\b/g, "spend").replace(/\bexpenes\b/g, "expenses").replace(/\bgrocries\b/g, "groceries")
    .replace(/\bresturant\b/g, "restaurant").replace(/\bchappati\b/g, "chapo")
    .replace(/\s+/g, " ").trim();
}

function has(q: string, re: RegExp): boolean {
  return re.test(q);
}

function pickMeasure(q: string): QueryPlan["measure"] | null {
  // Net comparison wins over the generic "spending" word in the same sentence.
  if (/\bmoney in\b.*\bmoney out\b|\bincome\b.*\b(spending|expenses?)\b|\b(spending|expenses?)\b.*\bincome\b/.test(q)) return "net";
  if (/\bfuliza\b/.test(q) && /\b(cost|costs|fee|fees|charge|charges|damage|gharama|ada)\b/.test(q)) return "credit_cost";
  if (/\b(share|percentage|percent|proportion|asilimia)\b/.test(q) && /\b(fuliza|credit|loan|mkopo)\b/.test(q)) return "credit_share";
  if (/\b(how much|how many)\b.*\b(items?|bidhaa)\b/.test(q) && !/\bspent|spend|paid|pay\b/.test(q)) return "count_items";
  if (/\b(how much did i (buy|purchase)|what did i buy|nilinunua)\b/.test(q) && /\b(fuliza|credit|loan|mkopo)\b/.test(q)) return "credit_share";
  if (/\b(gharama|ada)\b/.test(q) && !/\bfuliza\b/.test(q)) return "fees";
  if (/\b(nimetumia|nimetumia pesa|nimelipa|nimenunua|nimegharimu)\b/.test(q)) return "spend";
  if (/\b(nimepokea|nimeingiza|nilipokea)\b/.test(q)) return "income";
  if (/\b(how many|number of)\b/.test(q) && !/\b(payments?|transactions?|times?)\b/.test(q)
      && (/\b(items?|bidhaa)\b/.test(q) || Object.keys(ITEM_SYNONYMS).some((w) => new RegExp(`\\b${w}\\b`).test(q)))) return "count_items";
  if (/\b(total expenses?|expenses?|spent|spending)\b/.test(q)) return "spend";
  if (/\b(send|sent|transfer out|paid out|money out|put into savings|savings account|invested)\b/.test(q)) return "spend";
  if (/\b(progress|tracking|doing on)\b/.test(q)) return "spend";
  if (/\b(how much)\b.*\b(on|with|from)\s+(fuliza|credit|loan|mkopo)\b/.test(q)) return "spend";
  // "school fees" is a category, not the fees measure.
  if (has(q, /\bschool fees?\b/)) return "spend";
  // "share of fees" asks for a proportion, not the fee total.
  if (has(q, /\b(share|percentage|percent|proportion)\b/)) return "share";
  // "money in versus money out" is a net comparison.
  if (has(q, /\bmoney in\b.*\bmoney out\b|\bincome\b.*\b(spending|expenses?)\b|\b(spending|expenses?)\b.*\bincome\b/)) return "net";
  if (has(q, /\b(fee|fees|charges|transaction cost|costs)\b/)) return "fees";
  if (has(q, /\b(net|saved|save|left over|surplus|balance)\b/)) return "net";
  if (has(q, /\b(average|avg|typical)\b/)) return "avg";
  if (has(q, /\b(largest|biggest|most expensive|highest)\b/)) return "max";
  if (has(q, /\bhow many\b|\bnumber of\b|\bcount\b|\btransactions?\b/)) return "count";
  if (has(q, /\b(income|earn|earned|receive|received|money in|came in|deposits?)\b/)) return "income";
  if (has(q, /\bprofit|profitable|made money|making money\b/)) return "net";
  if (has(q, /\b(spend|spent|spending|pay|paid|payments?|money out|went out|used|buy|bought|burn|burned|blow|blew|shopping)\b/)) return "spend";
  return null;
}

function pickGroup(q: string): QueryPlan["groupBy"] | undefined {
  if (has(q, /\b(business|personal)\b.*\b(versus|vs|and)\b.*\b(business|personal)\b/)) return ["scope"];
  if (has(q, /\bwhere did (my|the) money go\b/)) return ["label"];
  if (has(q, /\bby (category|categories|label|labels|type|types)\b/)) return ["label"];
  if (has(q, /\bby (merchant|merchants|payee|payees|counterparty|person|people|who)\b/)) return ["counterparty"];
  if (has(q, /\bby (role|roles)\b/)) return ["role"];
  if (has(q, /\bby (tag|tags|venture|ventures|project|projects|business)\b/)) return ["venture"];
  if (has(q, /\b(my )?ventures?\b/)) return ["venture"];
  if (has(q, /\bby (provider|providers|network)\b/)) return ["provider"];
  if (has(q, /\bby (scope|personal|business)\b/)) return ["scope"];
  if (has(q, /\bby (hour|time of day)\b|\bwhat time\b|\bwhich hours?\b/)) return ["hour"];
  if (has(q, /\bwhich days?\b|\bwhat days?\b|\bdays? of (the )?week\b/)) return ["weekday"];
  if (has(q, /\bby (weekday|day of week)\b/)) return ["weekday"];
  if (has(q, /\bby day\b|\bdaily\b/)) return ["day"];
  if (has(q, /\bby week\b|\bweekly\b/)) return ["week"];
  if (has(q, /\bby month\b|\bmonthly\b|\bover time\b|\btrend\b|\bper month\b/)) return ["month"];
  if (has(q, /\bby (item|items|product|products)\b|\bkwa bidhaa\b/)) return ["item"];
  if (has(q, /\bby (group|groups)\b/)) return ["item_group"];
  if (has(q, /\bby (habit|habits)\b/)) return ["habit"];
  if (has(q, /\bby (funding|wallet or credit)\b/)) return ["funding"];
  if (has(q, /\bby place\b|\bwhere did i (spend|pay)\b/)) return ["place"];
  if (has(q, /\btop(?:\s+\d+)?\s+(categories|categories of spending|expenses)\b/)) return ["label"];
  if (has(q, /\btop(?:\s+\d+)?\s+(merchants|payees|people)\b|\bwho did i pay\b/)) return ["counterparty"];
  return undefined;
}

export function parseQuestionTime(q: string, now: number): TimeRange | undefined {
  const rel = /\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|[a-z]+)\s+(day|days|week|weeks|month|months|year|years)\b/.exec(q);
  if (rel) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
    const n = words[rel[1]!] ?? Number(rel[1]);
    const unitRaw = rel[2]!;
    const unit = unitRaw.startsWith("day") ? "day" : unitRaw.startsWith("week") ? "week" : unitRaw.startsWith("month") ? "month" : "year";
    if (Number.isFinite(n) && n >= 1 && n <= 240) return { kind: "relative", unit, n: Math.floor(n) };
  }
  if (/\b(leo)\b/.test(q)) return { kind: "named", name: "today" };
  if (/\b(jana)\b/.test(q)) return { kind: "named", name: "yesterday" };
  if (/\bwiki hii\b/.test(q)) return { kind: "named", name: "this_week" };
  if (/\bwiki iliyopita\b/.test(q)) return { kind: "named", name: "last_week" };
  if (/\bmwezi huu\b/.test(q)) return { kind: "named", name: "this_month" };
  if (/\bmwezi uliopita\b/.test(q)) return { kind: "named", name: "last_month" };
  if (/\btoday\b/.test(q)) return { kind: "named", name: "today" };
  if (/\byesterday\b/.test(q)) return { kind: "named", name: "yesterday" };
  if (/\bthis week\b/.test(q)) return { kind: "named", name: "this_week" };
  if (/\blast week\b/.test(q)) return { kind: "named", name: "last_week" };
  if (/\b(each|every|per) month\b/.test(q)) return { kind: "named", name: "this_month" };
  if (/\bthis month\b/.test(q)) return { kind: "named", name: "this_month" };
  if (/\blast month\b/.test(q)) return { kind: "named", name: "last_month" };
  if (/\bthis year\b/.test(q)) return { kind: "named", name: "this_year" };
  if (/\blast 30 days\b/.test(q)) return { kind: "relative", unit: "day", n: 30 };
  if (/\blast 90 days\b|\bthree months\b/.test(q)) return { kind: "relative", unit: "day", n: 90 };

  // "in September" / "September" -> that month in the current or previous year.
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const mm = new RegExp(`\\b(${months.join("|")})\\b`).exec(q);
  if (mm) {
    const idx = months.indexOf(mm[1]!);
    const d = new Date(now + 3 * 3_600_000);
    let year = d.getUTCFullYear();
    if (idx > d.getUTCMonth()) year--;
    const from = Date.UTC(year, idx, 1) - 3 * 3_600_000;
    const to = Date.UTC(year, idx + 1, 1) - 3 * 3_600_000;
    return { kind: "absolute", fromMs: from, toMs: to };
  }
  return undefined;
}

function pickAmounts(q: string): Pick<PlanFilters, "minAmountCents" | "maxAmountCents"> {
  const n = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
  const between = /\bbetween\s+(?:ksh|kes)?\s*([\d,.]+)\s*(?:and|to|-)\s*(?:ksh|kes)?\s*([\d,.]+)/.exec(q);
  if (between) return { minAmountCents: n(between[1]!), maxAmountCents: n(between[2]!) };
  const over = /\b(?:over|above|more than|greater than|at least|from)\s+(?:ksh|kes)?\s*([\d,.]+)/.exec(q);
  const under = /\b(?:under|below|less than|cheaper than|up to|max)\s+(?:ksh|kes)?\s*([\d,.]+)/.exec(q);
  const out: Pick<PlanFilters, "minAmountCents" | "maxAmountCents"> = {};
  if (over) out.minAmountCents = n(over[1]!);
  if (under) out.maxAmountCents = n(under[1]!);
  return out;
}

function pickLimit(q: string): number | undefined {
  const m = /\btop\s+(\d{1,3})\b/.exec(q) ?? /\bfirst\s+(\d{1,3})\b/.exec(q) ?? /\b(\d{1,3})\s+(?:biggest|largest|top)\b/.exec(q);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, n) : undefined;
}

function pickLabels(q: string, opts: RouteOptions): string[] | undefined {
  const vocab = new Set([...(opts.labels ?? SEED_LABELS.map((l) => l.name)), ...Object.values(SYNONYMS)]);
  const found = new Set<string>();
  for (const [word, label] of Object.entries(SYNONYMS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) found.add(label);
  }
  for (const label of vocab) {
    if (label.length > 3 && q.includes(label.toLowerCase())) found.add(label);
  }
  return found.size ? [...found] : undefined;
}

function pickTags(q: string, opts: RouteOptions): string[] | undefined {
  const found: string[] = [];
  const re = /\b(?:tagged|tag|#)\s*([a-z0-9 &'-]{2,40})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const candidate = m[1]!.trim().replace(/\s+(this|last|today|yesterday)\b.*$/, "").trim();
    if (candidate) found.push(candidate);
  }
  for (const t of opts.tags ?? []) if (t.length > 2 && q.includes(t.toLowerCase())) found.push(t);
  if (!found.length) return undefined;
  const seen = new Map<string, string>();
  for (const t of found) {
    const key = t.toLowerCase();
    if (!seen.has(key) || (opts.tags ?? []).includes(t)) seen.set(key, t);
  }
  return [...seen.values()];
}

function pickCounterparties(q: string, opts: RouteOptions): string[] | undefined {
  const found = new Set<string>();
  for (const cp of opts.counterparties ?? []) {
    if (!cp || cp.length < 3) continue;
    const needle = cp.toLowerCase();
    if (q.includes(needle)) found.add(cp);
  }
  // "at X" / "from X" / "to X" for short proper-noun-ish names not in the vocabulary.
  const m = /\b(?:at|from|to|with)\s+([a-z][a-z0-9&' -]{2,30})\b/.exec(q);
  if (m) {
    const name = m[1]!.trim().replace(/\s+(this|last|today|yesterday|month|week|year|on|for|and)\b.*$/, "").trim();
    const fundingWord = /^(my |the )?(wallet|cash|money|account|credit|fuliza|loan|mkopo)( |$)/.test(name);
    if (name.length >= 3 && !STOP.has(name) && !fundingWord && !Object.keys(SYNONYMS).some((w) => name === w)) found.add(name);
  }
  if (!found.size) return undefined;
  const seen = new Map<string, string>();
  for (const cp of found) {
    const key = cp.toLowerCase();
    if (!seen.has(key) || (opts.counterparties ?? []).includes(cp)) seen.set(key, cp);
  }
  return [...seen.values()];
}

function pickItems(q: string, opts: RouteOptions): string[] | undefined {
  const found = new Set<string>();
  const vocab = [...(opts.items ?? [])];
  for (const [word, canonical] of Object.entries(ITEM_SYNONYMS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) found.add(canonical);
  }
  for (const item of vocab) {
    const n = item.toLowerCase();
    if (n.length >= 3 && q.includes(n)) found.add(item);
  }
  // "how much on X" for an item the vocabulary knows, with typos handled by trigram-ish containment.
  const m = /\b(?:on|for|kwa|ya)\s+([a-z][a-z0-9 '-]{2,30})\b/.exec(q);
  if (m) {
    const phrase = m[1]!.trim().replace(/\s+(this|last|today|yesterday|month|week|year|huu|uliopita)\b.*$/, "").trim();
    const best = vocab.find((it) => {
      const a = it.toLowerCase(), b = phrase;
      if (a === b || a.includes(b) || b.includes(a)) return true;
      return trigram(a, b) >= 0.6;
    });
    if (best) found.add(best);
  }
  return found.size ? [...found] : undefined;
}

function trigrams(s: string): Set<string> {
  const t = s.replace(/[^a-z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}
function trigram(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

function pickHabits(q: string, opts: RouteOptions): string[] | undefined {
  const found = (opts.habits ?? []).filter((h) => h.length >= 3 && q.includes(h.toLowerCase()));
  return found.length ? found : undefined;
}

function pickFunding(q: string): PlanFilters["funding"] {
  if (/\bfuliza\b|\bokoa\b|\bcredit[- ]funded\b|\bkwa mkopo\b|\bwith credit\b|\bon credit\b|\bcredit card\b/.test(q)) return "credit";
  if (/\bwallet\b|\bcash\b|\bpesa yangu\b/.test(q)) return "wallet";
  return undefined;
}

function pickHourWindow(q: string): PlanFilters["hourWindow"] {
  if (/\b(late night|late-night|usiku|at night|night)\b/.test(q)) return { startMin: 22 * 60, endMin: 5 * 60 };
  if (/\b(after (?:10|11) ?pm|after 22:00)\b/.test(q)) return { startMin: 22 * 60, endMin: 24 * 60 - 1 };
  if (/\b(asubuhi|morning)\b/.test(q)) return { startMin: 5 * 60, endMin: 12 * 60 };
  if (/\b(mchana|afternoon)\b/.test(q)) return { startMin: 12 * 60, endMin: 17 * 60 };
  if (/\b(jioni|evening)\b/.test(q)) return { startMin: 17 * 60, endMin: 22 * 60 };
  return undefined;
}

function pickWeekdays(q: string): number[] | undefined {
  const days: Array<[RegExp, number]> = [
    [/\b(sundays?|jumapili)\b/, 0], [/\b(mondays?|jumatatu)\b/, 1], [/\b(tuesdays?|jumanne)\b/, 2],
    [/\b(wednesdays?|jumatano)\b/, 3], [/\b(thursdays?|alhamisi)\b/, 4], [/\b(fridays?|ijumaa)\b/, 5], [/\b(saturdays?|jumamosi)\b/, 6],
  ];
  const found = days.filter(([re]) => re.test(q)).map(([, d]) => d);
  return found.length ? found : undefined;
}

function measureDirection(measure: QueryPlan["measure"], q: string): PlanDirection | undefined {
  if (/\b(receive|received|income|earned|money in|came in|deposit)\b/.test(q)) return "in";
  if (measure === "income") return "in";
  if (measure === "spend" || measure === "fees") return "out";
  return undefined;
}

export function routeQuestion(question: string, now: number, opts: RouteOptions = {}): RouteResult {
  const q = clean(question);
  if (!q) return { ok: false, source: "rules", explanation: "", needs: { slot: "question", question: "What would you like to know about your money?" } };

  // Advice/judgement questions are not a ledger query. Clarify instead of returning a misleading total.
  if (/\b(should i|under control|am i wasting|how can i|what should i do|why (is|are|does|do)|help me|nifanye nini)\b/.test(q)) {
    return {
      ok: false, source: "rules", explanation: "",
      needs: {
        slot: "measure",
        question: "I can show the numbers behind that, but I will not guess advice. What should I measure?",
        options: ["Spending by category", "Income vs spending", "Fees", "Top merchants", "A venture's profit"],
      },
    };
  }
  const summary = /\b(how am i doing|how am i|summary|overview|how is my money|how's my money|status)\b/.test(q);
  const time = parseQuestionTime(q, now);
  const groupBy = pickGroup(q);
  const measure = pickMeasure(q) ?? (summary ? "net" : groupBy ? "spend" : null);
  const tags = pickTags(q, opts);
  const items = pickItems(q, opts);
  const habits = pickHabits(q, opts);
  const funding = pickFunding(q);
  const hourWindow = pickHourWindow(q);
  const weekdays = pickWeekdays(q);
  const counterparties = pickCounterparties(q, opts);
  const labelsRaw = pickLabels(q, opts);
  // "fees" is a measure, not a category; only filter by "Fees & charges" when the user says category.
  const labels = (measure === "fees"
    ? labelsRaw?.filter((l) => l !== "Fees & charges")
    : labelsRaw)?.filter((l) => !(funding === "credit" && l === "Debt repayment"));
  const amounts = pickAmounts(q);
  const limit = pickLimit(q);
  const direction = measureDirection(measure ?? "spend", q);

  if (!measure) {
    return {
      ok: false, source: "rules", explanation: "",
      needs: {
        slot: "measure",
        question: "I can answer this from your ledger. What should I measure?",
        options: ["Spending by category", "Income vs spending", "Fees", "Top merchants", "A venture's profit"],
      },
    };
  }

  // A category word plus "food"-style intent should not become a measurement filter for count.
  const filters: PlanFilters = {};
  if (time) filters.time = time;
  // Free text (e.g. "kale", a shop name the vocab did not match) becomes a note/counterparty filter.
  const consumed = new Set([
    ...Object.keys(SYNONYMS).filter((w) => q.includes(w)),
    ...Object.keys(ITEM_SYNONYMS).filter((w) => q.includes(w)),
    ...(items ?? []).map((i) => i.toLowerCase()),
    ...(labels ?? []).map((l) => l.toLowerCase()),
    ...(tags ?? []).map((t) => t.toLowerCase()),
    ...(counterparties ?? []).map((c) => c.toLowerCase()),
    ...(weekdays ?? []).flatMap((d) => [["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][d]!, `${["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][d]}s`, ["jumapili","jumatatu","jumanne","jumatano","alhamisi","ijumaa","jumamosi"][d]!]),
    ...(funding ? [funding, "wallet", "cash", "credit", "fuliza", "loan", "mkopo", "funded"] : []),
    ...(hourWindow ? ["late", "night", "after", "morning", "afternoon", "evening", "asubuhi", "mchana", "jioni", "usiku", "10pm", "11pm", "22:00"] : []),
    "amount", "cost", "costs", "damage", "share", "percentage", "percent", "proportion", "asilimia",
    "send", "sent", "buy", "bought", "burn", "burned", "blow", "blew", "make", "made", "put", "into",
    "progress", "tracking", "doing", "out", "have", "each", "every", "per", "day", "days", "weekday", "weekdays",
    "whats", "what's", "tell", "show", "list", "give",
  ]);
  const FILLER = new Set([
    "today", "yesterday", "tomorrow", "week", "month", "year", "this", "last", "next", "previous", "past",
    "late", "night", "after", "before", "morning", "afternoon", "evening", "am", "pm", "o", "clock",
    "wallet", "cash", "credit", "fuliza", "loan", "mkopo", "funded", "funding", "kwa", "ya", "na",
    "kiasi", "gani", "wapi", "zinaenda", "wasting", "waste", "overspend", "overspent", "worst", "control",
    "should", "less", "more", "profit", "profitable", "venture", "ventures", "habit", "habits", "item", "items",
    "late-night", "late", "night", "doh", "mbao", "finje", "ganji", "asilimia", "gharama", "ada",
    "whats", "what's", "out", "have", "buy", "bought", "burn", "burned", "blow", "blew", "make", "made",
    "send", "sent", "put", "into", "each", "every", "per", "day", "days", "progress", "cost", "costs",
    "damage", "share", "percentage", "percent", "proportion", "credit-funded", "funded", "funding", "10pm", "11pm", "22:00", "ijumaa", "friday",
    "fridays", "saturday", "saturdays", "sunday", "sundays", "monday", "mondays", "tuesday", "tuesdays",
    "wednesday", "wednesdays", "thursday", "thursdays", "jumapili", "jumatatu", "jumanne", "jumatano", "alhamisi", "jumamosi",
  ]);
  const leftover = q.split(/[^\p{L}\p{N}_'-]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !FILLER.has(w) && !consumed.has(w) && !/^(\d+|ksh|kes)$/i.test(w))
    .slice(0, 3);
  if (leftover.length) filters.text = leftover.join(" ");
  if (direction) filters.direction = direction;
  if (labels?.length) filters.labels = labels;
  if (tags?.length) filters.tags = tags;
  if (counterparties?.length) filters.counterparties = counterparties;
  if (items?.length) filters.items = items;
  if (habits?.length) filters.habits = habits;
  if (funding) filters.funding = funding;
  if (hourWindow) filters.hourWindow = hourWindow;
  if (weekdays?.length) filters.weekdays = weekdays;
  if (amounts.minAmountCents != null) filters.minAmountCents = amounts.minAmountCents;
  if (amounts.maxAmountCents != null) filters.maxAmountCents = amounts.maxAmountCents;

  const plan: QueryPlan = { version: 1, measure };
  if (groupBy) plan.groupBy = groupBy;
  if (Object.keys(filters).length) plan.filters = filters;
  if (limit) plan.limit = limit;
  if (summary) {
    plan.groupBy = ["label"];
    plan.compare = { to: { kind: "named", name: "last_month" } };
    plan.limit = 8;
  }
  if (/\b(what changed|compared|compare|versus|vs|than last)\b/.test(q) || summary) {
    const range = resolveRange(filters.time, now);
    if (!plan.compare) {
      plan.compare = { to: { kind: "absolute", fromMs: range.previous.from, toMs: range.previous.to } };
    }
  }

  const range = resolveRange(filters.time, now);
  const bits = [`${measure}`, groupBy ? `by ${groupBy.join("+")}` : "total", range.label];
  if (labels?.length) bits.push(labels.join(", "));
  if (tags?.length) bits.push(`tag ${tags.join(", ")}`);
  if (counterparties?.length) bits.push(counterparties.join(", "));
  if (items?.length) bits.push(`item ${items.join(", ")}`);
  if (habits?.length) bits.push(`habit ${habits.join(", ")}`);
  if (funding) bits.push(`${funding}-funded`);
  if (hourWindow) bits.push(`${Math.floor(hourWindow.startMin / 60)}:${String(hourWindow.startMin % 60).padStart(2, "0")}–${Math.floor(hourWindow.endMin / 60)}:${String(hourWindow.endMin % 60).padStart(2, "0")}`);
  if (weekdays?.length) bits.push(`weekdays ${weekdays.join(",")}`);
  return { ok: true, plan, summary, source: "rules", explanation: bits.join(" · ") };
}
