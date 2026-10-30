import type { SQLiteDatabase } from "expo-sqlite";
import {
  addTxItem, applyPack, bodaRider, computeBaseline, createFlow, createHabit, createVenture, ensureFts, rebuildItemPrices,
  formatEat, formatKes, ingestSms, insertSecurityAlert, lastInsertId, rebuildSearchIndex, refreshOccurrences, resetAllData,
  seedTaxonomy, suggestHabits, tagTx, type SynthSms,
} from "@yako/core";
import { SqliteStore } from "./store";
import { asDbAdapter } from "./db/open";
import { runNightlyOnDevice } from "./nightly";
import { resetCapture } from "../modules/yako-sms";

export interface DemoSeed {
  messages: number;
  stored: number;
  labelled: number;
  pending: number;
  ms: number;
  nightlyError?: string;
}

const DAY = 86_400_000;
const LABEL_MAP: Record<string, string> = { Fuliza: "Debt repayment" };

/**
 * Synthetic-only demo state. Resets the ledger, generates 180 days of a boda
 * rider's messages ending today, ingests them through the SAME path as SMS,
 * applies the corpus ground truth as confirmed labels/roles, leaves the last 8
 * payments unlabelled for Review, and computes the nightly analyses.
 */
export async function seedDemoLedger(db: SQLiteDatabase, now = Date.now()): Promise<DemoSeed> {
  const t0 = Date.now();
  const a = asDbAdapter(db);
  // Clear real SMS already sitting in the native queue and set the ingest floor, so the demo
  // ledger cannot be mixed with the owner's inbox by the next resume or watcher tick (D88/D102).
  try { await resetCapture(now); } catch { /* native module unavailable (tests/web) */ }
  resetAllData(a);
  a.run(`INSERT INTO meta (key, value) VALUES ('demo_ledger', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  a.run(`INSERT INTO meta (key, value) VALUES ('onboarded', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  seedTaxonomy(a, now);
  applyPack(a, "boda_rider", now);

  const days = 180;
  const corpus = bodaRider(3, days, now - days * DAY);
  const rows = corpus.messages.filter((m) => m.receivedAt <= now);
  const pendingFrom = Math.max(0, rows.length - 14);
  const store = new SqliteStore(db);
  const labelIds = new Map<string, number>();
  const { tagId: ventureTagId } = createVenture(a, "Boda business", "business");

  const ensureLabel = (name: string): number => {
    const cached = labelIds.get(name);
    if (cached) return cached;
    const found = a.get(`SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND status = 'active' LIMIT 1`, [name]);
    if (found) {
      labelIds.set(name, Number(found.id));
      return Number(found.id);
    }
    const created = a.run(`INSERT INTO labels (name, is_custom, created_at) VALUES (?, 1, ?)`, [name, now]);
    const id = lastInsertId(created);
    labelIds.set(name, id);
    return id;
  };

  let stored = 0;
  let labelled = 0;
  db.withTransactionSync(() => {
    rows.forEach((m: SynthSms, i) => {
      const res = ingestSms({ sender: m.sender, body: m.body, receivedAt: m.receivedAt }, store);
      if (!res.actions) return;
      stored++;
      const txId = res.actions.txId;
      const hour = new Date(m.receivedAt + 3 * 3_600_000).getUTCHours();
      const spots = [
        [-1.2864, 36.8172], [-1.3133, 36.7890], [-1.2676, 36.8044],
        [-1.2195, 36.8890], [-1.2921, 36.8219], [-1.3038, 36.7411],
      ];
      const [lat, lng] = spots[i % spots.length]!;
      a.run(
        `INSERT OR REPLACE INTO tx_context
          (tx_id, lat, lng, accuracy_m, motion, steps_last_10m, source, captured_at, age_ms, battery_pct, is_charging, step_delta, circadian_phase)
         VALUES (?, ?, ?, ?, ?, ?, 'synthetic', ?, ?, ?, ?, ?, ?)`,
        [txId, lat, lng, 35 + (i % 25), i % 4 === 0 ? "walking" : i % 7 === 0 ? "vehicle" : "still",
          80 + ((i * 37) % 500), m.receivedAt, i * 1000, 45 + (i % 55), i % 3 === 0 ? 1 : 0,
          40 + ((i * 13) % 260),
          hour < 6 ? "late_night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "late_night"],
      );
      if (i >= pendingFrom) {
        // Ingest may auto-file a known kind; force the demo tail back into Review.
        a.run(`UPDATE transactions SET status = 'pending' WHERE id = ?`, [txId]);
        return;
      }
      const labelId = ensureLabel(LABEL_MAP[m.truth.label] ?? m.truth.label);
      a.run(
        `INSERT OR REPLACE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
         VALUES (?, ?, 'user', 1, ?, ?)`,
        [txId, labelId, now, now],
      );
      a.run(`UPDATE transactions SET scope = ?, status = 'confirmed' WHERE id = ?`, [m.truth.scope, txId]);
      const roleName = m.truth.role
        ?? (m.kind === "withdraw" ? "utility" : LABEL_MAP[m.truth.label] === "Debt repayment" ? "lender" : undefined);
      if (roleName) {
        const role = a.get(`SELECT id FROM roles WHERE name = ? COLLATE NOCASE LIMIT 1`, [roleName]);
        const tx = a.get(`SELECT counterparty_id AS cp FROM transactions WHERE id = ?`, [txId]);
        if (role && tx?.cp) a.run(`UPDATE counterparties SET role_id = ? WHERE id = ?`, [role.id, tx.cp]);
      }
      if (m.truth.scope === "business") {
        a.run(`INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, 'user', 1, ?)`, [txId, ventureTagId, now]);
        if (m.truth.label === "Fuel") tagTx(a, txId, "Fuel", "user", 1);
      }
      labelled++;
    });

    // Rail topology demo: M-Pesa paybills to banks/SACCO/vaults, plus bank alerts.
    // These chain off the last stated M-Pesa balance, so the balance audit stays clean.
    const railAt = [...rows].reverse().find((m) => m.receivedAt <= now)?.receivedAt ?? now;
    const anchor = store.chainAnchor("mpesa", railAt + 1);
    if (anchor.anchor != null) {
      let balance = anchor.anchor + anchor.pending;
      let at = now - 6 * 3_600_000;
      const rails: Array<{ name: string; id: string; acct: string; label: string; amount: number }> = [
        { name: "KCB BANK", id: "522522", acct: "11049281", label: "Off-radar transfer", amount: 50_000 },
        { name: "EQUITY BANK", id: "247247", acct: "0700000009", label: "Off-radar transfer", amount: 30_000 },
        { name: "KPLC PREPAID", id: "888880", acct: "55881231", label: "Utilities", amount: 20_000 },
        { name: "M-SHWARI", id: "555555", acct: "0700000010", label: "Savings & investment", amount: 40_000 },
      ];
      for (const r of rails) {
        balance -= r.amount;
        const [d, t] = formatEat(at).split("|") as [string, string];
        const body = `R${String(900000 + stored).padStart(6, "0")} Confirmed. ${formatKes(r.amount)} sent to ${r.name} for account ${r.acct} on ${d} at ${t} New M-PESA balance is ${formatKes(balance)}. Transaction cost, Ksh0.00.`;
        const res = ingestSms({ sender: "MPESA", body, receivedAt: at }, store);
        if (res.actions) {
          const id = res.actions.txId;
          a.run(`INSERT OR REPLACE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
                 VALUES (?, ?, 'user', 1, ?, ?)`, [id, ensureLabel(r.label), now, now]);
          a.run(`UPDATE transactions SET status='confirmed', scope='business' WHERE id=?`, [id]);
          a.run(`INSERT OR IGNORE INTO tx_tags (tx_id, tag_id, source, confidence, created_at) VALUES (?, ?, 'user', 1, ?)`, [id, ventureTagId, now]);
          stored++; labelled++;
        }
        at += 7 * 60_000;
      }

      const bankAlerts: Array<{ sender: string; body: string; label: string }> = [
        { sender: "KCB", label: "Transfer out", body: "Dear customer, your account has been debited with KES 1,250.00 for payment to SAFARICOM. New balance is KES 8,750.00. Ref KCB123456 on 26/10/26 at 10:15." },
        { sender: "STANBIC", label: "Transfer in", body: "You have received KES 5,000.00 from JOHN DOE. Balance KES 12,000.00. Ref STAN987654." },
        { sender: "UNAITAS", label: "Transfer in", body: "You have received KES 2,500.00 from MARY WANJIKU. Balance KES 9,500.00. Ref UNA123456." },
      ];
      for (let i = 0; i < bankAlerts.length; i++) {
        const b = bankAlerts[i]!;
        const res = ingestSms({ sender: b.sender, body: b.body, receivedAt: now - (i + 1) * 3_600_000 }, store);
        if (res.actions) {
          a.run(`INSERT OR REPLACE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
                 VALUES (?, ?, 'user', 1, ?, ?)`, [res.actions.txId, ensureLabel(b.label), now, now]);
          a.run(`UPDATE transactions SET status='confirmed' WHERE id=?`, [res.actions.txId]);
          stored++; labelled++;
        }
      }
    }
  });

  // The corpus tail can be funding notices (Fuliza draws/repays) which are not in tx_events.
  // Force the 14 newest canonical transactions into Review so the demo is deterministic.
  const recent = a.all(`SELECT id FROM tx_events ORDER BY occurred_at DESC LIMIT 14`) as Array<{ id: number }>;
  for (const r of recent) {
    a.run(`UPDATE transactions SET status = 'pending' WHERE id = ?`, [r.id]);
    a.run(`DELETE FROM tx_labels WHERE tx_id = ?`, [r.id]);
  }

  // Keep the demo float positive: a final client payment, consistent with the last stated balance.
  try {
    const last = a.get(`SELECT balance_after AS b FROM transactions WHERE provider='mpesa' AND balance_after IS NOT NULL AND role='transaction' ORDER BY occurred_at DESC LIMIT 1`) as { b?: number } | undefined;
    if (last?.b != null) {
      const amount = 3_000_000;
      const [d, t] = formatEat(now - 20 * 60_000).split("|") as [string, string];
      const body = `R${String(950000 + stored).padStart(6, "0")} Confirmed. You have received ${formatKes(amount)} from DEMO CLIENT 254700000999 on ${d} at ${t}. New M-PESA balance is ${formatKes(last.b + amount)}. Transaction cost, Ksh0.00.`;
      const res = ingestSms({ sender: "MPESA", body, receivedAt: now - 20 * 60_000 }, store);
      if (res.actions) {
        a.run(`INSERT OR REPLACE INTO tx_labels (tx_id, label_id, source, confidence, suggested_at, confirmed_at)
               VALUES (?, ?, 'user', 1, ?, ?)`, [res.actions.txId, ensureLabel("Sales (business)"), now, now]);
        a.run(`UPDATE transactions SET status='confirmed', scope='business' WHERE id=?`, [res.actions.txId]);
        stored++; labelled++;
      }
    }
  } catch { /* float demo is best effort */ }

  // A learned shop for the demo notification: nine Ksh30 cigarette buys at the same kiosk.
  try {
    const cpKey = "n:kibanda shop";
    const cp = a.get(`SELECT id FROM counterparties WHERE key = ?`, [cpKey]) as { id?: number } | undefined;
    const cpId = cp?.id ?? lastInsertId(a.run(`INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)`, [cpKey, "KIBANDA SHOP", "[]", now - 90 * DAY]));
    const label = ensureLabel("Groceries");
    for (let i = 0; i < 9; i++) {
      const when = now - (i * 3 + 1) * DAY;
      const tx = a.run(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
        VALUES ('mpesa','till','out',3000,?,?,'mpesa.till','1','confirmed','transaction')`, [cpId, when]);
      const txId = lastInsertId(tx);
      a.run(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`, [txId, label, when, when]);
      addTxItem(a, txId, { item: "cigarette", amountCents: 3000, source: "user", confirmed: true }, when);
    }
    a.run(`UPDATE transactions SET counterparty_id = ? WHERE counterparty_id IS NULL AND role = 'transaction' AND direction = 'out' AND amount = 35000`, [cpId]);
    rebuildItemPrices(a);
  } catch { /* demo shop is best effort */ }

  // A clean NAIvas payment whose total matches the synthetic two-photo receipt fixture.
  try {
    const cpKey = "n:naivas demo";
    const cp = a.get(`SELECT id FROM counterparties WHERE key = ?`, [cpKey]) as { id?: number } | undefined;
    const cpId = cp?.id ?? lastInsertId(a.run(`INSERT INTO counterparties (key, display_name, raw_names, first_seen) VALUES (?,?,?,?)`, [cpKey, "NAIVAS SUPERMARKET", "[]", now - 120 * DAY]));
    const when = now - 3 * 3_600_000;
    const tx = a.run(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
      VALUES ('mpesa','till','out',88500,?,?,'mpesa.till','1','confirmed','transaction')`, [cpId, when]);
    a.run(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`, [lastInsertId(tx), ensureLabel("Groceries"), when, when]);
  } catch { /* receipt demo is best effort */ }

  // A habit with real antecedents: eight late-night food payments, plus evening meals that follow groceries.
  try {
    const eatingOut = ensureLabel("Eating out");
    const groceriesLabel = ensureLabel("Groceries");
    const cp = a.get(`SELECT id FROM counterparties WHERE key LIKE 'n:%' LIMIT 1`) as { id?: number } | undefined;
    for (let i = 0; i < 8; i++) {
      const at = now - (i * 7 + 2) * DAY;
      const eatNight = new Date(at + 3 * 3_600_000);
      eatNight.setUTCHours(23, 5, 0, 0);
      const when = eatNight.getTime() - 3 * 3_600_000;
      const tx = a.run(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
        VALUES ('mpesa','till','out',35000,?,?,'mpesa.till','1','confirmed','transaction')`, [cp?.id ?? null, when]);
      const txId = lastInsertId(tx);
      a.run(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`, [txId, eatingOut, when, when]);
      addTxItem(a, txId, { item: "chapo", amountCents: 35000, source: "user", confirmed: true }, when);
      const groceryAt = when - 4 * 3_600_000;
      const g = a.run(`INSERT INTO transactions (provider,kind,direction,amount,counterparty_id,occurred_at,template,parser_version,status,role)
        VALUES ('mpesa','till','out',12000,?,?,'mpesa.till','1','confirmed','transaction')`, [cp?.id ?? null, groceryAt]);
      const gid = lastInsertId(g);
      a.run(`INSERT INTO tx_labels (tx_id,label_id,source,confidence,suggested_at,confirmed_at) VALUES (?,?,'user',1,?,?)`, [gid, groceriesLabel, groceryAt, groceryAt]);
    }
  } catch { /* habit demo is best effort */ }

  // Safety demo: one live phishing alert and one suppressed balance break in the audit view.
  try {
    ingestSms({
      sender: "EQUITYBANK",
      body: "Your account is suspended. Verify your PIN at https://equity-secure.example/login",
      receivedAt: now - 55 * 60_000,
    }, store);
    ingestSms({
      sender: "NCBA",
      body: "NCBA: KES 3,200.00 was taken from your account 0123 on 30 Oct. Balance KES 45,000.00. Ref NCB901. Confirmed.",
      receivedAt: now - 2 * 3_600_000,
    }, store);
    const lastTx = a.get(`SELECT id FROM transactions WHERE provider='mpesa' AND role='transaction' ORDER BY occurred_at DESC LIMIT 1`) as { id?: number } | undefined;
    if (lastTx?.id) {
      insertSecurityAlert(a, {
        txId: lastTx.id, severity: "warning", kind: "balance_break", sender: "MPESA",
        title: "Balance doesn't add up after this payment",
        detail: "Your M-Pesa balance doesn't add up after this payment (off by KES 50). Usually a message arrived late or is missing. Check the messages.",
        evidence: { discrepancy: 5_000, provider: "mpesa", ref: "DEMO-AUDIT" },
        occurredAt: now - 4 * 3_600_000, suppressedReason: "fuliza_reorder", visibility: "audit",
      });
    }
  } catch { /* safety demo is best effort */ }

  // A declared plan for the demo: one steady bill, one seasonal one and one the persona does not pay,
  // so Follow-through has on-time, partial/missed and drifted cases instead of an empty state.
  createFlow(a, { direction: "out", name: "Fuel", cadence: "weekly", weekday: 1, amountMinCents: 60_000, amountTypCents: 105_000, amountMaxCents: 160_000, counterpartyHint: "SHELL", graceDays: 1, missedAfterDays: 3, source: "user" }, now);
  createFlow(a, { direction: "out", name: "Data bundles", cadence: "monthly", dayOfMonth: 5, amountMinCents: 20_000, amountTypCents: 100_000, amountMaxCents: 200_000, counterpartyHint: "bundle", graceDays: 2, missedAfterDays: 5, source: "user" }, now);
  createFlow(a, { direction: "out", name: "Rent", cadence: "monthly", dayOfMonth: 1, amountTypCents: 1_500_000, graceDays: 2, missedAfterDays: 7, source: "user" }, now);
  try { refreshOccurrences(a, now); } catch { /* adherence stays empty if generation fails */ }

  try { ensureFts(a); rebuildSearchIndex(a); } catch { /* LIKE fallback */ }
  let nightlyError: string | undefined;
  try { runNightlyOnDevice(db, now); } catch (e) { nightlyError = String(e).slice(0, 180); }

  // Demo-only understanding layer: a late-night habit, a completed experiment, itemised groceries,
  // and a Fuliza draw so the Steady/Fuliza cards have something coherent to show.
  try {
    const eatingOut = ensureLabel("Eating out");
    const habitId = createHabit(a, {
      name: "Late-night food",
      selector: { labels: [eatingOut], direction: "out", window: { startMin: 22 * 60, endMin: 5 * 60 } },
      direction: "reduce",
      target: { period: "week", count: 2 },
      baseline: { count: 4.2, valueCents: 84_000 },
      nudge: { enabled: true, minuteOfDay: 21 * 60 + 30, weekdays: [1, 2, 3, 4, 5, 6, 0] },
    }, now);
    a.run(
      `INSERT INTO experiments (name, hypothesis, started_at, ended_at, metric_measure, status, created_at, habit_id, mode, result_json)
       VALUES ('No takeaway after 22:00', 'Cooking before 21:00 reduces late-night food.', ?, ?, 'habit_count', 'completed', ?, ?, 'live', ?)`,
      [now - 28 * DAY, now - 2 * DAY, now - 28 * DAY, habitId, JSON.stringify({ cumulativeEffect: -5, lo95: -8.4, hi95: -1.2, preMean: 1.4, postMean: 0.4, counterfactualMean: 1.5, n: 28, pNegative: 0.01 })],
    );

    const groceries = ensureLabel("Groceries");
    const shopTxs = a.all(`SELECT id FROM transactions WHERE role='transaction' AND direction='out'
      AND EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.tx_id=transactions.id AND tl.label_id=?) ORDER BY occurred_at DESC LIMIT 6`, [groceries]) as Array<{ id: number }>;
    const baskets = [
      [["bread", 6_500], ["milk", 6_500], ["sugar", 16_000]],
      [["maize flour", 20_500], ["cooking oil", 39_000], ["milk", 6_500]],
      [["eggs", 15_000], ["bananas", 10_000]],
      [["rice", 18_000], ["tomatoes", 8_000]],
      [["soap", 12_000], ["salt", 3_000]],
      [["kale", 5_000], ["onions", 7_000]],
    ] as const;
    shopTxs.forEach((t, i) => {
      for (const [name, cents] of baskets[i % baskets.length]!) addTxItem(a, t.id, { item: name, amountCents: cents, source: "user", confirmed: true }, now);
    });

    const fuliza = a.get(`SELECT id FROM accounts WHERE kind='credit' AND name LIKE '%uliza%' LIMIT 1`) as { id?: number } | undefined;
    const existingOut = Number((a.get(`SELECT COALESCE(SUM(CASE WHEN kind='loan_draw' THEN amount ELSE -amount END),0) AS n FROM transactions WHERE kind IN ('loan_draw','loan_repay') AND template LIKE 'mpesa.fuliza%'`) as { n?: number } | undefined)?.n ?? 0);
    if (existingOut <= 0) {
      a.run(`INSERT INTO transactions (provider,kind,direction,amount,occurred_at,template,parser_version,status,role,balance_after)
        VALUES ('mpesa','loan_draw','in',150000,?,'mpesa.fuliza_draw','1','confirmed','funding_notice',NULL)`, [now - 2 * 3_600_000]);
      if (fuliza?.id) a.run(`UPDATE accounts SET outstanding_cents=150000, available_credit_cents=MAX(0, COALESCE(credit_limit_cents,0)-150000), updated_at=? WHERE id=?`, [now - 2 * 3_600_000, fuliza.id]);
    }
    // Link one recent purchase to the Fuliza draw so credit-share and episodes have a real example.
    const draw = a.get(`SELECT id FROM transactions WHERE kind='loan_draw' AND template LIKE 'mpesa.fuliza%' ORDER BY occurred_at DESC LIMIT 1`) as { id?: number } | undefined;
    const buy = a.get(`SELECT id FROM transactions WHERE role='transaction' AND direction='out' AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`, [now - 7 * DAY]) as { id?: number } | undefined;
    if (draw?.id && buy?.id) {
      a.run(`UPDATE transactions SET ref='DEMO-FULIZA-1' WHERE id=?`, [draw.id]);
      a.run(`UPDATE transactions SET event_ref='DEMO-FULIZA-1' WHERE id=?`, [buy.id]);
    }
    rebuildItemPrices(a);
    a.run(`INSERT INTO meta (key, value) VALUES ('demo_seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(now)]);
  } catch { /* non-fatal demo enrichments */ }

  return { messages: rows.length, stored, labelled, pending: Math.min(14, stored), ms: Date.now() - t0, nightlyError };
}
