/** WS7.3 AI benchmark. Runs offline on synthetic inputs; writes only aggregate numbers. */
import type { SQLiteDatabase } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import type { Finding } from "@yako/core";
import { narrateOffline } from "../narrate";
import { processModelCandidates } from "./sms-worker";
import { receiptFixturePath } from "./receipt-fixture";
import * as q from "../qvac";

export interface BenchRow {
  job: string;
  model: string;
  n: number;
  loadMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  passRate: number | null;
  note?: string;
}

export interface BenchResult { at: number; rows: BenchRow[]; file: string | null }

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

const FINDINGS: Finding[] = [
  { detector: "time_of_day", id: "bench1", title: "71% of groceries debits fall between 18:00 and 20:00 (usually 10%)", n: 40, evidence: {} },
  { detector: "bocpd_regime", id: "bench2", title: "Spending on Fuel likely rose 20–40% from about 14 Oct", n: 30, evidence: {} },
  { detector: "episodes", id: "bench3", title: "Spend episode: 4 payments, KES 2,400, mostly Eating out", n: 4, evidence: {} },
  { detector: "habit", id: "bench4", title: "Late-night food: 1 this week against a target of 2; baseline 1.0 per week", n: 8, evidence: {} },
  { detector: "credit", id: "bench5", title: "34 of 98 outflows were funded by Fuliza, KES 12,500 in total", n: 98, evidence: {} },
];


export async function runAiBenchmark(db: SQLiteDatabase, n = 5): Promise<BenchResult> {
  const rows: BenchRow[] = [];
  const has = (spec: q.ModelSpec) => !!q.localPath(spec);
  const cached = q.listCachedModels();
  const qwen = has(q.MODELS.qwen3_06b!);
  const afri = has(q.MODELS.afri_08b_q4!);
  const ocr = has(q.MODELS.ocr_latin!) && has(q.MODELS.ocr_craft!);

  if (qwen) {
    const times: number[] = [];
    let ok = 0, loadMs: number | null = null;
    for (let i = 0; i < Math.max(1, n); i++) {
      const t0 = Date.now();
      const r = await narrateOffline(FINDINGS[i % FINDINGS.length]!, {});
      times.push(Date.now() - t0);
      if (i === 0) loadMs = Math.max(0, Date.now() - t0 - 500);
      if (r.source === "llm" && !r.note) ok++;
    }
    rows.push({ job: "Explanation (English)", model: "Qwen3-0.6B Q4_0", n: times.length, loadMs, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), passRate: ok / times.length, note: ok === times.length ? undefined : "template fallback on some inputs" });
  } else {
    rows.push({ job: "Explanation (English)", model: "Qwen3-0.6B Q4_0", n: 0, loadMs: null, p50Ms: null, p95Ms: null, passRate: null, note: "model not installed" });
  }

  if (afri && qwen) {
    const times: number[] = [];
    let ok = 0;
    for (let i = 0; i < Math.max(1, Math.min(3, n)); i++) {
      const t0 = Date.now();
      const r = await narrateOffline(FINDINGS[i % FINDINGS.length]!, { language: "sw" });
      times.push(Date.now() - t0);
      if (r.source === "translated" && !r.note) ok++;
    }
    rows.push({ job: "Kiswahili translation", model: "AfriSLM 0.8B Q4_K_M", n: times.length, loadMs: null, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), passRate: ok / times.length, note: ok === times.length ? undefined : "guard rejected a translation" });
  } else {
    rows.push({ job: "Kiswahili translation", model: "AfriSLM 0.8B Q4_K_M", n: 0, loadMs: null, p50Ms: null, p95Ms: null, passRate: null, note: !qwen ? "Qwen3 (source sentence) not installed" : "model not installed" });
  }

  if (ocr) {
    try {
      const t0 = Date.now();
      const loaded = await q.loadLocal(q.MODELS.ocr_latin!, {});
      const loadMs = Date.now() - t0;
      const out = await q.ocrImage(loaded.modelId, await receiptFixturePath(), { timeoutMs: 180_000 });
      const text = out.blocks.map((b) => b.text).join(" ").toUpperCase();
      const ok = /TOTAL|130|NAIVAS/.test(text);
      rows.push({ job: "Receipt OCR", model: "EasyOCR latin + CRAFT", n: 1, loadMs, p50Ms: out.ms, p95Ms: out.ms, passRate: ok ? 1 : 0, note: ok ? undefined : "test slip text not recognised" });
    } catch (e) {
      rows.push({ job: "Receipt OCR", model: "EasyOCR latin + CRAFT", n: 1, loadMs: null, p50Ms: null, p95Ms: null, passRate: 0, note: String(e).slice(0, 90) });
    }
  } else {
    rows.push({ job: "Receipt OCR", model: "EasyOCR latin + CRAFT", n: 0, loadMs: null, p50Ms: null, p95Ms: null, passRate: null, note: "models not installed" });
  }

  try {
    const pending = Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM model_candidates WHERE status='pending'`)?.n ?? 0);
    if (pending > 0 && qwen) {
      const t0 = Date.now();
      const r = await processModelCandidates(db, Math.min(3, pending));
      rows.push({ job: "Unknown SMS extraction", model: "Qwen3-0.6B constrained JSON", n: r.attempted, loadMs: null, p50Ms: Date.now() - t0, p95Ms: Date.now() - t0, passRate: r.attempted ? r.proposed / r.attempted : null, note: r.note });
    } else {
      rows.push({ job: "Unknown SMS extraction", model: "Qwen3-0.6B constrained JSON", n: 0, loadMs: null, p50Ms: null, p95Ms: null, passRate: null, note: qwen ? "no queued unknown messages" : "model not installed" });
    }
  } catch (e) {
    rows.push({ job: "Unknown SMS extraction", model: "Qwen3-0.6B constrained JSON", n: 0, loadMs: null, p50Ms: null, p95Ms: null, passRate: null, note: String(e).slice(0, 90) });
  }

  let file: string | null = null;
  try {
    const f = new File(Paths.document, "ai-benchmark.json");
    if (!f.exists) f.create();
    f.write(JSON.stringify({ at: Date.now(), device: "itel S688LN", cached: cached.map((c) => ({ file: c.name, bytes: c.size })), rows }, null, 2));
    file = f.uri;
  } catch { file = null; }
  return { at: Date.now(), rows, file };
}
