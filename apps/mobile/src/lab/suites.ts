/**
 * Lab suites. Everything here runs ON THE PHONE; scoring against ground truth happens afterwards on the host
 * (tools/lab/score.py) from the JSON the suites emit. Ground truth is deliberately NOT shipped in the app.
 */
import { File, Paths, Directory } from "expo-file-system";
import * as Q from "../qvac";
import { MODELS, type ModelSpec } from "../qvac";
import { emitResult, newRun, now, readMem, say, sleep, stats, type Mem } from "./util";
import { maskForTranslation, preservation, unmask, type PlaceholderStyle } from "./guard";
import { parseReceipt } from "./receipt-parse";

export type Params = Record<string, string>;
export interface SuiteDef { name: string; about: string; run: (p: Params) => Promise<unknown> }

const header = (suite: string, p: Params) => ({
  suite, params: p, startedAt: new Date().toISOString(), device: "itel S688LN (expected)", memStart: readMem(),
  note: "CPU only; models loaded by local path, modelFitPolicy off",
});

async function loadTimed(spec: ModelSpec, p: Params) {
  const m0 = readMem();
  const r = await Q.loadLocal(spec, { threads: p.threads ? Number(p.threads) : undefined, ctxSize: p.ctx ? Number(p.ctx) : undefined });
  const m1 = readMem();
  say(`loaded ${spec.key} in ${r.loadMs}ms rss ${m0.rssKb}->${m1.rssKb} kB`);
  return { ...r, memBefore: m0, memAfter: m1 };
}

// ------------------------------------------------------------------------------------------------ fetch (ONLINE)
async function fetchSuite(p: Params) {
  const id = newRun("fetch");
  const keys = (p.models ?? "").split(",").filter(Boolean);
  const out: unknown[] = [];
  for (const k of keys) {
    const spec = MODELS[k];
    if (!spec) { out.push({ key: k, error: "unknown key" }); continue; }
    try {
      let last = -10;
      const r = await Q.fetchModel(spec, (pc) => { if (pc - last >= 10) { last = pc; say(`fetch ${k} ${pc.toFixed(0)}%`); } });
      const f = Q.localPath(spec);
      let sha: string | undefined;
      try { if (f) sha = await new File(`file://${f.path}`).digest("SHA-256"); } catch (e) { sha = `digest failed: ${e}`; }
      out.push({ key: k, sdkName: spec.sdkName, ms: r.ms, path: f?.path, size: f?.size, sha256: sha, expectedSize: spec.size || undefined, expectedSha256: spec.sha256 || undefined, shaOk: spec.sha256 ? sha === spec.sha256 : undefined });
      say(`fetched ${k}: ${f?.size} bytes sha ${sha}`);
    } catch (e) { out.push({ key: k, error: String(e) }); say(`fetch ${k} FAILED ${e}`); }
  }
  emitResult(id, { ...header("fetch", p), results: out, cached: Q.listCachedModels() });
}

/** Re-hash every cached file (offline-safe) and list sizes: used for the submission table. */
async function verifySuite(p: Params) {
  const id = newRun("verify");
  const res = [];
  for (const f of Q.listCachedModels()) {
    let sha: string | undefined;
    try { sha = await new File(`file://${f.path}`).digest("SHA-256"); } catch (e) { sha = String(e); }
    res.push({ ...f, sha256: sha });
  }
  emitResult(id, { ...header("verify", p), files: res });
}

// ------------------------------------------------------------------------------------------------ Laya
const CATS = {
  food_groceries: "food, groceries, restaurants, market, butchery",
  transport: "matatu, taxi, fuel, bus fare, ride hailing",
  airtime_data: "airtime, data bundles, mobile minutes",
  bills_utilities: "electricity, water, rent, TV, internet, insurance, school fees, paybill bills",
  shopping: "clothes, electronics, hardware, online shopping, general retail",
  loans_credit: "loans, borrowing, repaying loans, Fuliza, credit, lender",
  transfer_p2p: "sending or receiving money from a person or business",
  cash_agent: "cash withdrawal or deposit at an agent or ATM",
  other: "anything else: salary, health, fees, or not a transaction",
} as const;

export const LAYA_QUESTIONS = {
  is_fin: { type: "noul", instructions: "This message reports a completed money transaction: money actually moved (sent, received, paid, withdrawn, deposited, borrowed or repaid)." },
  direction: { type: "choice", instructions: "From the point of view of the phone owner, which way did the money move?", criteria: { in: "money came into the owner's account or wallet", out: "money left the owner's account or wallet", neutral: "no money moved (reminder, promotion, code, balance, chat)" } },
  category: { type: "choice", instructions: "What was the money spent on or received for?", criteria: CATS },
  loan_due: { type: "noul", instructions: "This message tells the owner that a loan or loan repayment is due, overdue or must be paid." },
} as const;

async function layaSuite(p: Params) {
  const id = newRun("laya");
  const data: Array<{ id: string; text: string }> = (await import("./data/laya-sms.json")).default as never;
  const keys = (p.models ?? "laya_ml_322m").split(",");
  const batchSizes = (p.batch ?? "8").split(",").map(Number);
  const limit = p.limit ? Number(p.limit) : data.length;
  const items = data.slice(0, limit);
  const models: unknown[] = [];
  for (const k of keys) {
    const spec = MODELS[k];
    const hd: Record<string, unknown> = { key: k, items: [] as unknown[], batches: [] as unknown[] };
    try {
      Object.assign(hd, await loadTimed(spec, p));
      // warmup (first forward pass pays one-off costs)
      await Q.decide(hd.modelId as string, items[0].text, LAYA_QUESTIONS as never);
      const lat: number[] = [];
      const per: unknown[] = [];
      for (const it of items) {
        const t0 = now();
        const r = await Q.decide(hd.modelId as string, it.text, LAYA_QUESTIONS as never);
        const ms = now() - t0;
        lat.push(ms);
        per.push({ id: it.id, ms, answers: r.results[0].answers, usage: r.results[0].usage });
        if (per.length % 20 === 0) say(`laya ${k} ${per.length}/${items.length}`);
      }
      hd.items = per; hd.latencySingle = stats(lat); hd.memAfterSingle = readMem();
      say(`laya ${k} single p50 ${hd.latencySingle && (hd.latencySingle as { p50: number }).p50}ms`);
      for (const bs of batchSizes) {
        if (bs <= 1) continue;
        const blat: number[] = []; const outs: unknown[] = [];
        const t00 = now();
        for (let i = 0; i < items.length; i += bs) {
          const chunk = items.slice(i, i + bs);
          const t0 = now();
          const r = await Q.decide(hd.modelId as string, chunk.map((c) => c.text), LAYA_QUESTIONS as never, { timeoutMs: 300_000 });
          const ms = now() - t0;
          blat.push(ms / chunk.length);
          chunk.forEach((c, j) => outs.push({ id: c.id, answers: r.results[j]?.answers }));
        }
        (hd.batches as unknown[]).push({ batchSize: bs, totalMs: now() - t00, perItemMs: stats(blat), items: outs });
      }
      // one-question latency (noul only) on 10 items
      const q1: number[] = [];
      for (const it of items.slice(0, 10)) { const t0 = now(); await Q.decide(hd.modelId as string, it.text, { is_fin: LAYA_QUESTIONS.is_fin } as never); q1.push(now() - t0); }
      hd.latencyOneQuestion = stats(q1);
      hd.memEnd = readMem();
    } catch (e) { hd.error = String(e); say(`laya ${k} ERROR ${e}`); }
    models.push(hd);
  }
  emitResult(id, { ...header("laya", p), questions: LAYA_QUESTIONS, models });
}

// Question-wording sweep: tiny zero-shot encoders are very sensitive to wording, so we measure variants ON THE PHONE.
// `map` converts a variant's labels to the canonical labels the host scorer expects.
interface QVar { id: string; concept: "is_fin" | "direction" | "category" | "loan_due"; q: DecisionQuestionLoose; map?: Record<string, string>; wrap?: "sms" }
type DecisionQuestionLoose = Record<string, unknown> & { type: string };
const catShort = { food_groceries: "food and groceries", transport: "transport and fuel", airtime_data: "airtime and data", bills_utilities: "bills, rent and utilities", shopping: "shopping", loans_credit: "loan or credit", transfer_p2p: "money transfer to or from a person", cash_agent: "cash withdrawal or deposit", other: "other" };
export const LAYA_VARIANTS: QVar[] = [
  { id: "fin0", concept: "is_fin", q: LAYA_QUESTIONS.is_fin as never },
  { id: "fin1", concept: "is_fin", q: { type: "noul", instructions: "This message is a payment or money transfer confirmation." } },
  { id: "fin2", concept: "is_fin", q: { type: "noul", instructions: "Money was sent, received, paid or withdrawn." } },
  { id: "fin3", concept: "is_fin", q: { type: "noul", instructions: "This is a transaction receipt from M-PESA, Airtel Money, a bank or a lender." } },
  { id: "fin4", concept: "is_fin", q: { type: "noul", instructions: "The message confirms that a payment has been completed.", labels: { true: "completed payment", false: "not a payment" } } },
  { id: "fin5", concept: "is_fin", wrap: "sms", q: { type: "noul", instructions: "This SMS confirms a completed money transaction." } },
  { id: "fin6", concept: "is_fin", q: { type: "choice", instructions: "What kind of message is this?", criteria: { transaction: "a confirmation that money was sent, received, paid, withdrawn, deposited or borrowed", other: "a reminder, promotion, security code, balance enquiry, failed transaction, notice or personal chat" } }, map: { transaction: "T", other: "F" } },
  { id: "dir0", concept: "direction", q: LAYA_QUESTIONS.direction as never },
  { id: "dir1", concept: "direction", q: { type: "choice", instructions: "Was money received or sent?", criteria: ["received", "sent", "no transaction"] }, map: { received: "in", sent: "out", "no transaction": "neutral" } },
  { id: "dir2", concept: "direction", q: { type: "choice", instructions: "Money flow for the phone owner.", criteria: { in: "received, credited, deposited, borrowed", out: "sent, paid, debited, withdrawn, repaid", neutral: "no money moved: reminder, promo, code, balance, chat" } } },
  { id: "dir3", concept: "direction", q: { type: "choice", instructions: "Which sentence describes this message?", criteria: { in: "You received money.", out: "You sent or paid money.", neutral: "No money was sent or received." } } },
  { id: "cat0", concept: "category", q: LAYA_QUESTIONS.category as never },
  { id: "cat1", concept: "category", q: { type: "choice", instructions: "What is this about?", criteria: Object.values(catShort) }, map: Object.fromEntries(Object.entries(catShort).map(([k, v]) => [v, k])) },
  { id: "cat2", concept: "category", q: { type: "choice", instructions: "Spending category.", criteria: catShort } },
  { id: "loan0", concept: "loan_due", q: LAYA_QUESTIONS.loan_due as never },
  { id: "loan1", concept: "loan_due", q: { type: "noul", instructions: "This message is a loan repayment reminder." } },
  { id: "loan2", concept: "loan_due", q: { type: "noul", instructions: "The sender asks the user to pay back a loan." } },
  { id: "loan3", concept: "loan_due", q: { type: "noul", instructions: "A loan repayment is due or overdue and must be paid.", labels: { true: "repayment due", false: "no repayment due" } } },
];

async function layaPromptSuite(p: Params) {
  const id = newRun("layap");
  const data: Array<{ id: string; text: string }> = (await import("./data/laya-sms.json")).default as never;
  const spec = MODELS[p.model ?? "laya_ml_322m"];
  const only = p.only ? p.only.split(",") : null;
  const bs = Number(p.batch ?? 16);
  const hd: Record<string, unknown> = { key: spec.key };
  const out: unknown[] = [];
  try {
    Object.assign(hd, await loadTimed(spec, p));
    for (const v of LAYA_VARIANTS) {
      if (only && !only.includes(v.id)) continue;
      const rows: unknown[] = []; const t00 = now();
      for (let i = 0; i < data.length; i += bs) {
        const chunk = data.slice(i, i + bs);
        const states = chunk.map((c) => (v.wrap === "sms" ? `SMS: ${c.text}` : c.text));
        const r = await Q.decide(hd.modelId as string, states, { q: v.q } as never, { timeoutMs: 300_000 });
        chunk.forEach((c, j) => rows.push({ id: c.id, a: r.results[j]?.answers?.q }));
      }
      out.push({ variant: v.id, concept: v.concept, map: v.map, totalMs: now() - t00, rows });
      say(`layap ${v.id} done ${now() - t00}ms`);
      emitResult(`${id}-part-${v.id}`, { suite: "layap-part", model: spec.key, variant: v.id, concept: v.concept, map: v.map, totalMs: now() - t00, rows });
    }
  } catch (e) { hd.error = String(e); say(`layap ERROR ${e}`); }
  emitResult(id, { ...header("layap", p), model: hd, variants: out });
}

// ------------------------------------------------------------------------------------------------ AfriSLM translation
const LANG = { "en-sw": ["English", "Swahili"], "sw-en": ["Swahili", "English"], "sheng-en": ["Swahili", "English"] } as const;
const sysPrompt = (s: string, t: string) =>
  `You are a professional ${s} to ${t} translator. Your goal is to accurately convey the meaning and nuances of the original ${s} text while adhering to ${t} grammar, vocabulary, and cultural sensitivities. Produce only the ${t} translation, without any additional explanations or commentary. `;
const userPrompt = (s: string, t: string, text: string) => `Please translate the following ${s} text into ${t}: ${text}.\n\nTranslation:`;

async function translateOne(modelId: string, dir: keyof typeof LANG, text: string) {
  const [s, t] = LANG[dir];
  return Q.complete(modelId, { system: sysPrompt(s, t), user: userPrompt(s, t, text), predict: 200, temp: 0, timeoutMs: 120_000 });
}

async function translateSuite(p: Params) {
  const id = newRun("translate");
  const data: Array<{ id: string; dir: keyof typeof LANG; src: string }> = (await import("./data/translate.json")).default as never;
  const keys = (p.models ?? "afri_08b_q4").split(",");
  const variants = (p.variants ?? "plain,sq,brace,hash").split(",");
  const dirs = (p.dirs ?? "en-sw,sw-en,sheng-en").split(",");
  const limit = p.limit ? Number(p.limit) : 9999;
  const items = data.filter((d) => dirs.includes(d.dir)).slice(0, limit);
  const models: unknown[] = [];
  for (const k of keys) {
    const spec = MODELS[k];
    const hd: Record<string, unknown> = { key: k };
    try {
      Object.assign(hd, await loadTimed(spec, p));
      await translateOne(hd.modelId as string, "en-sw", "Hello."); // warmup
      const rows: unknown[] = [];
      for (const v of variants) {
        for (const it of items) {
          const row: Record<string, unknown> = { id: it.id, dir: it.dir, variant: v, src: it.src };
          try {
            if (v === "plain") {
              const r = await translateOne(hd.modelId as string, it.dir, it.src);
              Object.assign(row, { out: r.text, ms: r.ms, tps: r.tokPerSec, gen: r.generatedTokens, prompt: r.promptTokens, ttft: r.ttftMs, preserve: preservation(it.src, r.text) });
              row.released = r.text;
            } else {
              const m = maskForTranslation(it.src, v as PlaceholderStyle);
              const r = await translateOne(hd.modelId as string, it.dir, m.text);
              const u = unmask(r.text, m);
              const pres = preservation(it.src, u.text);
              Object.assign(row, { masked: m.text, rawOut: r.text, tokens: m.tokens, guardOk: u.ok, guardReason: u.reason, ms: r.ms, tps: r.tokPerSec, gen: r.generatedTokens, prompt: r.promptTokens, ttft: r.ttftMs, preserve: pres });
              row.out = u.text;
              // fail-closed release: only released if guard passed AND the restored text still preserves every token
              row.released = u.ok && pres.strict ? u.text : null;
            }
          } catch (e) { row.error = String(e); }
          rows.push(row);
          if (rows.length % 10 === 0) say(`translate ${k} ${v} ${rows.length}`);
        }
        say(`translate ${k} variant ${v} done (${rows.length} rows)`);
        emitResult(`${id}-part-${k}-${v}`, { suite: "translate-part", key: k, variant: v, rows: rows.slice(-items.length) });
      }
      hd.rows = rows; hd.memEnd = readMem();
    } catch (e) { hd.error = String(e); say(`translate ${k} ERROR ${e}`); }
    models.push(hd);
  }
  emitResult(id, { ...header("translate", p), prompt: { system: sysPrompt("{S}", "{T}"), user: userPrompt("{S}", "{T}", "{TEXT}") }, models });
}

// ------------------------------------------------------------------------------------------------ Qwen3 baseline
async function qwenSuite(p: Params) {
  const id = newRun("qwen");
  const spec = MODELS[p.model ?? "qwen3_06b"];
  const hd: Record<string, unknown> = { key: spec.key };
  const prompts = [
    { id: "hello_sw", user: "Say hello in Swahili in one short sentence.", predict: 40 },
    { id: "narrate", system: "You write one plain sentence. Use only the facts given.", user: "Facts: 6 payments, total KES 2,705, between 9:05 AM and 12:25 PM on 26 October, largest to PETER KAMAU. Write one sentence.", predict: 80 },
    { id: "extract_json", system: "Extract fields as JSON.", user: "TXZ9Y8X7W6 Confirmed. Ksh1,450.00 paid to SAMPLE SUPERMARKET WESTLANDS. on 12/10/26 at 6:40 PM. New M-PESA balance is Ksh800.00.", predict: 120,
      responseFormat: { type: "json_schema", json_schema: { name: "tx", strict: true, schema: { type: "object", properties: { direction: { type: "string", enum: ["in", "out"] }, amount: { type: "number" }, counterparty: { type: "string" }, balance: { type: "number" }, ref: { type: "string" } }, required: ["direction", "amount", "counterparty", "balance", "ref"], additionalProperties: false } } } },
    { id: "summarise", user: "Summarise in one sentence: Rent KES 15,000 on the 1st, electricity KES 1,200, water KES 850, food about KES 8,000, transport KES 3,000. Income KES 38,000.", predict: 80 },
  ];
  try {
    Object.assign(hd, await loadTimed(spec, p));
    const reps = Number(p.reps ?? 3);
    const rows: unknown[] = [];
    for (const pr of prompts) for (let r = 0; r < reps; r++) {
      const o = await Q.complete(hd.modelId as string, { system: (pr as { system?: string }).system, user: pr.user, predict: pr.predict, temp: 0, responseFormat: (pr as { responseFormat?: unknown }).responseFormat });
      rows.push({ id: pr.id, rep: r, ms: o.ms, tps: o.tokPerSec, ttft: o.ttftMs, gen: o.generatedTokens, prompt: o.promptTokens, text: o.text });
    }
    hd.rows = rows; hd.memEnd = readMem();
  } catch (e) { hd.error = String(e); }
  emitResult(id, { ...header("qwen", p), model: hd });
}

// ------------------------------------------------------------------------------------------------ OCR
async function ocrSuite(p: Params) {
  const id = newRun("ocr");
  const imgs: Array<{ id: string; png: string }> = (await import("./data/receipts.json")).default as never;
  const hd: Record<string, unknown> = { key: "ocr_latin" };
  const rows: unknown[] = [];
  try {
    const dir = new Directory(Paths.cache, "lab-ocr");
    if (!dir.exists) dir.create({ intermediates: true });
    Object.assign(hd, await loadTimed(MODELS.ocr_latin, p));
    const reps = Number(p.reps ?? 1);
    for (const im of imgs.slice(0, p.limit ? Number(p.limit) : 999)) {
      const f = new File(dir, `${im.id}.png`);
      f.create({ overwrite: true });
      f.write(im.png, { encoding: "base64" });
      for (let r = 0; r < reps; r++) {
        const m0 = readMem();
        try {
          const o = await Q.ocrImage(hd.modelId as string, f.uri);
          const lines = o.blocks.map((b) => b.text);
          rows.push({ id: im.id, rep: r, ms: o.ms, blocks: o.blocks, parsed: parseReceipt(lines), stats: o.stats, rssBefore: m0.rssKb, rssAfter: readMem().rssKb });
        } catch (e) { rows.push({ id: im.id, rep: r, error: String(e) }); }
      }
    }
    hd.memEnd = readMem();
  } catch (e) { hd.error = String(e); say(`ocr ERROR ${e}`); }
  emitResult(id, { ...header("ocr", p), model: hd, rows });
}

// ------------------------------------------------------------------------------------------------ co-residency
async function coresSuite(p: Params) {
  const id = newRun("cores");
  const durMs = Number(p.durSec ?? 1800) * 1000;
  const sms: Array<{ id: string; text: string }> = (await import("./data/laya-sms.json")).default as never;
  const tr: Array<{ id: string; dir: keyof typeof LANG; src: string }> = (await import("./data/translate.json")).default as never;
  const useOcr = p.ocr !== "0";
  const hd: Record<string, unknown> = { models: {} as Record<string, unknown> };
  const mem: unknown[] = [];
  const ops: unknown[] = [];
  const loads: Record<string, unknown> = {};
  const mk = (k: string) => MODELS[k];
  const t00 = now();
  const sample = (tag: string) => { const m = readMem(); mem.push({ t: now() - t00, tag, ...m }); return m; };
  sample("start");
  try {
    for (const k of ["laya_ml_322m", "afri_08b_q4", "qwen3_06b", ...(useOcr ? ["ocr_latin"] : [])]) {
      loads[k] = await loadTimed(mk(k), p);
      sample(`after-load-${k}`);
    }
    hd.loads = loads;
    let imgs: Array<{ id: string; png: string }> = [];
    if (useOcr) {
      imgs = (await import("./data/receipts.json")).default as never;
      const dir = new Directory(Paths.cache, "lab-ocr"); if (!dir.exists) dir.create({ intermediates: true });
      for (const im of imgs) { const f = new File(dir, `${im.id}.png`); f.create({ overwrite: true }); f.write(im.png, { encoding: "base64" }); }
    }
    const lid = (loads.laya_ml_322m as { modelId: string }).modelId;
    const aid = (loads.afri_08b_q4 as { modelId: string }).modelId;
    const qid = (loads.qwen3_06b as { modelId: string }).modelId;
    const oid = useOcr ? (loads.ocr_latin as { modelId: string }).modelId : "";
    const timed = async (op: string, fn: () => Promise<unknown>, phase: string) => {
      const t0 = now();
      try { await fn(); ops.push({ t: t0 - t00, op, phase, ms: now() - t0 }); }
      catch (e) { ops.push({ t: t0 - t00, op, phase, ms: now() - t0, error: String(e) }); }
    };
    let i = 0;
    const task = {
      laya: () => timed("laya1", () => Q.decide(lid, sms[i % sms.length].text, LAYA_QUESTIONS as never), "x"),
      layaB: () => timed("laya8", () => Q.decide(lid, sms.slice(i % 100, (i % 100) + 8).map((s) => s.text), LAYA_QUESTIONS as never), "x"),
      tr: () => timed("translate", () => translateOne(aid, tr[i % 60].dir, tr[i % 60].src), "x"),
      qwen: () => timed("qwen", () => Q.complete(qid, { user: "Say hello in Swahili in one short sentence.", predict: 40 }), "x"),
      ocr: () => timed("ocr", () => Q.ocrImage(oid, `${Paths.cache.uri}lab-ocr/${imgs[i % imgs.length].id}.png`), "x"),
    };
    const names = ["laya", "tr", "qwen", "layaB", ...(useOcr ? ["ocr"] : [])] as Array<keyof typeof task>;
    // phase A: each op alone (baseline in the SAME co-resident state), 5 reps
    const base: Record<string, number[]> = {};
    for (const n of names) {
      for (let r = 0; r < 5; r++) { const n0 = ops.length; i++; await task[n](); const o = ops[n0] as { ms: number; error?: string }; (base[n] ??= []).push(o.ms); }
      say(`baseline ${n} ${JSON.stringify(stats(base[n]))}`);
    }
    hd.baselineCoResident = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, stats(v)]));
    sample("after-baseline");
    // phase B: mixed round-robin until time is up, memory sample every 10 s, concurrent burst every 5th round
    let lastMem = now(); let round = 0;
    const tEnd = now() + durMs;
    while (now() < tEnd) {
      round++;
      if (round % 5 === 0) await Promise.all([task.laya(), task.tr(), task.qwen()]).then(() => i++);
      else for (const n of names) { i++; await task[n](); }
      if (now() - lastMem >= 10_000) { lastMem = now(); sample("mixed"); say(`mixed t=${Math.round((now() - t00) / 1000)}s rss=${readMem().rssKb}`); }
    }
    hd.rounds = round;
    sample("end");
  } catch (e) { hd.error = String(e); say(`cores ERROR ${e}`); }
  emitResult(id, { ...header("cores", p), ...hd, mem, ops });
}

// ------------------------------------------------------------------------------------------------ unload re-test
async function unloadSuite(p: Params) {
  const id = newRun("unload");
  const keys = (p.models ?? "laya_ml_322m,afri_08b_q4,qwen3_06b,ocr_latin").split(",");
  const rows: unknown[] = [];
  for (const k of keys) {
    const row: Record<string, unknown> = { key: k, memBeforeLoad: readMem() };
    try {
      Object.assign(row, { load: await loadTimed(MODELS[k], p) });
      row.memLoaded = readMem();
      await sleep(1500);
      row.unload = await Q.unload(k, Number(p.timeoutSec ?? 30) * 1000);
      await sleep(3000);
      row.memAfterUnload = readMem();
    } catch (e) { row.error = String(e); }
    rows.push(row);
    emitResult(`${id}-part-${k}`, { suite: "unload-part", row });
  }
  const closeR = p.close === "0" ? undefined : await Q.shutdown(20_000);
  await sleep(3000);
  emitResult(id, { ...header("unload", p), rows, shutdown: closeR, memAfterShutdown: readMem() });
}

// ------------------------------------------------------------------------------------------------ misc
async function sysSuite(p: Params) {
  const id = newRun("sys");
  const s = await Q.sdk();
  let sys: unknown, err: string | undefined;
  try { sys = await s.getSystemResources(); } catch (e) { err = String(e); }
  emitResult(id, { ...header("sys", p), sys, err, cached: Q.listCachedModels(), crash: Q.crashState() });
}

export const SUITES: Record<string, SuiteDef> = {
  sys: { name: "sys", about: "worker start + system resources + cached files", run: sysSuite },
  fetch: { name: "fetch", about: "ONLINE: download models (models=key,key)", run: fetchSuite },
  verify: { name: "verify", about: "sha256 of every cached gguf", run: verifySuite },
  laya: { name: "laya", about: "Laya decide(): accuracy data, latency, batch", run: layaSuite },
  layap: { name: "layap", about: "Laya question-wording sweep", run: layaPromptSuite },
  translate: { name: "translate", about: "AfriSLM translation + guard", run: translateSuite },
  qwen: { name: "qwen", about: "Qwen3-0.6B baseline", run: qwenSuite },
  ocr: { name: "ocr", about: "receipt OCR", run: ocrSuite },
  cores: { name: "cores", about: "co-residency soak (durSec=1800)", run: coresSuite },
  unload: { name: "unload", about: "unload re-test per model", run: unloadSuite },
};

export async function runSuites(spec: string, params: Params, log: (s: string) => void = say) {
  for (const name of spec.split(",").filter(Boolean)) {
    const s = SUITES[name];
    if (!s) { log(`unknown suite ${name}`); continue; }
    const cs = Q.crashState();
    log(`=== suite ${name} params ${JSON.stringify(params)} crash=${JSON.stringify(cs)}`);
    Q.beginInference(`lab:${name}`);
    const t0 = now();
    try { await s.run(params); log(`=== suite ${name} DONE ${now() - t0}ms`); }
    catch (e) { log(`=== suite ${name} FAILED ${String(e)}`); }
    finally { Q.endInference(); }
  }
}
export type { Mem };
