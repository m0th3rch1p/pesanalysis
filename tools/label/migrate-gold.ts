/**
 * Migrate message-level gold labels (data/private/gold.jsonl) to event-level
 * ground truth (data/private/gold.events.jsonl).
 *
 * Why: Safaricom reuses one M-Pesa receipt for the Fuliza draw notice and the
 * actual payment; Equity mirrors repeat the M-Pesa receipt; Okoa sends the same
 * draw/repay twice (Safaricom + Okoa Jahazi). A receipt is NOT an event. This
 * tool links messages into events, keeps every raw label, and derives one
 * category/detail per event with the shared interpret() engine.
 *
 *   npm run gold:migrate
 *
 * Reads (never writes) gold.jsonl. Writes gold.events.jsonl + a report.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSms, sha256Hex, counterpartyKey, interpret } from "../../packages/core/src/index.js";
import type { ParsedSms } from "../../packages/core/src/types.js";

const root = new URL("../../data/private/", import.meta.url);
const smsFile = new URL("sms.jsonl", root);
const goldFile = new URL("gold.jsonl", root);
if (!existsSync(smsFile)) { console.error("Missing data/private/sms.jsonl. Run: npm run sms:export"); process.exit(1); }
if (!existsSync(goldFile)) { console.error("Missing data/private/gold.jsonl. Run: npm run gold"); process.exit(1); }

type Row = { sender: string; body: string; receivedAt: number };
type GoldRow = { ref: string; label: string; confirmedAt: number; kind?: string; amount?: number };
type Msg = { row: Row; p: ParsedSms; smsKey: string; key: string; role: string };

const rows = readFileSync(smsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const gold = readFileSync(goldFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GoldRow);

const goldByRef = new Map<string, GoldRow[]>();
for (const g of gold) {
  const list = goldByRef.get(g.ref) ?? [];
  list.push(g);
  goldByRef.set(g.ref, list);
}
for (const list of goldByRef.values()) list.sort((a, b) => a.confirmedAt - b.confirmedAt);

const fallback = (r: Row) => `${r.sender}:${r.receivedAt}`;
const msgRef = (m: Msg) => m.p.ref ?? fallback(m.row);
// A reused receipt can carry gold rows for BOTH the draw notice and the payment.
// Match the row's kind/direction/amount too, otherwise the notice's stale label
// wins (TEX0000001: food-chapo on the till, Debt repayment on the draw).
const labelsOn = (m: Msg) => (goldByRef.get(msgRef(m)) ?? []).filter((g) =>
  (g.kind == null || g.kind === m.p.kind) &&
  (g.amount == null || g.amount === m.p.amount) &&
  (g.direction == null || g.direction === m.p.direction),
);
const isNoticeLabel = (s: string) => /notification/i.test(s) || /^okoa-notification$/i.test(s);

const msgs: Msg[] = [];
for (const row of rows) {
  const o = parseSms(row);
  if (!o.ok) continue;
  const p = o.parsed;
  let key = p.ref ? `ref:${p.ref}` : `raw:${fallback(row)}`;
  let role = "transaction";
  if (p.template === "mpesa.fuliza_draw") role = "funding_notice";
  if (p.template === "equity.sent_to_wallet" || p.template === "equity.till_received") role = "bank_mirror";
  if (/okoa_draw|okoa_repay|airtime_loan/.test(p.template)) role = /repay/.test(p.template) ? "repayment_notice" : "funding_notice";
  if (p.template === "equity.sent_to_wallet") {
    const ref = /MPESA receipt number is\s+([A-Z0-9]+)/i.exec(row.body)?.[1];
    if (ref) key = `ref:${ref}`;
  }
  msgs.push({ row, p, smsKey: sha256Hex(`${row.sender}|${row.receivedAt}|${row.body}`), key, role });
}

// Okoa / Airtel loan notices carry no receipt. Pair the Safaricom copy with the
// lender copy by (kind, amount) inside a short window; each pair is ONE event.
const telco = msgs.filter((m) => /okoa_draw|okoa_repay|airtime_loan/.test(m.p.template));
const telcoGroups = new Map<string, Msg[]>();
for (const m of telco) {
  const k = `${m.p.kind}:${m.p.amount}`;
  const list = telcoGroups.get(k) ?? [];
  list.push(m);
  telcoGroups.set(k, list);
}
const okoaMarker = (body: string) => /TOTAL UNPAID OKOA JAHAZI is\s*([\d.,]+)/i.exec(body)?.[1]?.replace(/,/g, "") ?? null;

for (const [k, list] of telcoGroups) {
  list.sort((a, b) => a.p.occurredAt - b.p.occurredAt);
  const used = new Set<Msg>();
  const [kind, amount] = k.split(":");
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (used.has(a)) continue;
    const twin = list.find((b, j) => {
      if (j <= i || used.has(b) || b.row.sender === a.row.sender) return false;
      const dt = Math.abs(b.p.occurredAt - a.p.occurredAt);
      if (dt <= 5 * 60_000) return true;
      // The lender copy can land 15-20 min after Safaricom's. Same amount is
      // not enough; the outstanding-debt marker must also match.
      const ma = okoaMarker(a.row.body);
      const mb = okoaMarker(b.row.body);
      return dt <= 30 * 60_000 && !!ma && ma === mb;
    });
    if (twin) {
      const at = Math.min(a.p.occurredAt, twin.p.occurredAt);
      const key = `telco:${kind}:${amount}:${at}`;
      a.key = key; twin.key = key;
      used.add(a); used.add(twin);
    } else {
      a.key = `telco:${kind}:${amount}:${a.p.occurredAt}`;
      used.add(a);
    }
  }
}

const byKey = new Map<string, Msg[]>();
for (const m of msgs) {
  const list = byKey.get(m.key) ?? [];
  list.push(m);
  byKey.set(m.key, list);
}
for (const list of byKey.values()) list.sort((a, b) => a.p.occurredAt - b.p.occurredAt);

// Private vocabulary never lives in the repo. Put real shorthand -> category pairs in
// data/private/lexicon.json (gitignored); public runs use an empty map.
const lexiconFile = new URL("lexicon.json", root);
const LEXICON: Record<string, string> = existsSync(lexiconFile)
  ? JSON.parse(readFileSync(lexiconFile, "utf8")) as Record<string, string>
  : {};

function isFulizaDraw(m: Msg) { return m.p.template === "mpesa.fuliza_draw"; }
function isMpesa(m: Msg) { return m.p.provider === "mpesa"; }

function canonicalOf(list: Msg[]): Msg {
  const fuliza = list.find(isFulizaDraw);
  if (fuliza) {
    const tx = list.find((m) => !isFulizaDraw(m));
    if (tx) return tx;
  }
  const equityPair = list.some((m) => m.p.template === "equity.till_received") && list.some(isMpesa);
  if (equityPair) {
    const tx = list.find(isMpesa);
    if (tx) return tx;
  }
  const telcoPair = list.length > 1 && list.every((m) => /okoa|airtime_loan/.test(m.p.template));
  if (telcoPair) {
    const saf = list.find((m) => m.row.sender === "Safaricom");
    if (saf) return saf;
  }
  return list.find(isMpesa) ?? list[0]!;
}

function roleOf(m: Msg, canonical: Msg, list: Msg[]): string {
  if (m === canonical) return "transaction";
  if (isFulizaDraw(m)) return "funding_notice";
  if (m.p.template.startsWith("equity.")) return "bank_mirror";
  if (/okoa|airtime_loan/.test(m.p.template) && list.length > 1) return "duplicate_notice";
  return "duplicate_notice";
}

/** User labels are the source of truth, but their vocabulary is loose. */
function prefixCategory(label: string, direction: string): string | null {
  const l = label.toLowerCase().trim();
  if (/^shop\b|^supermarket\b/.test(l)) return "Groceries";
  if (/^food-(groceries|maize|posho)/.test(l)) return "Groceries";
  if (/^food\b/.test(l)) return "Eating out";
  if (/^online-services\b/.test(l)) return "Subscriptions";
  if (/^airtime\b|^okoa-airtel\b/.test(l)) return "Airtime & data";
  if (/^(recreation|reacreation)\b/.test(l)) return "Entertainment";
  if (/^maintenance\b/.test(l)) return "Transport";
  if (/^friend\b/.test(l)) return direction === "in" ? "Transfer in" : "Personal transfer";
  if (/^family\b/.test(l)) return direction === "in" ? "Transfer in" : "Family support";
  if (/^payout-/.test(l)) return "Other income";
  if (/^bank-transferin\b/.test(l)) return "Transfer in";
  return null;
}

const DROP = new Set([
  "notification", "incurring", "incurr", "repayment", "repay", "debt", "fuliza", "okoa", "safaricom", "airtel",
  "shop", "supermarket", "food", "online", "services", "payout", "bank", "transfer", "family", "friend",
  "recreation", "reacreation", "maintenance", "airtime", "credit", "sent", "received", "in", "out", "and", "the", "transferin", "transferout",
]);

function labelDetail(label: string, category: string | null): string {
  const drop = new Set(DROP);
  if (category) for (const t of category.toLowerCase().split(/[^a-z0-9]+/)) if (t) drop.add(t);
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter((w) => !drop.has(w) && !/^\d+$/.test(w)).join(" ").slice(0, 120);
}

function drawFeeCents(body: string): number | null {
  const m = /Access Fee charged Ksh\s*([\d,.]+)/i.exec(body);
  if (!m) return null;
  return Math.round(Number(m[1]!.replace(/,/g, "")) * 100);
}

const events: any[] = [];
const unresolved: any[] = [];
const conflicts: any[] = [];
const byCategory: Record<string, number> = {};
const byFunding: Record<string, number> = {};

for (const [key, list] of [...byKey.entries()].sort((a, b) => a[1][0]!.p.occurredAt - b[1][0]!.p.occurredAt)) {
  const allGold = list.flatMap(labelsOn);
  if (!allGold.length) continue;

  const canonical = canonicalOf(list);
  const roles = new Map<Msg, string>();
  for (const m of list) roles.set(m, roleOf(m, canonical, list));
  for (const m of list) m.role = roles.get(m)!;

  const canonicalGold = labelsOn(canonical);
  const pick = (rows: GoldRow[]) => rows.filter((g) => !isNoticeLabel(g.label) && !(isFulizaDraw(canonical) && /^debt repayment/i.test(g.label)));
  let primaryRow: GoldRow | null = null;
  let primaryMsg: Msg = canonical;
  const fromTx = pick(canonicalGold);
  if (fromTx.length) primaryRow = fromTx[fromTx.length - 1]!;
  else {
    for (const m of list) {
      const c = pick(labelsOn(m)).filter((g) => !(isFulizaDraw(m) && /^debt repayment/i.test(g.label)));
      if (c.length) { primaryRow = c[c.length - 1]!; primaryMsg = m; break; }
    }
  }

  const rawLabels = [...new Set(allGold.map((g) => g.label))];
  const direction = canonical.p.direction;
  const tpl = canonical.p.template;

  let category: string | null = null;
  let detail = "";
  let confidence = 0;
  let source = "none";

  if (primaryRow) {
    const forced =
      /okoa_repay/.test(tpl) || /fuliza_repay/.test(tpl) ? "Debt repayment" :
      /okoa_draw|airtime_loan/.test(tpl) ? "Airtime & data" :
      null;
    const pref = forced ? null : prefixCategory(primaryRow.label, direction);
    if (forced) { category = forced; confidence = 1; source = "explicit"; }
    else if (pref) { category = pref; confidence = 0.95; source = "explicit"; }
    else {
      const r = interpret(primaryRow.label, { direction: canonical.p.direction as any, kind: canonical.p.kind, template: tpl, counterpartyName: canonical.p.counterpartyName }, LEXICON);
      category = r.category; confidence = r.confidence; source = r.source;
      if (!category && canonical.p.kind === "receive" && direction === "in") { category = "Transfer in"; confidence = 0.55; source = "context"; }
    }
    detail = labelDetail(primaryRow.label, category);
  } else if (rawLabels.length) {
    // only notice labels: keep the event, but do not invent a category
    source = "none";
  }

  if (!category) unresolved.push({ key, rawLabels, templates: list.map((m) => m.p.template), amount: canonical.p.amount });

  let funding: any = null;
  const fuliza = list.find(isFulizaDraw);
  if (fuliza) {
    funding = {
      source: "fuliza",
      drawAmount: fuliza.p.amount,
      drawFee: drawFeeCents(fuliza.row.body) ?? fuliza.p.fee ?? 0,
      noticeRef: fuliza.p.ref ?? null,
    };
  } else if (/okoa_draw|airtime_loan/.test(tpl)) {
    funding = { source: /airtime_loan/.test(tpl) ? "airtel_loan" : "okoa", drawAmount: canonical.p.amount, drawFee: canonical.p.fee ?? 0 };
  } else if (list.some((m) => m.p.template === "equity.sent_to_wallet")) {
    funding = { source: "bank" };
  }

  // The M-Pesa message hides the real sender behind "Equity Bulk Account";
  // the bank mirror names the person/project. Prefer the specific one.
  let cpName = canonical.p.counterpartyName ?? null;
  const mirror = list.find((m) => m !== canonical && m.p.template.startsWith("equity.") && m.p.counterpartyName);
  if (mirror && cpName && /equity|bulk|paybill|account/i.test(cpName) && !/equity|bulk/i.test(mirror.p.counterpartyName!)) {
    cpName = mirror.p.counterpartyName!;
  }

  if (!cpName && /airtime_loan/.test(tpl)) cpName = "Airtel";

  const ev = {
    eventId: `evt_${sha256Hex(key).slice(0, 16)}`,
    occurredAt: canonical.p.occurredAt,
    kind: canonical.p.kind,
    direction,
    amount: canonical.p.amount,
    fee: canonical.p.fee ?? 0,
    counterparty: { name: cpName, key: counterpartyKey(canonical.p.counterpartyId ?? null, cpName) },
    category,
    detail,
    funding,
    messages: list.map((m) => ({
      smsKey: m.smsKey,
      provider: m.p.provider,
      ref: m.p.ref ?? null,
      template: m.p.template,
      role: m.role,
      amount: m.p.amount,
      fee: m.p.fee ?? 0,
    })),
    rawLabels,
    primaryLabel: primaryRow?.label ?? null,
    primarySmsRef: primaryRow ? msgRef(primaryMsg) : null,
    confidence,
    interpretSource: source,
    linkedBy: key.startsWith("telco:") ? "telco_pair" : key.startsWith("ref:") ? "receipt" : "raw",
    _key: key,
  };
  events.push(ev);

  const cat = category ?? "(unresolved)";
  byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  const fund = funding?.source ?? "wallet";
  byFunding[fund] = (byFunding[fund] ?? 0) + 1;

  const semantic = rawLabels.filter((l) => !isNoticeLabel(l));
  if (semantic.length > 1) conflicts.push({ key, rawLabels, primary: primaryRow?.label ?? null });
}

// Gold refs that matched no parsed message (stale refs from older parser runs).
const parsedRefs = new Set(msgs.map(msgRef));
const orphanGold = gold.filter((g) => !parsedRefs.has(g.ref)).map((g) => g.ref);

const outFile = new URL("gold.events.jsonl", root);
writeFileSync(outFile, events.map(({ _key, ...e }) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });

const report = {
  generatedAt: new Date().toISOString(),
  goldRows: gold.length,
  events: events.length,
  messages: events.reduce((n, e) => n + e.messages.length, 0),
  rawLabels: [...new Set(gold.map((g) => g.label))].length,
  byCategory,
  byFunding,
  unresolved,
  conflicts,
  orphanGold: [...new Set(orphanGold)],
};
writeFileSync(new URL("gold.events.report.json", root), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

console.log(`gold rows ${gold.length} -> events ${events.length} (${report.messages} messages, ${report.rawLabels} raw labels)`);
console.log(`wrote data/private/gold.events.jsonl + gold.events.report.json`);
console.log("\nby category:");
for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log("\nby funding:");
for (const [k, v] of Object.entries(byFunding).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
if (unresolved.length) {
  console.log(`\nUNRESOLVED (${unresolved.length}):`);
  for (const u of unresolved) console.log(`  ${u.key} ${u.amount / 100} ${u.templates.join("+")} labels=${u.rawLabels.join(",")}`);
}
if (conflicts.length) {
  console.log(`\nCONFLICTS (${conflicts.length}):`);
  for (const c of conflicts) console.log(`  ${c.key} primary=${c.primary} labels=${c.rawLabels.join(" || ")}`);
}
if (orphanGold.length) console.log(`\nORPHAN GOLD REFS (${orphanGold.length}): ${[...new Set(orphanGold)].join(", ")}`);
