import type { Detector, Finding, LedgerTx } from "./types.js";
import { mean, median } from "./stats.js";
import { toEatParts } from "../sms/time.js";

const DAY = 86_400_000;

export interface MobilityOpts {
  minLocated?: number;
  minNovel?: number;
  minMultiplier?: number;
  minPaydays?: number;
  minLateNightShare?: number;
  minOutflowsForLateNight?: number;
}

/**
 * Context phenotyping without a map provider:
 * - location: Haversine centre of mass, radius of gyration, Shannon entropy over 0.01-degree
 *   cells, and novel-vs-routine spend. "Novel" means farther than 2*r_g from the centre.
 * - payday/present bias: large inflows (>=3x median inflow), the median days to spend half of
 *   each inflow, and the day 1-3 vs day 10-25 burn-rate multiplier.
 * - late-night outflow share in EAT.
 * Missing location fields simply suppress the first finding; the temporal findings still run.
 */
export const detectMobilityPhenotyping: Detector<MobilityOpts> = (txs, opts = {}) => {
  const {
    minLocated = 10,
    minNovel = 5,
    minMultiplier = 1.3,
    minPaydays = 3,
    minLateNightShare = 0.2,
    minOutflowsForLateNight = 10,
  } = opts;

  const findings: Finding[] = [];
  const located = txs.filter((t) =>
    typeof t.lat === "number" && isFinite(t.lat) && typeof t.lng === "number" && isFinite(t.lng),
  ) as Array<LedgerTx & { lat: number; lng: number }>;

  if (located.length >= minLocated) {
    const center = centerOfMass(located);
    const distances = located.map((t) => haversineKm(center.lat, center.lng, t.lat, t.lng));
    const rgKm = Math.sqrt(mean(distances.map((d) => d * d)));
    const entropy = cellEntropy(located);
    if (rgKm > 0) {
      const novel: number[] = [];
      const routine: number[] = [];
      for (let i = 0; i < located.length; i++) {
        if (distances[i]! > 2 * rgKm) novel.push(located[i]!.amount);
        else routine.push(located[i]!.amount);
      }
      const novelMean = mean(novel);
      const routineMean = mean(routine);
      const multiplier = routineMean > 0 ? novelMean / routineMean : (novel.length ? Infinity : 0);
      if (novel.length >= minNovel && multiplier >= minMultiplier && isFinite(multiplier)) {
        findings.push({
          detector: "mobility_phenotyping",
          id: `mobility_phenotyping:novel:${Math.round(rgKm * 100)}:${Math.round(multiplier * 100)}`,
          title: `Spending outside your usual area is ${multiplier.toFixed(1)}x your routine (KES ${kes(novelMean)} vs KES ${kes(routineMean)}; ${novel.length} of ${located.length} located txs)`,
          n: located.length,
          evidence: { rgKm, entropy, novelMean, routineMean, multiplier, novelN: novel.length, routineN: routine.length },
        });
      }
    }
  }

  const inflows = txs.filter((t) => t.direction === "in" && t.amount > 0).sort((a, b) => a.occurredAt - b.occurredAt);
  if (inflows.length >= minPaydays) {
    const med = median(inflows.map((t) => t.amount));
    const paydays = med > 0 ? inflows.filter((t) => t.amount >= 3 * med) : [];
    if (paydays.length >= minPaydays) {
      const outflows = txs.filter((t) => t.direction === "out").sort((a, b) => a.occurredAt - b.occurredAt);
      const halfLives: number[] = [];
      let earlyTotal = 0;
      let lateTotal = 0;
      for (const payday of paydays) {
        const after = outflows.filter((t) =>
          t.occurredAt >= payday.occurredAt && t.occurredAt < payday.occurredAt + 30 * DAY,
        );
        halfLives.push(halfLifeDays(payday, after));
        for (const t of after) {
          const dt = (t.occurredAt - payday.occurredAt) / DAY;
          if (dt < 3) earlyTotal += t.amount;
          else if (dt >= 10 && dt < 25) lateTotal += t.amount;
        }
      }
      const halfLife = median(halfLives);
      const earlyRate = earlyTotal / (3 * paydays.length);
      const lateRate = lateTotal / (15 * paydays.length);
      const multiplier = lateRate > 0 ? earlyRate / lateRate : (earlyRate > 0 ? 9.99 : 1);
      findings.push({
        detector: "mobility_phenotyping",
        id: `mobility_phenotyping:payday:${Math.round(halfLife)}:${Math.round(multiplier * 10)}`,
        title: `Payday half-life ${halfLife.toFixed(0)}d; spending is ${multiplier.toFixed(1)}x faster in the first 3 days`,
        n: paydays.length,
        evidence: {
          paydays: paydays.length,
          medianHalfLifeDays: halfLife,
          halfLivesDays: halfLives,
          earlyRatePerDayCents: earlyRate,
          lateRatePerDayCents: lateRate,
          multiplier,
          medianInflowCents: med,
        },
      });
    }
  }

  const outflows = txs.filter((t) => t.direction === "out");
  if (outflows.length >= minOutflowsForLateNight) {
    const late = outflows.filter((t) => {
      const h = toEatParts(t.occurredAt).hour;
      return h >= 22 || h < 4;
    });
    const share = late.length / outflows.length;
    if (share >= minLateNightShare) {
      const lateMean = mean(late.map((t) => t.amount));
      findings.push({
        detector: "mobility_phenotyping",
        id: `mobility_phenotyping:late:${late.length}:${Math.round(share * 100)}`,
        title: `${late.length} of ${outflows.length} outflows (${Math.round(share * 100)}%) happen between 22:00 and 04:00 EAT, averaging KES ${kes(lateMean)}`,
        n: outflows.length,
        evidence: { count: late.length, share, meanAmountCents: lateMean, meanAmount: lateMean, window: [22, 4] },
      });
    }
  }

  return findings;
};

function centerOfMass(points: Array<{ lat: number; lng: number }>): { lat: number; lng: number } {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    const lat = (p.lat * Math.PI) / 180;
    const lng = (p.lng * Math.PI) / 180;
    const c = Math.cos(lat);
    x += c * Math.cos(lng);
    y += c * Math.sin(lng);
    z += Math.sin(lat);
  }
  const norm = Math.sqrt(x * x + y * y + z * z);
  if (norm < 1e-12) {
    return { lat: mean(points.map((p) => p.lat)), lng: mean(points.map((p) => p.lng)) };
  }
  return {
    lat: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function cellEntropy(points: Array<{ lat: number; lng: number }>): number {
  const counts = new Map<string, number>();
  for (const p of points) {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const n = points.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function halfLifeDays(inflow: LedgerTx, outflows: LedgerTx[]): number {
  const target = inflow.amount / 2;
  let cumulative = 0;
  let previous = inflow.occurredAt;
  for (const t of outflows) {
    if (cumulative + t.amount >= target) {
      const fraction = t.amount > 0 ? (target - cumulative) / t.amount : 0;
      const crossing = previous + fraction * (t.occurredAt - previous);
      return Math.max(0, (crossing - inflow.occurredAt) / DAY);
    }
    cumulative += t.amount;
    previous = t.occurredAt;
  }
  return 30;
}

function kes(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}
