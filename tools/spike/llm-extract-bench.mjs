/**
 * SPIKE 2: small-LLM "tail" extraction speed + accuracy. The LLM only handles messages the regex
 * parsers can't. Feeds synthetic SMS (data/synthetic) and asks for strict JSON.
 *   MODEL=QWEN3_600M_INST_Q4 DEVICE=cpu N=20 node llm-extract-bench.mjs
 * TODO(owner): switch to grammar-constrained JSON once the exact SDK option name is confirmed in
 * docs (the qvac-finance-agent showcase used GBNF because native tool calls were flaky <8B).
 */
import fs from "node:fs";
import * as sdk from "@qvac/sdk";

const modelName = process.env.MODEL ?? "QWEN3_600M_INST_Q4";
const device = process.env.DEVICE ?? "cpu";
const N = Number(process.env.N ?? 20);
const modelSrc = sdk[modelName];
if (!modelSrc) throw new Error(`unknown model constant ${modelName}`);

const lines = fs.readFileSync(new URL("../../data/synthetic/mama_mboga.sms.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).slice(0, N).map((l) => JSON.parse(l));
const modelId = await sdk.loadModel({ modelSrc, modelConfig: { device, ctx_size: 1024 }, onProgress: (p) => process.stderr.write(`\rdownload ${p.percentage.toFixed(0)}%  `) });
const sys = 'Extract fields from this Kenyan mobile-money SMS. Reply with ONLY JSON: {"kind":"send|receive|paybill|till|withdraw|airtime|other","amount_ksh":number,"fee_ksh":number|null,"counterparty":string|null,"balance_ksh":number|null}';
let ok = 0, totalMs = 0;
for (const m of lines) {
  const t = Date.now();
  const final = await sdk.completion({ modelId, history: [{ role: "system", content: sys }, { role: "user", content: m.body }], stream: false, generationParams: { temp: 0 } }).final;
  const ms = Date.now() - t; totalMs += ms;
  let good = false; try { const j = JSON.parse((final.contentText ?? "").replace(/^[^{]*|[^}]*$/g, "")); good = typeof j.amount_ksh === "number"; } catch {}
  if (good) ok++;
  console.log(`${good ? "OK " : "BAD"} ${String(ms).padStart(6)}ms  ${m.body.slice(0, 60)}...`);
}
console.log(`\n${ok}/${lines.length} valid JSON, mean ${(totalMs / lines.length).toFixed(0)} ms/msg on ${device} with ${modelName}`);
await sdk.unloadModel({ modelId }); await sdk.close();
