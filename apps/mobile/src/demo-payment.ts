import type { SQLiteDatabase } from "expo-sqlite";
import { formatEat, formatKes, ingestSms } from "@yako/core";
import { SqliteStore } from "./store";
import { runAfterIngest } from "./runtime/cycle";

/** Demo-only: a fresh cigarette payment arrives through the same ingest + prompt path as SMS. */
export async function sendCigarettePayment(db: SQLiteDatabase): Promise<number | null> {
  const store = new SqliteStore(db);
  const last = db.getFirstSync<{ b: number | null }>(`SELECT balance_after AS b FROM transactions WHERE provider='mpesa' AND balance_after IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`);
  if (last?.b == null) return null;
  const now = Date.now();
  const [d, t] = formatEat(now).split("|") as [string, string];
  const ref = `DEMO${String(now).slice(-6)}`;
  const body = `${ref} Confirmed. Ksh30.00 paid to KIBANDA SHOP. on ${d} at ${t}.New M-PESA balance is ${formatKes(last.b - 3000)}. Transaction cost, Ksh0.00.`;
  const res = ingestSms({ sender: "MPESA", body, receivedAt: now }, store);
  if (!res.actions) return null;
  await runAfterIngest(db, { read: 1, stored: 1, recent: res.actions ? [res.actions] : [], ms: 0 });
  return res.actions.txId;
}
