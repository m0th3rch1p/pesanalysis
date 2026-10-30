// Builds the JSON datasets pushed to the phone. Synthetic only.
import { writeFileSync } from "node:fs";
import { ROWS } from "./sms-source.mjs";
import { EN_SW, SW_EN, SHENG_EN } from "./translate-source.mjs";
const here = new URL(".", import.meta.url).pathname;
const sms = ROWS.map((r, i) => ({ id: `sms${String(i + 1).padStart(3, "0")}`, text: r[0], is_financial: !!r[1], direction: r[2], category: r[3], loan_due: !!r[4], lang: r[5], group: r[6] }));
writeFileSync(here + "laya-sms.json", JSON.stringify(sms, null, 1));
const tr = [];
EN_SW.forEach(([s, r], i) => tr.push({ id: `ensw${String(i + 1).padStart(2, "0")}`, dir: "en-sw", src: s, ref: r }));
SW_EN.forEach(([s, r], i) => tr.push({ id: `swen${String(i + 1).padStart(2, "0")}`, dir: "sw-en", src: s, ref: r }));
SHENG_EN.forEach(([s, r, w], i) => tr.push({ id: `sheng${String(i + 1).padStart(2, "0")}`, dir: "sheng-en", src: s, ref: r, amountInWords: w }));
writeFileSync(here + "translate.json", JSON.stringify(tr, null, 1));
console.log("sms", sms.length, "translate", tr.length);

// App-side copies carry TEXT ONLY (ground truth stays on the host).
const appDir = here + "../../../apps/mobile/src/lab/data/";
writeFileSync(appDir + "laya-sms.json", JSON.stringify(sms.map(({ id, text }) => ({ id, text }))));
writeFileSync(appDir + "translate.json", JSON.stringify(tr.map(({ id, dir, src }) => ({ id, dir, src }))));
