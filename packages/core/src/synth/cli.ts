import { mkdirSync, writeFileSync } from "node:fs";
import { PERSONAS } from "./personas.js";

const outDir = new URL("../../../../data/synthetic/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, gen] of Object.entries(PERSONAS)) {
  const c = gen();
  writeFileSync(new URL(`${name}.sms.jsonl`, outDir), c.messages.map((m) => JSON.stringify({ sender: m.sender, body: m.body, receivedAt: m.receivedAt })).join("\n") + "\n");
  writeFileSync(new URL(`${name}.truth.json`, outDir), JSON.stringify({ persona: c.persona, planted: c.planted, truth: c.messages.map((m) => m.truth) }, null, 1));
  console.log(`${name}: ${c.messages.length} messages, ${c.planted.length} planted patterns -> data/synthetic/`);
}
