/**
 * Infer likely livelihoods from the user's own ledger, then let the user confirm or reject.
 * This is a suggestion, never a silent label. Names/evidence stay local.
 */
import type { DbAdapter } from "../db/migrate.js";
import { PACKS, type BuiltinPack } from "../packs/builtin.js";

export interface IdentityHypothesis {
  packId: string;
  name: string;
  confidence: number;
  why: string[];
  evidence: Record<string, number>;
}

export function inferIdentity(db: DbAdapter, now = Date.now()): IdentityHypothesis[] {
  const since = now - 120 * 86_400_000;
  const labels = db.all(
    `SELECT COALESCE(l.name, 'No label') AS name, COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n
       FROM tx_events t
       LEFT JOIN labels l ON l.id = (
         SELECT l2.id FROM tx_labels tl2 JOIN labels l2 ON l2.id = tl2.label_id
          WHERE tl2.tx_id = t.id ORDER BY (tl2.confirmed_at IS NOT NULL) DESC, COALESCE(tl2.confidence,0) DESC LIMIT 1)
      WHERE t.occurred_at >= ? GROUP BY COALESCE(l.name, 'No label')`,
    [since],
  ) as Array<{ name: string; total: number; n: number }>;
  const by = new Map(labels.map((r) => [r.name, r]));
  const get = (name: string) => by.get(name)?.total ?? 0;

  const income = db.all(
    `SELECT t.counterparty_id AS cpId, COUNT(*) AS n, COALESCE(SUM(t.amount),0) AS total
       FROM tx_events t WHERE t.direction = 'in' AND t.occurred_at >= ? AND t.counterparty_id IS NOT NULL
      GROUP BY t.counterparty_id ORDER BY total DESC LIMIT 10`,
    [since],
  ) as Array<{ cpId: number; n: number; total: number }>;
  const totalIncome = income.reduce((s, r) => s + Number(r.total), 0);
  const incomeSources = income.filter((r) => Number(r.total) > 0).length;

  const salaryMonths = db.all(
    `SELECT DISTINCT strftime('%Y-%m', t.occurred_at / 1000, 'unixepoch', '+3 hours') AS m
       FROM tx_events t JOIN tx_labels tl ON tl.tx_id = t.id JOIN labels l ON l.id = tl.label_id
      WHERE l.name = 'Salary' AND t.occurred_at >= ? AND tl.confirmed_at IS NOT NULL`,
    [since],
  ) as Array<{ m: string }>;
  const salary = get("Salary");
  const fuel = get("Fuel");
  const transport = get("Transport");
  const stock = get("Business stock");
  const rent = get("Rent");
  const food = get("Eating out") + get("Groceries");
  const debt = get("Debt repayment");
  const fees = get("Fees & charges");
  const businessLabels = stock + get("Business stock") + get("Sales (business)");

  const scores = new Map<string, { score: number; why: string[]; evidence: Record<string, number> }>();
  const add = (id: string, score: number, why: string[], evidence: Record<string, number>) => {
    const cur = scores.get(id) ?? { score: 0, why: [], evidence: {} };
    cur.score += score; cur.why.push(...why); Object.assign(cur.evidence, evidence);
    scores.set(id, cur);
  };

  if (fuel > 0 || transport > 0) {
    const score = fuel > 0 && transport > 0 ? 3 : 1.4;
    add("boda_rider", score + (debt > 0 ? 0.5 : 0), [
      fuel > 0 ? "You buy fuel often." : "You pay for transport often.",
      transport > 0 ? "Transport is a regular cost." : "Fuel is a regular cost.",
    ], { fuel, transport });
  }
  if (salary > 0 && (salaryMonths.length >= 2 || salary >= totalIncome * 0.5)) {
    add("salaried_professional", 3 + Math.min(1, salaryMonths.length / 4), [
      "A salary arrives more than once.",
      "Rent and everyday bills look like a salaried month.",
    ], { salary, salaryMonths: salaryMonths.length });
  }
  if (stock > 0 && (get("Sales (business)") > 0 || incomeSources >= 3)) {
    add("mama_mboga", 2.2, ["You buy stock and receive many small payments."], { stock, incomeSources });
  }
  if (stock > 0 && rent > 0) {
    add("small_shop", 2.4, ["You pay stock and rent together."], { stock, rent });
  }
  if (incomeSources >= 3 && salary === 0 && totalIncome > 0) {
    add("freelancer", 1.8, ["Money comes from several different people."], { incomeSources, totalIncome });
  }
  if (transport > 0 && food > 0 && salary === 0 && debt + fees < food) {
    add("student", 1.2, ["Transport and food are your main costs."], { transport, food });
  }

  const sum = [...scores.values()].reduce((s, x) => s + x.score, 0) || 1;
  return [...scores.entries()]
    .filter(([, v]) => v.score >= 1)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)
    .map(([id, v]) => {
      const pack = PACKS.find((p: BuiltinPack) => p.id === id);
      return {
        packId: id, name: pack?.name ?? id,
        confidence: Math.min(0.86, 0.35 + 0.5 * (v.score / sum)),
        why: v.why.slice(0, 3), evidence: v.evidence,
      };
    });
}
