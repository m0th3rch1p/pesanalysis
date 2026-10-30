import type { Cents } from "../types.js";
import { formatEat } from "../sms/time.js";

/** Approximate M-Pesa send tariff (KES). Synthetic only; real tariffs change. */
export function sendFee(amountKes: number): number {
  const tiers: Array<[number, number]> = [[100, 0], [500, 7], [1000, 13], [1500, 23], [2500, 33], [3500, 53], [5000, 57], [7500, 78], [10000, 90], [15000, 100], [20000, 105]];
  for (const [max, fee] of tiers) if (amountKes <= max) return fee;
  return 108;
}
export function withdrawFee(amountKes: number): number {
  return Math.max(10, Math.round(amountKes * 0.014));
}

const k = (c: Cents) => `Ksh${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dt = (ms: number) => formatEat(ms).split("|") as [string, string];

export type RenderIn =
  | { kind: "receive"; ref: string; amount: Cents; name: string; phone: string; at: number; bal: Cents }
  | { kind: "send"; ref: string; amount: Cents; name: string; phone: string; at: number; bal: Cents; fee: Cents }
  | { kind: "paybill"; ref: string; amount: Cents; name: string; acct: string; at: number; bal: Cents; fee: Cents }
  | { kind: "till"; ref: string; amount: Cents; name: string; at: number; bal: Cents; fee: Cents }
  | { kind: "withdraw"; ref: string; amount: Cents; name: string; agent: string; at: number; bal: Cents; fee: Cents }
  | { kind: "airtime"; ref: string; amount: Cents; at: number; bal: Cents };

/** Renders in the same template family the parser expects. NOT independent evidence of real-world coverage. */
export function renderMpesa(t: RenderIn): string {
  const [d, tm] = dt(t.at);
  switch (t.kind) {
    case "receive":
      return `${t.ref} Confirmed.You have received ${k(t.amount)} from ${t.name} ${t.phone} on ${d} at ${tm}  New M-PESA balance is ${k(t.bal)}.  Earn interest daily on Ziidi.`;
    case "send":
      return `${t.ref} Confirmed. ${k(t.amount)} sent to ${t.name} ${t.phone} on ${d} at ${tm}. New M-PESA balance is ${k(t.bal)}. Transaction cost, ${k(t.fee)}. Amount you can transact within the day is 498,000.00.`;
    case "paybill":
      return `${t.ref} Confirmed. ${k(t.amount)} sent to ${t.name} for account ${t.acct} on ${d} at ${tm} New M-PESA balance is ${k(t.bal)}. Transaction cost, ${k(t.fee)}.`;
    case "till":
      return `${t.ref} Confirmed. ${k(t.amount)} paid to ${t.name}. on ${d} at ${tm}.New M-PESA balance is ${k(t.bal)}. Transaction cost, ${k(t.fee)}.`;
    case "withdraw":
      return `${t.ref} Confirmed.on ${d} at ${tm} Withdraw ${k(t.amount)} from ${t.agent} - ${t.name} New M-PESA balance is ${k(t.bal)}. Transaction cost, ${k(t.fee)}.`;
    case "airtime":
      return `${t.ref} confirmed. You bought ${k(t.amount)} of airtime on ${d} at ${tm}.New M-PESA balance is ${k(t.bal)}.`;
  }
}

/** Fuliza templates (real format family, from the founder's inbox). Balance effect handled by the caller. */
export function renderFuliza(t: { kind: "draw" | "repay_full"; ref: string; amount: Cents; at: number; bal?: Cents }): string {
  const [d, tm] = dt(t.at);
  if (t.kind === "draw") {
    return `Fuliza M-PESA processed successfully. Transaction ID ${t.ref} Confirmed. Amount In: Ksh0.00. Amount Out: ${k(t.amount)}. Fuliza M-PESA amount is ${k(t.amount)}. on ${d} at ${tm}.`;
  }
  return `${t.ref} Confirmed. ${k(t.amount)} from your M-PESA has been used to fully pay your outstanding Fuliza M-PESA. Available Fuliza M-PESA limit is Ksh10,000.00. Your M-PESA balance is ${k(t.bal ?? 0)}.`;
}
