import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHawkesCascade,
  detectBocpdRegime,
  detectLiquidityRuin,
  detectTariffCliff,
  detectMobilityPhenotyping,
} from "../src/detectors/index.js";
import { causalImpact } from "../src/analytics/causal-impact.js";
import type { LedgerTx } from "../src/detectors/types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tx(partial: Partial<LedgerTx> & Pick<LedgerTx, "id" | "occurredAt" | "direction" | "amount">): LedgerTx {
  return { counterpartyKey: "t:test", ...partial };
}

test("hawkes: a self-exciting series has a positive branching ratio and emits", () => {
  const random = rng(20261026);
  const horizon = 30 * 24;
  const baseRate = 0.06;
  const seeds: number[] = [];
  let t = 0;
  while (t < horizon) {
    t += -Math.log(1 - random()) / baseRate;
    if (t < horizon) seeds.push(t);
  }
  const events = [...seeds];
  for (const s of seeds) {
    if (random() < 0.5) {
      const delay = -Math.log(1 - random()) / 0.5;
      if (s + delay < horizon) events.push(s + delay);
    }
  }
  events.sort((a, b) => a - b);
  assert.ok(events.length >= 20);

  const base = Date.UTC(2026, 0, 1);
  const txs = events.map((h, i) => tx({
    id: `h${i}`,
    occurredAt: base + h * HOUR,
    direction: "out",
    amount: 10_000,
    counterpartyKey: `t:${i % 4}`,
    label: i % 2 ? "Food" : "Transport",
  }));

  const findings = detectHawkesCascade(txs);
  const cascade = findings.find((f) => typeof (f.evidence as any).R === "number");
  assert.ok(cascade, JSON.stringify(findings));
  assert.ok(((cascade!.evidence as any).R as number) > 0.1);
  assert.match(cascade!.title, /Spending cascades/);
  assert.ok(findings.some((f) => /within 3h/.test(f.title)), findings.map((f) => f.title).join(" | "));
});

test("hawkes: fewer than 20 outflows stays silent", () => {
  const base = Date.UTC(2026, 0, 1);
  const txs = Array.from({ length: 10 }, (_, i) => tx({
    id: `tiny${i}`, occurredAt: base + i * DAY, direction: "out", amount: 5_000,
  }));
  assert.deepEqual(detectHawkesCascade(txs), []);
});

test("bocpd: detects a 100 -> 200 amount regime near the boundary", () => {
  const base = Date.UTC(2026, 0, 1);
  const txs: LedgerTx[] = [];
  for (let i = 0; i < 25; i++) txs.push(tx({
    id: `pre${i}`, occurredAt: base + i * DAY, direction: "out", amount: 100,
    counterpartyKey: "t:grocery", label: "Groceries",
  }));
  for (let i = 0; i < 25; i++) txs.push(tx({
    id: `post${i}`, occurredAt: base + (25 + i) * DAY, direction: "out", amount: 200,
    counterpartyKey: "t:grocery", label: "Groceries",
  }));

  const findings = detectBocpdRegime(txs);
  const change = findings.find((f) => (f.evidence as any).kind === "amount");
  assert.ok(change, JSON.stringify(findings));
  const ev = change!.evidence as any;
  assert.ok(Math.abs(ev.changeAt - (base + 25 * DAY)) <= 2 * DAY);
  assert.ok(Math.abs(ev.beforeMean - 100) < 25);
  assert.ok(Math.abs(ev.afterMean - 200) < 25);
  assert.ok(ev.probability >= 0.9);
});

test("bocpd: fixed-price interval shortening (shrinkflation) is detected", () => {
  const base = Date.UTC(2026, 0, 1);
  const txs: LedgerTx[] = [];
  let at = base;
  for (let i = 0; i < 18; i++) {
    txs.push(tx({
      id: `fuel${i}`, occurredAt: at, direction: "out", amount: 5_000,
      counterpartyKey: "t:fuel", label: "Fuel",
    }));
    at += (i < 8 ? 11 : 7) * DAY;
  }

  const findings = detectBocpdRegime(txs);
  const change = findings.find((f) => (f.evidence as any).kind === "interval");
  assert.ok(change, JSON.stringify(findings));
  const ev = change!.evidence as any;
  assert.ok(Math.abs(ev.beforeMean - 11) < 0.5);
  assert.ok(Math.abs(ev.afterMean - 7) < 0.5);
  assert.ok(ev.afterMean < ev.beforeMean);
  assert.match(change!.title, /more frequent/);
});

test("liquidity: negative drift with a stated balance emits finite ruin metrics", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const txs: LedgerTx[] = [];
  for (let i = 0; i < 30; i++) {
    txs.push(tx({
      id: `d${i}`, occurredAt: now - (29 - i) * DAY, direction: "out",
      amount: 900 + ((i * 37) % 300), counterpartyKey: "t:shop",
      balanceAfterCents: 50_000,
    }));
  }
  const findings = detectLiquidityRuin(txs, now);
  assert.equal(findings.length, 1);
  const ev = findings[0]!.evidence as any;
  assert.ok(ev.p7 > 0);
  assert.ok(ev.L > 0 && ev.L < ev.Z && ev.Z < ev.U);
  for (const k of ["L", "Z", "U", "p7", "medianDays", "p90Days", "muPerDay", "sigmaPerDay"]) {
    assert.ok(isFinite(ev[k]), `${k} should be finite`);
  }
  assert.match(findings[0]!.title, /7-day Fuliza risk/);
});

test("liquidity: no stated balance means no finding", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const txs: LedgerTx[] = Array.from({ length: 30 }, (_, i) => tx({
    id: `nb${i}`, occurredAt: now - (29 - i) * DAY, direction: "out",
    amount: 1_000, counterpartyKey: "t:shop",
  }));
  assert.deepEqual(detectLiquidityRuin(txs, now), []);
});

test("tariff: Fuliza draw just above 1000 loses the grace period", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const txs = [tx({
    id: "fuliza", occurredAt: now, direction: "in", amount: 105_000,
    kind: "loan_draw", counterpartyKey: "n:fuliza", counterpartyName: "Fuliza M-PESA",
  })];
  const findings = detectTariffCliff(txs);
  const f = findings.find((x) => (x.evidence as any).type === "fuliza_grace");
  assert.ok(f, JSON.stringify(findings));
  assert.match(f!.title, /1,000/);
  assert.match(f!.title, /grace/);
  assert.equal((f!.evidence as any).threeDayCostCents, 6_480);
});

test("tariff: split sends expose avoidable fees, merging at a lower fee is silent", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const split = [
    tx({ id: "s1", occurredAt: now, direction: "out", amount: 70_000, fee: 1_300, kind: "send", counterpartyKey: "p:254700000001" }),
    tx({ id: "s2", occurredAt: now + HOUR, direction: "out", amount: 70_000, fee: 1_300, kind: "send", counterpartyKey: "p:254700000001" }),
  ];
  const findings = detectTariffCliff(split);
  const f = findings.find((x) => (x.evidence as any).type === "split_fees");
  assert.ok(f, JSON.stringify(findings));
  assert.equal((f!.evidence as any).avoidableCents, 300);
  assert.ok((f!.evidence as any).avoidableCents > 0);

  const noGain = [
    tx({ id: "m1", occurredAt: now, direction: "out", amount: 100_000, fee: 1_300, kind: "send", counterpartyKey: "p:254700000002" }),
    tx({ id: "m2", occurredAt: now + HOUR, direction: "out", amount: 100_000, fee: 1_300, kind: "send", counterpartyKey: "p:254700000002" }),
  ];
  assert.ok(!detectTariffCliff(noGain).some((x) => (x.evidence as any).type === "split_fees"));
});

test("tariff: sending just above a send-fee tier boundary names the jump", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const txs = [tx({
    id: "boundary", occurredAt: now, direction: "out", amount: 102_000,
    kind: "send", counterpartyKey: "p:254700000003",
  })];
  const f = detectTariffCliff(txs).find((x) => (x.evidence as any).type === "send_boundary");
  assert.ok(f, JSON.stringify(detectTariffCliff(txs)));
  assert.match(f!.title, /1,020/);
  assert.match(f!.title, /1,000/);
});

test("mobility: novel locations carry higher spend and r_g is positive", () => {
  const base = Date.UTC(2026, 0, 1, 3);
  const txs: LedgerTx[] = [];
  for (let i = 0; i < 50; i++) {
    const angle = (2 * Math.PI * i) / 50;
    txs.push(tx({
      id: `r${i}`, occurredAt: base + i * HOUR, direction: "out", amount: 10_000,
      counterpartyKey: "t:routine", lat: 0.009 * Math.cos(angle), lng: 0.009 * Math.sin(angle),
    }));
  }
  for (let i = 0; i < 5; i++) {
    txs.push(tx({
      id: `n${i}`, occurredAt: base + (60 + i) * HOUR, direction: "out", amount: 30_000,
      counterpartyKey: "t:novel", lat: 0.45, lng: 0.01 * i,
    }));
  }
  const f = detectMobilityPhenotyping(txs).find((x) => typeof (x.evidence as any).rgKm === "number");
  assert.ok(f, JSON.stringify(detectMobilityPhenotyping(txs)));
  const ev = f!.evidence as any;
  assert.ok(ev.rgKm > 0);
  assert.ok(ev.multiplier > 1.3);
  assert.ok(ev.entropy > 0);
});

test("mobility: payday half-life works without locations", () => {
  const base = Date.UTC(2026, 0, 3, 7);
  const txs: LedgerTx[] = [];
  for (let i = 0; i < 10; i++) {
    txs.push(tx({
      id: `small${i}`, occurredAt: base - (10 - i) * DAY, direction: "in", amount: 10_000,
      counterpartyKey: "p:small",
    }));
  }
  let payday = base;
  for (let p = 0; p < 4; p++) {
    txs.push(tx({
      id: `pay${p}`, occurredAt: payday, direction: "in", amount: 1_000_000,
      counterpartyKey: "p:employer",
    }));
    for (let d = 0; d < 20; d++) {
      txs.push(tx({
        id: `out${p}_${d}`, occurredAt: payday + d * DAY + 10 * HOUR, direction: "out",
        amount: 30_000, counterpartyKey: "t:shop",
      }));
    }
    payday += 30 * DAY;
  }
  const findings = detectMobilityPhenotyping(txs);
  const f = findings.find((x) => typeof (x.evidence as any).medianHalfLifeDays === "number");
  assert.ok(f, JSON.stringify(findings));
  const ev = f!.evidence as any;
  assert.ok(isFinite(ev.medianHalfLifeDays));
  assert.ok(ev.medianHalfLifeDays >= 0 && ev.medianHalfLifeDays <= 30);
  assert.ok(!findings.some((x) => typeof (x.evidence as any).rgKm === "number"));
});

test("mobility: late-night outflows emit when they exceed the share floor", () => {
  const base = Date.UTC(2026, 0, 1, 20); // 23:00 EAT
  const txs: LedgerTx[] = Array.from({ length: 12 }, (_, i) => tx({
    id: `late${i}`, occurredAt: base + i * HOUR, direction: "out", amount: 20_000,
    counterpartyKey: "t:club",
  }));
  const f = detectMobilityPhenotyping(txs).find((x) => (x.evidence as any).window?.[0] === 22);
  assert.ok(f, JSON.stringify(detectMobilityPhenotyping(txs)));
  assert.ok((f!.evidence as any).share >= 0.2);
});

test("causal impact: a 100 -> 80 shift gives a negative cumulative effect with a coherent CI", () => {
  const series = [...Array(20).fill(100), ...Array(10).fill(80)];
  const r = causalImpact(series, 20);
  assert.ok(r.cumulativeEffect < 0);
  assert.ok(r.lo95 <= r.cumulativeEffect && r.cumulativeEffect <= r.hi95);
  assert.ok(r.pNegative > 0.5);
  assert.equal(r.preMean, 100);
  assert.equal(r.postMean, 80);
  assert.equal(r.n, series.length);
});

test("causal impact: too-short windows throw a friendly error", () => {
  assert.throws(() => causalImpact([1, 2, 3, 4, 5], 2), /at least 14 pre-intervention and 5 post-intervention/);
});
