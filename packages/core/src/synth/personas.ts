import type { Cents, TxKind } from "../types.js";
import { rng, type Rng } from "./rng.js";
import { renderMpesa, renderFuliza, sendFee, withdrawFee } from "./render.js";

/** Ground truth attached to each synthetic message: what a perfect agent would label. */
export interface Truth {
  label: string;
  role?: string;
  scope: "personal" | "business" | "mixed";
  episode?: string;
  note?: string;
}
export interface SynthSms { sender: string; body: string; receivedAt: number; truth: Truth; kind: TxKind }

/** Patterns deliberately planted in the data = ground truth for detector recall tests AND the demo script. */
export interface PlantedPattern {
  id: string;
  detector: "amount_multiples" | "periodic" | "time_of_day" | "debt_cycle" | "episodes" | "scope_mix" | "balance_break" | "fee_drag";
  description: string;
  params: Record<string, unknown>;
}
export interface Corpus { persona: string; messages: SynthSms[]; planted: PlantedPattern[] }

// FAKE data only. Phones are in a reserved-looking block; names are common-name mashups. No real people.
const FIRST = ["Wanjiku", "Otieno", "Achieng", "Kamau", "Njeri", "Mwangi", "Akinyi", "Kiprop", "Wafula", "Atieno", "Mutua", "Chebet", "Odhiambo", "Naliaka", "Karanja"];
const LAST = ["Mwangi", "Otieno", "Kiptoo", "Wekesa", "Njoroge", "Ouma", "Kimani", "Cheruiyot", "Mutiso", "Wairimu"];
const name = (r: Rng) => `${r.pick(FIRST)} ${r.pick(LAST)}`.toUpperCase();
const phone = (r: Rng) => `07000000${String(r.int(0, 99)).padStart(2, "0")}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 2026-08-03 00:00 EAT (a Monday) as the stable default start. Callers can pass
// a different startAt (the demo seed uses now - days) without changing fixtures.
const DEFAULT_START = Date.UTC(2026, 7, 3) - 3 * HOUR;

class Wallet {
  bal: Cents;
  private out: SynthSms[] = [];
  private pending: Array<{ at: number; fn: () => void }> = [];
  constructor(startKes: number, private r: Rng) { this.bal = startKes * 100; }
  private ref() { return "T" + Array.from({ length: 9 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[this.r.int(0, 33)]).join(""); }
  /** Ops are queued then executed in TIME order so the stated balances form a valid chain. */
  private q(at: number, fn: () => void) { this.pending.push({ at, fn }); }
  receive(at: number, kes: number, from: string, ph: string, truth: Truth) {
    this.q(at, () => { const amount = kes * 100; this.bal += amount;
      this.push(at, truth, "receive", renderMpesa({ kind: "receive", ref: this.ref(), amount, name: from, phone: ph, at, bal: this.bal })); });
  }
  send(at: number, kes: number, to: string, ph: string, truth: Truth) {
    this.q(at, () => { const amount = kes * 100, fee = sendFee(kes) * 100; this.bal -= amount + fee;
      this.push(at, truth, "send", renderMpesa({ kind: "send", ref: this.ref(), amount, name: to, phone: ph, at, bal: this.bal, fee })); });
  }
  paybill(at: number, kes: number, to: string, acct: string, truth: Truth) {
    this.q(at, () => { const amount = kes * 100; this.bal -= amount;
      this.push(at, truth, "paybill", renderMpesa({ kind: "paybill", ref: this.ref(), amount, name: to, acct, at, bal: this.bal, fee: 0 })); });
  }
  till(at: number, kes: number, to: string, truth: Truth) {
    this.q(at, () => { const amount = kes * 100; this.bal -= amount;
      this.push(at, truth, "till", renderMpesa({ kind: "till", ref: this.ref(), amount, name: to, at, bal: this.bal, fee: 0 })); });
  }
  withdraw(at: number, kes: number, truth: Truth) {
    this.q(at, () => { const amount = kes * 100, fee = withdrawFee(kes) * 100; this.bal -= amount + fee;
      this.push(at, truth, "withdraw", renderMpesa({ kind: "withdraw", ref: this.ref(), amount, name: "NYAMBURA AGENCIES", agent: "123456", at, bal: this.bal, fee })); });
  }
  airtime(at: number, kes: number, truth: Truth) {
    this.q(at, () => { const amount = kes * 100; this.bal -= amount;
      this.push(at, truth, "airtime", renderMpesa({ kind: "airtime", ref: this.ref(), amount, at, bal: this.bal })); });
  }
  /** Fuliza draw: overdraft credits SPENDABLE money into the wallet (message states no balance). */
  fulizaDraw(at: number, kes: number, truth: Truth) {
    this.q(at, () => {
      this.bal += kes * 100;
      this.push(at, truth, "loan_draw", renderFuliza({ kind: "draw", ref: this.ref(), amount: kes * 100, at }));
    });
  }
  /** Fuliza auto-recovery from wallet: "KshX from your M-PESA has been used to fully pay your outstanding Fuliza..." */
  fulizaRepay(at: number, kes: number, truth: Truth) {
    this.q(at, () => { const amount = kes * 100; this.bal -= amount;
      this.push(at, truth, "loan_repay", renderFuliza({ kind: "repay_full", ref: this.ref(), amount, at, bal: this.bal }));
    });
  }
  /** Deliberately break the chain at time `at` (simulates a missing or forged message). */
  gap(at: number, kes: number) { this.q(at, () => { this.bal -= kes * 100; }); }
  /** Execute queued ops in time order (stable) and return the SMS stream. */
  finish(): SynthSms[] {
    this.pending.map((p, i) => ({ ...p, i })).sort((a, b) => a.at - b.at || a.i - b.i).forEach((p) => p.fn());
    return this.out;
  }
  private push(at: number, truth: Truth, kind: TxKind, body: string) {
    this.out.push({ sender: "MPESA", body, receivedAt: at, truth, kind });
  }
}

const makeAt = (startAt: number) => (day: number, hour: number, min = 0) => startAt + day * DAY + hour * HOUR + min * 60_000;

/** Mama mboga: many customers pay 50/100/150 (multiples of 50) mostly morning + evening; wholesale till at 5am; weekly rent. */
export function mamaMboga(seed = 1, days = 90, startAt = DEFAULT_START): Corpus {
  const at = makeAt(startAt);
  const r = rng(seed); const w = new Wallet(20_000, r);
  for (let d = 0; d < days; d++) {
    const dow = (d + 1) % 7; // 0=Sun since START is Monday => d=0 -> 1
    w.till(at(d, 5, r.int(0, 40)), r.int(4, 8) * 100, "GIKOMBA WHOLESALERS", { label: "Stock (business)", scope: "business", role: "supplier" });
    const nSales = r.int(8, 18);
    for (let i = 0; i < nSales; i++) {
      const slot = r.chance(0.5) ? r.int(6, 9) : r.int(16, 19);
      w.receive(at(d, slot, r.int(0, 59)), r.pick([50, 100, 150, 50, 100, 50]), name(r), phone(r), { label: "Sales (business)", scope: "business", role: "customer" });
    }
    if (dow === 1) w.paybill(at(d, 9), 1200, "LANDLORD KAMAU PAYBILL", "FLAT 4B", { label: "Rent (stall)", scope: "business", role: "landlord" });
    if (dow === 6) w.send(at(d, 18), r.int(500, 1200), "WANJIKU MWANGI", "0700000001", { label: "Family support", scope: "personal", role: "family" });
    if (d % 10 === 0) w.airtime(at(d, 7), 100, { label: "Airtime", scope: "mixed" });
    if (d % 14 === 5) w.withdraw(at(d, 12), 2000, { label: "Cash withdrawal", scope: "mixed" });
  }
  w.gap(at(days, 6), 300); // planted missing message
  w.receive(at(days, 7), 100, name(r), phone(r), { label: "Sales (business)", scope: "business", role: "customer" });
  return { persona: "mama_mboga", messages: w.finish(), planted: [
    { id: "pp-mm-1", detector: "amount_multiples", description: "Incoming P2P amounts are multiples of KES 50 (price points 50/100/150)", params: { base: 50, direction: "in" } },
    { id: "pp-mm-2", detector: "time_of_day", description: "Sales concentrate 06-09h and 16-19h", params: { peaks: [[6, 9], [16, 19]] } },
    { id: "pp-mm-3", detector: "periodic", description: "Wholesale till payment daily ~05h", params: { counterparty: "GIKOMBA WHOLESALERS", periodHours: 24 } },
    { id: "pp-mm-4", detector: "periodic", description: "Rent paybill every Monday", params: { counterparty: "LANDLORD KAMAU PAYBILL", periodDays: 7 } },
    { id: "pp-mm-5", detector: "scope_mix", description: "Family transfers (personal) paid from the business wallet", params: { label: "Family support" } },
    { id: "pp-mm-6", detector: "balance_break", description: "One KES 300 unexplained balance drop before the final message", params: { discrepancyKes: 300 } },
  ] };
}

/** Salaried personal: salary on 28th, rent 1st, groceries vs eating out, plus a weekend trip bundle. */
export function salariedTrip(seed = 2, days = 90, startAt = DEFAULT_START): Corpus {
  const at = makeAt(startAt);
  const r = rng(seed); const w = new Wallet(150_000, r);
  const eatOut = ["JAVA HOUSE WESTLANDS", "KFC SARIT", "CARNIVORE RESTAURANT", "ARTCAFFE JUNCTION"];
  const grocer = ["QUICKMART LAVINGTON", "NAIVAS KILIMANI", "CARREFOUR HUB"];
  for (let d = 0; d < days; d++) {
    const dom = ((d + 2) % 28) + 1; // crude day-of-month
    if (dom === 28) w.receive(at(d, 9), 85_000, "ACME LTD PAYROLL", "0700000000", { label: "Salary", scope: "personal", role: "employer" });
    if (dom === 1) w.paybill(at(d, 8), 28_000, "RENT PROPERTIES LTD", "A12", { label: "Rent", scope: "personal", role: "landlord" });
    if (d % 7 === 5) w.till(at(d, 19), r.int(1200, 4500), r.pick(eatOut), { label: "Eating out", scope: "personal" });
    if (d % 7 === 6) w.till(at(d, 11), r.int(2500, 7000), r.pick(grocer), { label: "Groceries", scope: "personal" });
    if (d % 7 < 5) w.till(at(d, 7, 40), r.pick([200, 250, 300]), "UBER KENYA", { label: "Transport to work", scope: "personal" });
  }
  // Planted episode: Naivasha weekend (fuel, fare, hotel, meals, fees) = 'total cost of an outing'
  const trip = 40; const ep = "Naivasha weekend";
  w.till(at(trip, 6), 4000, "TOTAL ENERGIES KASARANI", { label: "Fuel", scope: "personal", episode: ep });
  w.paybill(at(trip, 10), 15_000, "SOPA LODGE NAIVASHA", "BK7781", { label: "Accommodation", scope: "personal", episode: ep });
  w.till(at(trip, 13), 3200, "CRESCENT CAMP RESTAURANT", { label: "Eating out", scope: "personal", episode: ep });
  w.send(at(trip + 1, 9), 1500, "OTIENO KARANJA", "0700000042", { label: "Boat ride (shared)", scope: "personal", episode: ep, note: "paid on behalf of friend" });
  w.till(at(trip + 1, 16), 4000, "TOTAL ENERGIES NAIVASHA", { label: "Fuel", scope: "personal", episode: ep });
  return { persona: "salaried_trip", messages: w.finish(), planted: [
    { id: "pp-st-1", detector: "episodes", description: "Naivasha weekend: fuel x2 + lodge + meal + boat + fees bundle", params: { episode: ep, txCount: 5 } },
    { id: "pp-st-2", detector: "periodic", description: "Salary on the 28th; rent on the 1st", params: {} },
  ] };
}

/** Boda rider: daily fuel at dawn, many small customer fares, weekly Fuliza draw/repay loop, agent float top-ups. */
export function bodaRider(seed = 3, days = 90, startAt = DEFAULT_START): Corpus {
  const at = makeAt(startAt);
  const r = rng(seed); const w = new Wallet(3_000, r);
  for (let d = 0; d < days; d++) {
    const dow = (d + 1) % 7;
    // fares: 4-12 small receives spread 06-20h (planted: daytime spread, no peak)
    for (let i = 0, n = r.int(4, 12); i < n; i++) {
      w.receive(at(d, r.int(6, 20), r.int(0, 59)), r.pick([50, 100, 150, 200, 100, 50]), name(r), phone(r),
        { label: "Fares (business)", scope: "business", role: "customer" });
    }
    // fuel every morning 06:30-07:30 at the same station
    w.till(at(d, 7, r.int(0, 60) - 30 < 0 ? 0 : r.int(0, 60)), r.pick([250, 300, 300, 350]), "SHELL KIAMBU RD",
      { label: "Fuel", scope: "business", role: "supplier" });
    // float top-up every 3-4 days
    if (d % 4 === 0) w.withdraw(at(d, 8), 2000, { label: "Cash withdrawal", scope: "business" });
    // Fuliza weekly cycle: draw Monday 06:10, auto-repay Wednesday (planted debt cycle)
    if (dow === 1) w.fulizaDraw(at(d, 6, 10), 500, { label: "Fuliza", scope: "business" });
    if (dow === 3) w.fulizaRepay(at(d, 10), 500, { label: "Fuliza", scope: "business" });
    // send money home monthly
    if (d % 30 === 12) w.send(at(d, 19), 3000, "MAMA WEKESA", "0700000007", { label: "Family support", scope: "personal", role: "family" });
  }
  return { persona: "boda_rider", messages: w.finish(), planted: [
    { id: "pp-br-1", detector: "time_of_day", description: "Fuel till payments concentrate 06-09h", params: { peaks: [[6, 9]] } },
    { id: "pp-br-2", detector: "periodic", description: "Fuel at the same till daily", params: { counterparty: "SHELL KIAMBU RD", periodHours: 24 } },
    { id: "pp-br-3", detector: "debt_cycle", description: "Weekly Fuliza draw (Mon) + auto-repay (Wed) loop", params: { counterparty: "fuliza", drawsPer4Weeks: 4 } },
    { id: "pp-br-4", detector: "fee_drag", description: "Fees: send fees + Fuliza recovery + withdrawal", params: {} },
  ] };
}

export const PERSONAS = { mama_mboga: mamaMboga, salaried_trip: salariedTrip, boda_rider: bodaRider } as const;
