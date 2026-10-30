/**
 * Gold-labeling queue: spot-check ~100 of YOUR OWN transactions and confirm/correct the
 * suggested label. Output -> data/private/gold.jsonl (gitignored, NEVER on video).
 * The confirmed items become (a) eval ground truth, (b) kNN training data.
 *
 *   npm run gold              # interactive queue, ~30 min for 100
 *   npm run gold -- --report  # accuracy of the rule layer vs gold
 *
 * At the prompt: y accepts the suggestion, 1-3 picks an alternate, s skips, q saves and quits,
 * ? lists the taxonomy, and any other text is saved as a custom label (typing a taxonomy name
 * in any case canonicalizes it). Saved labels also become kNN history for later suggestions.
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { parseSms, suggestLabel } from "../../packages/core/src/index.js";
import { SEED_LABELS } from "../../packages/core/src/labels/taxonomy.js";

const root = new URL("../../data/private/", import.meta.url);
const file = new URL("sms.jsonl", root);
if (!existsSync(file)) { console.error("Missing data/private/sms.jsonl. Run: npm run sms:export"); process.exit(1); }
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sender: string; body: string; receivedAt: number });

if (process.argv.includes("--report")) {
  const gold = existsSync(new URL("gold.jsonl", root))
    ? readFileSync(new URL("gold.jsonl", root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ref: string; label: string })
    : [];
  if (!gold.length) { console.log("no gold labels yet"); process.exit(0); }
  const byRef = new Map(rows.map((r) => { const o = parseSms(r); return o.ok ? [o.parsed.ref ?? `${r.sender}:${r.receivedAt}`, o.parsed] as const : [null, null] as const; }).filter(([k]) => k != null) as Array<[string, any]>);
  let ok = 0;
  for (const g of gold) {
    const p = byRef.get(g.ref);
    const sug = p ? suggestLabel(p)?.label : null;
    if (sug && (sug.toLowerCase() === g.label.toLowerCase() || sug.toLowerCase().includes(g.label.toLowerCase()) || g.label.toLowerCase().includes(sug.toLowerCase()))) ok++;
  }
  console.log(`rule-layer accuracy vs gold: ${ok}/${gold.length} = ${((100 * ok) / gold.length).toFixed(1)}%`);
  process.exit(0);
}

// interactive queue
const goldFile = new URL("gold.jsonl", root);
if (!existsSync(goldFile)) appendFileSync(goldFile, "", { mode: 0o600 });
type GoldLine = { ref: string; label: string | null; text?: string };
const gold = readFileSync(goldFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GoldLine);
const seen = new Set(gold.map((g) => g.ref));
const parsed = rows.map((r) => ({ r, o: parseSms(r) })).filter((x) => x.o.ok).slice(0, 4000);
const queue = parsed.filter((x) => !seen.has(x.o.ok ? x.o.parsed.ref ?? `${x.r.sender}:${x.r.receivedAt}` : ""));

// Labels already in the file become kNN training data, so suggestions improve
// as the session goes (same path the app uses with confirmed transactions).
const hayOf = (p: any) => [p.counterpartyName, p.account, p.template, p.counterpartyId].filter(Boolean).join(" ").toLowerCase();
const parsedByRef = new Map(parsed.map((x) => [x.o.ok ? x.o.parsed.ref ?? `${x.r.sender}:${x.r.receivedAt}` : "", x.o.ok ? x.o.parsed : null]).filter(([k]) => k) as Array<[string, any]>);
const history: Array<{ id: string; label: string; text: string }> = gold
  .filter((g): g is GoldLine & { label: string } => typeof g.label === "string" && !!g.label)
  .map((g) => {
    const p = parsedByRef.get(g.ref);
    const text = g.text ?? (p ? hayOf(p) : null);
    return text ? { id: g.ref, label: g.label, text } : null;
  })
  .filter(Boolean) as Array<{ id: string; label: string; text: string }>;

console.log(`${queue.length} transactions in the queue`);
console.log("commands: y = accept suggestion · 1-3 = pick alternative · type any label = custom · s = skip · q = save & quit · ? = list labels\n");
const rl = createInterface({ input: process.stdin });
let saved = 0;
let awaitingCustom = false;
function canonical(label: string): string {
  return SEED_LABELS.find((l) => l.name.toLowerCase() === label.toLowerCase())?.name ?? label;
}
function save(label: string, item: { r: { sender: string; receivedAt: number }; o: { ok: true; parsed: any } }) {
  const ref = item.o.parsed.ref ?? `${item.r.sender}:${item.r.receivedAt}`;
  const text = hayOf(item.o.parsed);
  const name = canonical(label);
  appendFileSync(new URL("gold.jsonl", root), JSON.stringify({ sender: item.r.sender, ref, kind: item.o.parsed.kind, direction: item.o.parsed.direction, amount: item.o.parsed.amount, label: name, text, confirmedAt: Date.now() }) + "\n", { mode: 0o600 });
  history.push({ id: ref, label: name, text });
  saved++;
}
function done() {
  console.log(`\nDONE. saved ${saved} gold labels this session.`);
  rl.close();
  process.exit(0);
}
function show() {
  const item = queue[0];
  if (!item || !item.o.ok) return done();
  const p = item.o.parsed;
  const s = suggestLabel(p, { history });
  const dt = new Date(p.occurredAt + 3 * 3_600_000).toISOString().replace("T", " ").slice(0, 16);
  console.log(`\n[${dt}] ${p.kind} ${p.direction} Ksh${(p.amount / 100).toLocaleString("en-US")}${p.fee ? ` fee Ksh${(p.fee / 100).toFixed(2)}` : ""} -> ${p.counterpartyName ?? "?"}${p.account ? ` (${p.account})` : ""} [${p.template}]`);
  console.log(`   body: ${item.r.body.replace(/\s+/g, " ").slice(0, 160)}`);
  if (s) console.log(`   suggestion: ${s.label} (${(s.confidence * 100).toFixed(0)}%)${s.alternates.length ? `  alternatives: ${s.alternates.map((a, i) => `${i + 1}:${a.label}`).join("  ")}` : ""}`);
  else console.log("   suggestion: (none) — type the label, or ? to list labels");
}
function advance() { queue.shift(); show(); }

rl.on("line", (line) => {
  const item = queue[0];
  if (!item || !item.o.ok) return done();
  const raw = line.trim();
  const ans = raw.toLowerCase();

  if (awaitingCustom) {
    awaitingCustom = false;
    if (!raw || ans === "-") { console.log("   custom label cancelled"); show(); return; }
    save(raw, item); advance(); return;
  }

  if (ans === "q") return done();
  if (ans === "s") return advance();
  if (ans === "?") { console.log(`\n${SEED_LABELS.map((l) => l.name).join(" · ")}\n(type any other name to create one)`); return; }
  if (ans === "c") { awaitingCustom = true; console.log("   type the label name (Enter to cancel):"); return; }

  const s = suggestLabel(item.o.parsed, { history });
  if (ans === "y") {
    if (s) { save(s.label, item); advance(); }
    else console.log("   no suggestion for this one — type any label, s to skip");
    return;
  }
  if (/^[1-3]$/.test(ans)) {
    const alts = [s, ...s?.alternates ?? []].filter(Boolean) as Array<{ label: string }>;
    const pick = alts[Number(ans) - 1];
    if (pick) { save(pick.label, item); advance(); }
    else console.log(`   no alternative ${ans}`);
    return;
  }

  // anything else is a custom label (this is how you add a new category)
  if (raw) { save(raw, item); advance(); return; }
  show();
});
show();
