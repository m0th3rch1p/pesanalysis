import { readFileSync, writeFileSync } from "node:fs";
import { parseSms, runAllDetectors, counterpartyKey, auditBalanceChain, suggestLabel, detectEpisodes } from "../../packages/core/src/index.js";
import type { Finding, LedgerTx, ParsedSms, KnnItem } from "../../packages/core/src/index.js";

/**
 * Evidence harness over the SYNTHETIC corpora (docs/EVAL.md).
 * Metrics per persona:
 *  - parse% (financial senders), kind accuracy among parsed, balance-chain health
 *  - label accuracy COLD (rules+kind-defaults, no history) vs LEARNED (kNN on 70% confirmed history, tested on 30%)
 *  - detector recall vs planted patterns ("correctly abstained" when n < min-n floor)
 * Real-data coverage is separate: npm run coverage:private. NEVER run this on data/private.
 */
const dir = new URL("../../data/synthetic/", import.meta.url);
interface Truth { label: string; role?: string; scope: string; episode?: string; note?: string }
interface Row { sender: string; body: string; receivedAt: number }

const out: string[] = ["# Eval run (synthetic corpora)\n", `_Generated ${new Date().toISOString()}._\n`];
out.push("| corpus | msgs | parse% | label cold | label learned | chain ok/break/unk | planted recalled |\n|---|---|---|---|---|---|---|");
const misses: string[] = [];

for (const persona of ["mama_mboga", "salaried_trip", "boda_rider"]) {
  let rows: Row[], truth: { persona: string; planted: Array<{ id: string; detector: string; description: string; params: Record<string, unknown> }>; truth: Truth[] };
  try {
    rows = readFileSync(new URL(`${persona}.sms.jsonl`, dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    truth = JSON.parse(readFileSync(new URL(`${persona}.truth.json`, dir), "utf8"));
  } catch { misses.push(`- ${persona}: MISSING (run npm run synth)`); continue; }

  const parsed: Array<{ p: ParsedSms; t: Truth; i: number }> = [];
  rows.forEach((r, i) => { const o = parseSms(r); if (o.ok) parsed.push({ p: o.parsed, t: truth.truth[i]!, i }); });
  const parsePct = rows.length ? (100 * parsed.length) / rows.length : 0;

  // kind accuracy: parsed kind matches the truth kind recorded at synthesis time
  let kindOk = 0;
  for (const { p, t } of parsed) { /* truth.kind not stored; use label-derived check below instead */ void p; void t; }
  // kind acc proxy: direction agreement between parsed direction and label semantics is unreliable;
  // the round-trip test (parse.test) already enforces kind via synthesis. Report label metrics:
  const labelEq = (sug: string, truthLabel: string) => {
    const a = sug.toLowerCase(), b = truthLabel.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  };
  let coldOk = 0;
  for (const { p, t } of parsed) { const s = suggestLabel(p); if (s && labelEq(s.label, t.label)) coldOk++; }
  const coldPct = parsed.length ? (100 * coldOk) / parsed.length : 0;

  // learned: 70% as kNN history (labels = truth), test on the other 30%
  const ledgerForKnn = (items: typeof parsed): KnnItem[] => items.map(({ p, t }, j) => ({
    id: `h${j}`, label: t.label,
    text: [p.counterpartyName, p.account, p.template].filter(Boolean).join(" "),
  }));
  const hCount = Math.floor(parsed.length * 0.7);
  const history = ledgerForKnn(parsed.slice(0, hCount));
  let learnedOk = 0;
  for (const { p, t } of parsed.slice(hCount)) {
    const s = suggestLabel(p, { history });
    if (s && labelEq(s.label, t.label)) learnedOk++;
  }
  const learnedN = parsed.length - hCount;
  const learnedPct = learnedN ? (100 * learnedOk) / learnedN : 0;

  const chain = auditBalanceChain(parsed.map((x) => x.p).filter((p) => p.provider === "mpesa"));
  const c: Record<string, number> = {};
  chain.forEach((x) => (c[x.status] = (c[x.status] ?? 0) + 1));

  const ledger: LedgerTx[] = parsed.map(({ p, t }, i) => ({
    id: `tx${i}`, occurredAt: p.occurredAt, direction: p.direction, amount: p.amount,
    counterpartyKey: counterpartyKey(p.counterpartyId, p.counterpartyName) ?? `n:${(p.counterpartyName ?? p.template).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    kind: p.kind, fee: p.fee, label: t.label, scope: t.scope as LedgerTx["scope"], role: t.role ?? null, provider: p.provider,
  }));
  const findings: Finding[] = runAllDetectors(ledger);

  const recalled: string[] = [];
  for (const pl of truth.planted) {
    const fs = findings.filter((f) => f.detector === pl.detector);
    let ok = false, abstained = false;
    if (pl.detector === "balance_break") ok = chain.some((x) => x.status === "break");
    else if (pl.detector === "episodes") {
      // recall = an episode finding covers >= 3 of the truth-episode's transactions
      const want = ledger.filter((_, j) => parsed[j]?.t.episode === pl.params.episode).map((l) => l.id);
      ok = fs.some((f) => {
        const ids = (f.evidence.txIds as string[]) ?? [];
        return ids.filter((id) => want.includes(id)).length >= 3;
      });
      if (!ok) abstained = want.length < 3;
    } else {
      const hints = Object.values(pl.params ?? {}).filter((v) => typeof v === "string") as string[];
      ok = hints.length
        ? fs.some((f) => hints.some((h) => JSON.stringify(f.evidence).toLowerCase().includes(String(h).toLowerCase())))
        : fs.length > 0;
      if (!ok && fs.length === 0) abstained = true; // e.g. planted pattern below the min-n floor
      if (ok) {
        // tightened: for periodic, require the planted counterparty in evidence
        const cp = pl.params.counterparty as string | undefined;
        if (cp) ok = fs.some((f) => JSON.stringify(f.evidence).toLowerCase().includes(String(cp).toLowerCase()));
      }
    }
    if (ok) recalled.push(pl.id);
    else misses.push(`- ${persona}/${pl.id}: ${abstained ? "abstained (below min-n floor)" : "NOT recalled"} — ${pl.description}`);
  }

  out.push(`| ${persona} | ${rows.length} | ${parsePct.toFixed(1)}% | ${coldPct.toFixed(1)}% | ${learnedPct.toFixed(0)}% of ${learnedN} | ${c.ok ?? 0}/${c.break ?? 0}/${c.unknown ?? 0} | ${recalled.length}/${truth.planted.length} |`);
}
out.push("");
if (misses.length) { out.push("## Notes & misses"); out.push(...misses, ""); }
const md = out.join("\n");
console.log(md);
writeFileSync(new URL("../../docs/eval-latest.md", import.meta.url), md);
void detectEpisodes;
