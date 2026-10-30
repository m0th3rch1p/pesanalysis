/**
 * Persona packs are DATA: default ventures, KPIs and vocabulary for common Kenyan livelihoods
 * and life stages. Applying one never hard-codes the user into it; the profile can hold several.
 */
import type { DbAdapter } from "../db/migrate.js";
import { createTag, createVenture } from "../tags/store.js";
import { recordFact, setProfile } from "../profile/store.js";
import type { LanguagePack, TonePack, VerticalPack } from "./types.js";

export interface BuiltinPack extends VerticalPack {
  occupation: string;
  blurb: string;
}

const month = { kind: "named", name: "this_month" } as const;

export const PACKS: BuiltinPack[] = [
  {
    id: "mama_mboga", name: "Mama mboga / produce vendor", occupation: "produce vendor",
    blurb: "Daily sales, stock runs and market transport.",
    defaultTags: [
      { name: "Stock", kind: "venture", ventureKind: "business" },
      { name: "Market transport", kind: "venture", ventureKind: "business" },
      { name: "Stall costs", kind: "venture", ventureKind: "business" },
    ],
    kpis: [
      { id: "sales_today", label: "Sales today", plan: { version: 1, measure: "income", filters: { time: { kind: "named", name: "today" } } } },
      { id: "stock_month", label: "Stock spend", plan: { version: 1, measure: "spend", filters: { time: month, tags: ["Stock"] } } },
      { id: "top_customer", label: "Top customer", plan: { version: 1, measure: "income", groupBy: ["counterparty"], filters: { time: month }, limit: 3 } },
    ],
    questionTemplates: [
      { kind: "unknown_role", prompt: "Who is {name} — a customer, a supplier, or someone else?" },
      { kind: "untagged_cluster", prompt: "Is {name} part of your stock run?" },
    ],
    vocabulary: { stock: ["Stock"], transport: ["Market transport"], stall: ["Stall costs"], customer: ["customer"], supplier: ["supplier"] },
  },
  {
    id: "boda_rider", name: "Boda rider", occupation: "boda rider",
    blurb: "Fuel, maintenance, daily target and loan cycles.",
    defaultTags: [
      { name: "Fuel", kind: "venture", ventureKind: "business" },
      { name: "Bike maintenance", kind: "venture", ventureKind: "business" },
      { name: "Daily target", kind: "venture", ventureKind: "savings_goal" },
    ],
    kpis: [
      { id: "fuel_month", label: "Fuel spend", plan: { version: 1, measure: "spend", filters: { time: month, tags: ["Fuel"] } } },
      { id: "net_today", label: "Net today", plan: { version: 1, measure: "net", filters: { time: { kind: "named", name: "today" } } } },
      { id: "loan_repay", label: "Loan repayments", plan: { version: 1, measure: "spend", filters: { time: month, labels: ["Debt repayment"] } } },
    ],
    questionTemplates: [{ kind: "untagged_cluster", prompt: "Is {name} a fuel stop you use regularly?" }],
    vocabulary: { fuel: ["Fuel"], garage: ["Bike maintenance"], target: ["Daily target"], fuliza: ["Debt repayment"] },
  },
  {
    id: "salaried_professional", name: "Salaried professional", occupation: "salaried employee",
    blurb: "Rent, commute, savings rate and fees.",
    defaultTags: [
      { name: "Rent", kind: "venture", ventureKind: "business" },
      { name: "Commute", kind: "venture", ventureKind: "business" },
      { name: "Savings goal", kind: "venture", ventureKind: "savings_goal" },
    ],
    kpis: [
      { id: "net_month", label: "Net this month", plan: { version: 1, measure: "net", filters: { time: month } } },
      { id: "eating_out", label: "Eating out", plan: { version: 1, measure: "spend", filters: { time: month, labels: ["Eating out"] } } },
      { id: "fees", label: "Fees", plan: { version: 1, measure: "fees", filters: { time: month } } },
    ],
    questionTemplates: [{ kind: "venture_boundary", prompt: "Should {name} be counted as a work expense?" }],
    vocabulary: { rent: ["Rent"], commute: ["Commute"], savings: ["Savings goal"], fees: ["Fees & charges"] },
  },
  {
    id: "freelancer", name: "Freelancer / hustler", occupation: "freelancer",
    blurb: "Client income, tools, and irregular cash flow.",
    defaultTags: [
      { name: "Client work", kind: "venture", ventureKind: "business" },
      { name: "Tools", kind: "venture", ventureKind: "business" },
      { name: "Tax reserve", kind: "venture", ventureKind: "savings_goal" },
    ],
    kpis: [
      { id: "income_month", label: "Income", plan: { version: 1, measure: "income", filters: { time: month } } },
      { id: "top_client", label: "Top client", plan: { version: 1, measure: "income", groupBy: ["counterparty"], filters: { time: month }, limit: 3 } },
      { id: "tools_month", label: "Tools spend", plan: { version: 1, measure: "spend", filters: { time: month, tags: ["Tools"] } } },
    ],
    questionTemplates: [{ kind: "income_type", prompt: "Is {name} a client, an employer, or a refund?" }],
    vocabulary: { client: ["Client work"], tools: ["Tools"], tax: ["Tax reserve"] },
  },
  {
    id: "student", name: "Student", occupation: "student",
    blurb: "Food, transport, books and support from home.",
    defaultTags: [
      { name: "Food", kind: "venture", ventureKind: "business" },
      { name: "Campus transport", kind: "venture", ventureKind: "business" },
      { name: "Books", kind: "venture", ventureKind: "business" },
    ],
    kpis: [
      { id: "food_month", label: "Food spend", plan: { version: 1, measure: "spend", filters: { time: month, tags: ["Food"] } } },
      { id: "support_in", label: "Support received", plan: { version: 1, measure: "income", filters: { time: month } } },
      { id: "transport", label: "Transport", plan: { version: 1, measure: "spend", filters: { time: month, labels: ["Transport"] } } },
    ],
    questionTemplates: [{ kind: "unknown_role", prompt: "Is {name} family, a friend, or a school contact?" }],
    vocabulary: { food: ["Food"], transport: ["Campus transport"], books: ["Books"] },
  },
  {
    id: "small_shop", name: "Small shop / duka", occupation: "shop owner",
    blurb: "Sales, stock, rent and staff pay.",
    defaultTags: [
      { name: "Shop stock", kind: "venture", ventureKind: "business" },
      { name: "Shop rent", kind: "venture", ventureKind: "business" },
      { name: "Staff pay", kind: "venture", ventureKind: "business" },
    ],
    kpis: [
      { id: "sales_month", label: "Sales", plan: { version: 1, measure: "income", filters: { time: month } } },
      { id: "stock_month", label: "Stock", plan: { version: 1, measure: "spend", filters: { time: month, tags: ["Shop stock"] } } },
      { id: "shop_net", label: "Shop net", plan: { version: 1, measure: "net", filters: { time: month } } },
    ],
    questionTemplates: [{ kind: "untagged_cluster", prompt: "Is {name} a supplier for the shop?" }],
    vocabulary: { stock: ["Shop stock"], rent: ["Shop rent"], staff: ["Staff pay"], supplier: ["supplier"] },
  },
];

export function getPack(id: string): BuiltinPack | undefined {
  return PACKS.find((p) => p.id === id);
}

export function applyPack(db: DbAdapter, id: string, now = Date.now()): { verticals: string[]; tags: number; ventures: number; kpiPlans: number } {
  const pack = getPack(id);
  if (!pack) throw new Error(`unknown pack: ${id}`);
  let tags = 0;
  let ventures = 0;
  for (const t of pack.defaultTags) {
    if (t.kind === "venture") {
      createVenture(db, t.name, t.ventureKind ?? "business");
      ventures++;
    } else {
      createTag(db, t.name, "user");
      tags++;
    }
  }
  const current = db.get(`SELECT value FROM profile WHERE key = 'verticals'`);
  let verticals: string[] = [];
  try { verticals = JSON.parse(current?.value ?? "[]") as string[]; } catch { verticals = []; }
  if (!verticals.includes(id)) verticals.push(id);
  setProfile(db, { verticals }, now);
  recordFact(db, "user", "occupation", pack.occupation, { confidence: 0.7, source: "user", evidence: { pack: id } }, now);
  return { verticals, tags, ventures, kpiPlans: pack.kpis.length };
}

export const TONES: TonePack[] = [
  {
    id: "plain", name: "Plain English",
    systemFragment: "Speak plainly and briefly. Use short sentences. Never use hype or shame.",
    glossary: {},
  },
  {
    id: "pesa", name: "Pesa (Swahili-English)",
    systemFragment: "Speak in simple Kenyan English with everyday Swahili money words (pesa, mapato, matumizi, ada, deni, biashara). Keep every number exact.",
    glossary: { money: "pesa", income: "mapato", spending: "matumizi", fees: "ada", debt: "deni", business: "biashara" },
  },
  {
    id: "sheng_lite", name: "Sheng-lite",
    systemFragment: "Use light, widely understood Nairobi slang sparingly (pesa, msee, duka, chapo). Never force slang; clarity wins. Keep every number exact.",
    glossary: { money: "pesa", shop: "duka", food: "chapo", person: "msee" },
  },
];

export const LANGUAGES: LanguagePack[] = [
  { id: "en", name: "English", lexicon: {} },
  { id: "sw", name: "Kiswahili (labels)", lexicon: { Income: "Mapato", Expenses: "Matumizi", "Fees & charges": "Ada", Rent: "Kodi", Fuel: "Mafuta", Salary: "Mshahara", Groceries: "Mboga na vyakula", Transport: "Usafiri", "Savings & investment": "Akiba na uwekezaji", "Debt repayment": "Malipo ya deni" } },
  { id: "mixed", name: "English + Kiswahili", lexicon: { Income: "Mapato", Expenses: "Matumizi", "Fees & charges": "Ada" } },
];

export function toneById(id: string): TonePack {
  return TONES.find((t) => t.id === id) ?? TONES[0]!;
}

export function languageById(id: string): LanguagePack {
  return LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0]!;
}

/** System fragment for the analyst/narrator. The number guard still runs after generation. */
export function systemPromptFor(opts: { tone?: string; language?: string; verticals?: string[] }): string {
  const tone = toneById(opts.tone ?? "plain");
  const lang = languageById(opts.language ?? "en");
  const packs = (opts.verticals ?? []).map(getPack).filter(Boolean) as BuiltinPack[];
  const bits = [
    "You are Pesanalysis, a private on-device financial analyst for a Kenyan mobile-money user.",
    "You explain numbers computed by deterministic code. Never invent a number, date or advice.",
    tone.systemFragment,
  ];
  if (lang.id === "sw" || lang.id === "mixed") bits.push("You may use the Kiswahili label terms supplied; do not translate numbers.");
  for (const p of packs) bits.push(`User context: ${p.name} — ${p.blurb}`);
  return bits.join(" ");
}
