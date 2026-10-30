/**
 * Build a privacy-safe parser intelligence pack from a local SMS JSONL.
 * Output contains only counts, sender classes, template names, field coverage and
 * digit/name-masked fingerprints. No bodies, amounts, dates, numbers or names.
 *
 * Usage: npx tsx tools/parser-insights.ts data/private/sms.jsonl data/derived/parser-insights.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { classifySender, fingerprint, parseSms, type ParsedSms } from "../packages/core/src/index.js";

const input = process.argv[2] ?? "data/private/sms.jsonl";
const output = process.argv[3] ?? "data/derived/parser-insights.json";
const rows = readFileSync(input, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sender: string; body: string; receivedAt?: number });

const senderClass = (sender: string) => {
  const c = classifySender(sender);
  return { financial: c.financial, provider: c.provider ?? "unknown", reason: c.reason ?? null, numeric: /^\+?\d/.test(sender) };
};
const band = (n: number) => n < 80 ? "0-79" : n < 160 ? "80-159" : n < 320 ? "160-319" : n < 640 ? "320-639" : "640+";
const field = (p: ParsedSms) => ({
  direction: p.direction,
  kind: p.kind,
  hasFee: p.fee != null,
  hasBalance: p.balanceAfter != null,
  hasRef: p.ref != null,
  hasCounterparty: p.counterpartyId != null || p.counterpartyName != null,
  hasAccount: p.account != null,
  hasCreditLimit: p.creditLimitCents != null,
  hasAvailableCredit: p.availableCreditCents != null,
  hasOutstanding: p.outstandingCents != null,
});

let parsed = 0, skipped = 0, notFinancial = 0, noMatch = 0;
const templates = new Map<string, any>();
const senders = new Map<string, { count: number; financial: number; providers: Record<string, number> }>();
const unparsed = new Map<string, { count: number; senderClass: string; length: string }>();
const mpesa = { total: 0, balance: 0, fee: 0, ref: 0, counterparty: 0, fuliza: 0, fulizaLimit: 0 };

for (const r of rows) {
  const sc = senderClass(r.sender);
  const s = senders.get(sc.financial ? sc.provider : "non_financial") ?? { count: 0, financial: 0, providers: {} };
  s.count++; if (sc.financial) s.financial++; s.providers[sc.provider] = (s.providers[sc.provider] ?? 0) + 1;
  senders.set(sc.financial ? sc.provider : "non_financial", s);

  const o = parseSms({ sender: r.sender, body: r.body, receivedAt: r.receivedAt ?? 0 });
  if (!o.ok) {
    if (o.reason === "not_a_transaction") skipped++;
    else if (o.reason === "not_financial_sender" || o.reason === "phone_number_sender") notFinancial++;
    else {
      noMatch++;
      const fp = o.fingerprint ?? fingerprint(r.body);
      const key = `${sc.provider}|${fp}|${band(r.body.length)}`;
      const cur = unparsed.get(key) ?? { count: 0, senderClass: sc.financial ? sc.provider : "non_financial", length: band(r.body.length) };
      cur.count++; unparsed.set(key, cur);
    }
    continue;
  }
  parsed++;
  const p = o.parsed;
  const t = templates.get(p.template) ?? { template: p.template, provider: p.provider, count: 0, directions: {}, kinds: {}, fee: 0, balance: 0, ref: 0, counterparty: 0, account: 0, creditLimit: 0, availableCredit: 0, outstanding: 0, length: {} };
  t.count++;
  t.directions[p.direction] = (t.directions[p.direction] ?? 0) + 1;
  t.kinds[p.kind] = (t.kinds[p.kind] ?? 0) + 1;
  const f = field(p);
  for (const k of ["fee", "balance", "ref", "counterparty", "account"] as const) if ((f as any)[`has${k[0]!.toUpperCase()}${k.slice(1)}`]) t[k]++;
  if (f.hasCreditLimit) t.creditLimit++;
  if (f.hasAvailableCredit) t.availableCredit++;
  if (f.hasOutstanding) t.outstanding++;
  t.length[band(r.body.length)] = (t.length[band(r.body.length)] ?? 0) + 1;
  templates.set(p.template, t);

  if (p.provider === "mpesa") {
    mpesa.total++;
    if (p.balanceAfter != null) mpesa.balance++;
    if (p.fee != null) mpesa.fee++;
    if (p.ref) mpesa.ref++;
    if (p.counterpartyId || p.counterpartyName) mpesa.counterparty++;
    if (/fuliza/i.test(p.template) || /fuliza/i.test(p.counterpartyName ?? "")) mpesa.fuliza++;
    if (p.availableCreditCents != null || p.creditLimitCents != null) mpesa.fulizaLimit++;
  }
}

const pct = (n: number, d: number) => d ? Number(((n / d) * 100).toFixed(1)) : 0;
const pack = {
  format: "pesanalysis-parser-insights-v1",
  generatedAt: new Date().toISOString(),
  privacy: "Aggregate only. No SMS bodies, names, phone numbers, amounts, dates or account numbers. Generated from a local corpus; the corpus is not included.",
  corpus: { messages: rows.length, parsed, skipped, notFinancial, noMatch, parseRatePct: pct(parsed, rows.length) },
  senders: [...senders.entries()].map(([provider, s]) => ({ provider, count: s.count, financialPct: pct(s.financial, s.count), providers: s.providers })).sort((a, b) => b.count - a.count),
  templates: [...templates.values()].sort((a, b) => b.count - a.count),
  unparsedFingerprints: [...unparsed.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count).slice(0, 80),
  mpesa: { ...mpesa, balancePct: pct(mpesa.balance, mpesa.total), feePct: pct(mpesa.fee, mpesa.total), refPct: pct(mpesa.ref, mpesa.total), counterpartyPct: pct(mpesa.counterparty, mpesa.total), fulizaPct: pct(mpesa.fuliza, mpesa.total), fulizaLimitPct: pct(mpesa.fulizaLimit, mpesa.total) },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(pack, null, 2) + "\n");
console.log(JSON.stringify({ output, messages: rows.length, parsed, templates: templates.size, unparsedFormats: unparsed.size }));
