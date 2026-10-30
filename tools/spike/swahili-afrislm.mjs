/**
 * SPIKE 1: does Swahili work well enough? Translates finance-flavoured sentences EN<->SW with
 * TranslatePsy-AfriSLM (prompt + load config copied from the official qvac-examples demo).
 * Prints latency + tokens/s. YOU judge the Swahili quality (you speak it): that is the real test.
 *   DEVICE=cpu|gpu  VARIANT=0.8B-Q4|2B-Q4  node swahili-afrislm.mjs
 */
import { loadModel, unloadModel, completion, close } from "@qvac/sdk";

const VARIANTS = {
  "0.8B-Q4": "TranslatePsy-AfriSLM-0.8B-Q4-GGUF/resolve/main/TranslatePsy-AfriSLM-0.8B-Q4_K_M-imat.gguf",
  "2B-Q4": "TranslatePsy-AfriSLM-2B-Q4-GGUF/resolve/main/TranslatePsy-AfriSLM-2B-Q4_K_M-imat.gguf",
  "4B-Q4": "TranslatePsy-AfriSLM-4B-Q4-GGUF/resolve/main/TranslatePsy-AfriSLM-4B-Q4_K_M-imat.gguf",
};
const variant = process.env.VARIANT ?? "0.8B-Q4";
const device = process.env.DEVICE ?? "cpu";
const src = `https://huggingface.co/qvac/${VARIANTS[variant]}`;

const prompt = (from, to, text) => [
  { role: "system", content: `You are a professional ${from} to ${to} translator. Your goal is to accurately convey the meaning and nuances of the original ${from} text while adhering to ${to} grammar, vocabulary, and cultural sensitivities. Produce only the ${to} translation, without any additional explanations or commentary. ` },
  { role: "user", content: `Please translate the following ${from} text into ${to}: ${text}.\n\nTranslation:` },
];

const EN = [
  "You spent KES 3,200 on eating out this week, which is 40% more than your usual.",
  "Your fuel costs for the Naivasha trip were KES 8,000 including the return leg.",
  "You paid M-Pesa fees of KES 450 this month. Paying by till is cheaper for amounts over 1,000.",
  "Most of your sales come between 6 and 9 in the morning. Consider restocking before 5.",
  "Is this payment for the business or for personal use?",
];
const SW = [
  "Umetumia shilingi elfu tatu mia mbili kwa chakula nje wiki hii.",
  "Nilimlipa fundi shilingi mia tano kwa M-Pesa lakini sikupata ujumbe.",
  "Pesa za kodi ya nyumba hulipwa kila mwanzo wa mwezi.",
];

const t0 = Date.now();
const modelId = await loadModel({ modelSrc: src, modelType: "llamacpp-completion", modelConfig: { device, ctx_size: 2048, reasoning_budget: 0 },
  onProgress: (p) => process.stderr.write(`\rdownload ${p.percentage.toFixed(0)}%   `) });
console.error(`\nloaded ${variant} on ${device} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

async function tr(from, to, text) {
  const t = Date.now();
  const final = await completion({ modelId, history: prompt(from, to, text), stream: false, generationParams: { temp: 0 } }).final;
  return { out: (final.contentText ?? "").trim(), ms: Date.now() - t, stats: final.stats };
}
for (const s of EN) { const r = await tr("English", "Swahili", s); console.log(`EN: ${s}\nSW: ${r.out}\n    (${r.ms} ms ${JSON.stringify(r.stats ?? {})})\n`); }
for (const s of SW) { const r = await tr("Swahili", "English", s); console.log(`SW: ${s}\nEN: ${r.out}\n    (${r.ms} ms)\n`); }
await unloadModel({ modelId });
await close();
