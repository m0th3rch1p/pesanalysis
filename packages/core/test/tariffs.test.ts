import test from "node:test";
import assert from "node:assert/strict";
import {
  expectedFee, quoteFee, feeBoundaries, fulizaDailyFee, fulizaAccessFee, simulateFuliza, checkTariffConformance,
  tariffKindOf, DEFAULT_FULIZA_CLOCK_MODEL, TARIFF_VERSIONS, FULIZA_VERSIONS,
} from "../src/tariffs/index.js";
import { parseMpesa } from "../src/sms/parsers/mpesa.js";
import { detectTariffCliff } from "../src/detectors/tariff-cliff.js";
import { detectFeeDrag } from "../src/detectors/fee-drag.js";
import type { LedgerTx } from "../src/detectors/types.js";
import type { ParsedSms } from "../src/types.js";

const K = (kes: number) => Math.round(kes * 100);
const NOW = Date.UTC(2026, 9, 26, 9, 0); // 2026-10-26 12:00 EAT
const eat = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h - 3);

function p(parts: Partial<ParsedSms> & Pick<ParsedSms, "kind" | "amount">): ParsedSms {
  return {
    provider: "mpesa", ref: null, direction: "out", fee: null, balanceAfter: null, counterpartyName: null,
    counterpartyId: null, account: null, occurredAt: NOW, template: "t", parserVersion: "t", ...parts,
  };
}

test("send bands match the verified Safaricom table at every edge", () => {
  const cases: Array<[number, number]> = [[1, 0], [49, 0], [100, 0], [101, 7], [500, 7], [501, 13], [1000, 13], [1001, 23],
    [1500, 23], [1501, 33], [2500, 33], [2501, 53], [3500, 53], [3501, 57], [5000, 57], [5001, 78], [7500, 78], [7501, 90],
    [10000, 90], [10001, 100], [15000, 100], [15001, 105], [20000, 105], [20001, 108], [250000, 108]];
  for (const [kes, fee] of cases) assert.equal(expectedFee("send", K(kes), NOW), K(fee), `send ${kes}`);
  assert.equal(expectedFee("send", K(250001), NOW), null);
  assert.equal(expectedFee("send", 0, NOW), null);
  assert.equal(expectedFee("send", K(100.5), NOW), K(0), "fractional KES is looked up by whole KES");
});

test("agent withdraw bands replace the old max(10, 1.4%) rule", () => {
  const cases: Array<[number, number]> = [[50, 11], [100, 11], [101, 29], [2500, 29], [2501, 52], [3501, 69], [5001, 87],
    [7501, 115], [10001, 167], [15001, 185], [20000, 185], [20001, 197], [35001, 278], [50001, 309]];
  for (const [kes, fee] of cases) assert.equal(expectedFee("withdraw_agent", K(kes), NOW), K(fee), `withdraw ${kes}`);
  assert.equal(expectedFee("withdraw_agent", K(49), NOW), null, "below the KES 50 minimum there is no band");
  assert.notEqual(expectedFee("withdraw_agent", K(1000), NOW), Math.max(K(10), Math.round(K(1000) * 0.014)));
});

test("ATM, till, paybill, unregistered", () => {
  assert.equal(expectedFee("withdraw_atm", K(200), NOW), K(35));
  assert.equal(expectedFee("withdraw_atm", K(2501), NOW), K(69));
  assert.equal(expectedFee("withdraw_atm", K(10001), NOW), K(203));
  assert.equal(expectedFee("withdraw_atm", K(199), NOW), null);
  assert.equal(expectedFee("till", K(5000), NOW), 0);
  assert.equal(quoteFee("till", K(5000), NOW)!.confidence, "verified");
  assert.equal(expectedFee("paybill", K(5000), NOW), 0);
  assert.equal(quoteFee("paybill", K(5000), NOW)!.confidence, "assumed");
  assert.equal(expectedFee("send_unregistered", K(500), NOW), null, "unpublished: never guessed");
});

test("Pochi promo applies only inside its dated window", () => {
  assert.equal(expectedFee("pochi_send", K(200), NOW), 0);
  assert.equal(expectedFee("pochi_send", K(201), NOW), K(7));
  assert.equal(expectedFee("pochi_send", K(2501), NOW), K(50));
  assert.equal(expectedFee("pochi_send", K(500), eat(2026, 7, 31)), null);
  assert.equal(expectedFee("pochi_send", K(500), eat(2026, 11, 1)), null);
  assert.equal(expectedFee("pochi_send", K(500), "2026-08-01"), K(7));
});

test("dates before the snapshot's proven date are flagged extrapolated; versions carry sources", () => {
  const old = quoteFee("send", K(500), eat(2024, 1, 5))!;
  assert.equal(old.extrapolated, true);
  assert.equal(old.tariffVersion, "ke-mpesa-2026-08-04");
  assert.equal(old.estimated, true);
  assert.equal(quoteFee("send", K(500), NOW)!.extrapolated, false);
  for (const v of [...TARIFF_VERSIONS, ...FULIZA_VERSIONS]) {
    assert.ok(v.sourceUrls.length > 0 && v.retrievedAt === "2026-10-29", v.id);
  }
});

test("feeBoundaries are derived from the table (no detector constants)", () => {
  const b = feeBoundaries("send", NOW);
  assert.deepEqual(b.find((x) => x.boundaryCents === K(1000)), { boundaryCents: K(1000), feeBelowCents: K(13), feeAboveCents: K(23) });
  assert.ok(!b.some((x) => x.boundaryCents === K(20000 + 15000)), "flat 108 tail has no step");
});

test("Fuliza daily fee bands, duty included, outstanding basis", () => {
  const late = 10; // well past any free window
  assert.equal(fulizaDailyFee(K(100), late), 0);
  assert.equal(fulizaDailyFee(K(101), late), K(3));
  assert.equal(fulizaDailyFee(K(500), late), K(3));
  assert.equal(fulizaDailyFee(K(501), late), K(6));
  assert.equal(fulizaDailyFee(K(1000), late), K(6));
  assert.equal(fulizaDailyFee(K(1001), late), 2160);
  assert.equal(fulizaDailyFee(K(1500), late), 2160);
  assert.equal(fulizaDailyFee(K(1501), late), K(24));
  assert.equal(fulizaDailyFee(K(2500), late), K(24));
  assert.equal(fulizaDailyFee(K(2501), late), K(30));
  assert.equal(fulizaDailyFee(K(70000), late), K(30));
  assert.equal(fulizaDailyFee(0, late), 0);
});

test("Fuliza free window: first 3 days free only for the 101-500 and 501-1000 bands", () => {
  for (const d of [1, 2, 3]) {
    assert.equal(fulizaDailyFee(K(300), d), 0);
    assert.equal(fulizaDailyFee(K(900), d), 0);
    assert.equal(fulizaDailyFee(K(1200), d), 2160);
    assert.equal(fulizaDailyFee(K(3000), d), K(30));
  }
  assert.equal(fulizaDailyFee(K(300), 4), K(3));
  assert.equal(fulizaDailyFee(K(900), 4), K(6));
  assert.equal(fulizaDailyFee(K(300), 1, { date: "2022-09-30" }), null, "before the 2022-10-01 tariff: unknown");
});

test("Fuliza access fee is 1% of each draw", () => {
  assert.equal(fulizaAccessFee(K(500)), K(5));
  assert.equal(fulizaAccessFee(K(40)), 40);
  assert.equal(fulizaAccessFee(25976), 260);
});

test("clock model is a parameter; default is documented as unverified and conservative", () => {
  assert.equal(DEFAULT_FULIZA_CLOCK_MODEL, "per_episode");
  const events = [
    { at: eat(2026, 10, 20, 10), kind: "draw" as const, amountCents: K(500) },
    { at: eat(2026, 10, 22, 10), kind: "draw" as const, amountCents: K(300) },
  ];
  const until = eat(2026, 10, 24, 12); // charges at the midnights ending the 20th..23rd
  const episode = simulateFuliza(events, until);
  const perDraw = simulateFuliza(events, until, { clockModel: "per_draw" });
  assert.equal(episode.clockModel, "per_episode");
  assert.equal(episode.accessFeesCents, 800);
  assert.deepEqual(episode.charges.map((c) => c.dayIndex), [1, 2, 3, 4]);
  assert.equal(episode.dailyFeesCents, K(6), "4th midnight of the episode is the first charged one");
  assert.equal(perDraw.dailyFeesCents, 0, "the second draw restarts the clock: still inside the window");
  assert.equal(episode.estimated, true);
  assert.ok(episode.unverified.some((u) => /per draw or per overdrawn episode/.test(u)));
  assert.equal(episode.charges[0]!.free, true);
});

test("simulateFuliza: repayment ends the episode; fee is on the outstanding balance", () => {
  const ev = [
    { at: eat(2026, 10, 1, 10), kind: "draw" as const, amountCents: K(2000) },
    { at: eat(2026, 10, 3, 10), kind: "repay" as const, amountCents: K(2020) },
    { at: eat(2026, 10, 5, 10), kind: "draw" as const, amountCents: K(200) },
  ];
  const s = simulateFuliza(ev, eat(2026, 10, 7, 12));
  assert.equal(s.endOutstandingCents, K(202));
  // draw 2000 + 20 fee = 2020 -> KES 24/day at midnights ending Oct 1 and Oct 2; repaid on 3rd
  assert.deepEqual(s.charges.filter((c) => c.feeCents > 0).map((c) => c.feeCents), [K(24), K(24)]);
  // new episode on the 5th: restarts at index 1, free band
  assert.deepEqual(s.charges.filter((c) => c.day > "2026-10-05").map((c) => c.dayIndex), [1, 2]);
  assert.equal(s.dailyFeesCents, K(48));
});

/* ---- parser ---- */

const DRAW = "UJM1B2L Confirmed. Fuliza M-PESA amount is Ksh 500.00. Access Fee charged Ksh 5.00. Total Fuliza M-PESA outstanding amount is Ksh505.00 due on 27/10/26. To check daily charges, Dial *334# Select Query Charges";

test("parser: Fuliza access fee lands in fee; outstanding and limit still captured", () => {
  const d = parseMpesa({ sender: "MPESA", body: DRAW, receivedAt: NOW }) as ParsedSms;
  assert.equal(d.fee, 500);
  assert.equal(d.outstandingCents, 50_500);
  assert.equal(d.amount, 50_000);
  const lim = parseMpesa({
    sender: "MPESA", receivedAt: NOW,
    body: "UJM1B2M Confirmed. Fuliza M-PESA amount is Ksh 40.00. Access Fee charged Ksh 0.40. Total Fuliza M-PESA outstanding amount is Ksh40.40 due on 27/10/26. Your available Fuliza M-PESA limit is Ksh 260.00.",
  }) as ParsedSms;
  assert.equal(lim.fee, 40);
  assert.equal(lim.availableCreditCents, 26_000);
});

test("parser: draw without a stated access fee keeps fee null; repay unaffected", () => {
  const d = parseMpesa({ sender: "MPESA", receivedAt: NOW, body: "UJM1B2N Confirmed. Fuliza M-PESA amount is Ksh 50.00." }) as ParsedSms;
  assert.equal(d.kind, "loan_draw");
  assert.equal(d.fee, null);
  const r = parseMpesa({ sender: "MPESA", receivedAt: NOW,
    body: "UJM1B3G Confirmed. Ksh 500.00 from your M-PESA has been used to fully pay your outstanding Fuliza M-PESA. Available Fuliza M-PESA limit is Ksh 1,500.00. Your M-PESA balance is Ksh 200.00." }) as ParsedSms;
  assert.equal(r.fee, null);
  assert.equal(r.balanceAfter, 20_000);
});

/* ---- conformance ---- */

const SEND = (amt: string, cost: string) =>
  `TJ1234567A Confirmed. Ksh${amt} sent to JANE DOE 0700000001 on 26/10/26 at 3:00 PM. New M-PESA balance is Ksh1,000.00. Transaction cost, Ksh${cost}.`;
const WD = (amt: string, cost: string) =>
  `TJ1234567B Confirmed. You have withdrawn Ksh${amt} from Agent 123456 on 26/10/26 at 3:00 PM. New M-PESA balance is Ksh1,000.00. Transaction cost, Ksh${cost}.`;

test("conformance: matching fees pass; the old 1.4% withdraw fee is reported as a mismatch", () => {
  const msgs = [SEND("500.00", "7.00"), SEND("1,500.00", "23.00"), WD("1,000.00", "29.00"), WD("1,000.00", "14.00"), SEND("100.00", "7.00")]
    .map((b) => parseMpesa({ sender: "MPESA", body: b, receivedAt: NOW }) as ParsedSms);
  const rep = checkTariffConformance(msgs);
  assert.equal(rep.checked, 5);
  assert.equal(rep.matched, 3);
  assert.equal(rep.mismatched, 2);
  assert.equal(rep.mismatchRate, 0.4);
  assert.deepEqual(rep.mismatches.map((m) => [m.kind, m.statedFeeCents, m.expectedFeeCents]), [["withdraw_agent", 1400, 2900], ["send", 700, 0]]);
  assert.equal(rep.byKind.send!.checked, 3);
});

test("conformance: no stated fee, unmodelled kinds and unknown tariffs are skipped, not failed", () => {
  const rep = checkTariffConformance([
    p({ kind: "send", amount: K(500), fee: null }),
    p({ kind: "receive", amount: K(500), fee: 0 }),
    p({ kind: "send", amount: K(500), fee: 700, template: "mpesa.pochi.send", occurredAt: eat(2025, 1, 1) }), // no Pochi table then
    p({ kind: "withdraw", amount: K(1000), fee: K(35), counterpartyName: "ATM" }),
  ]);
  assert.equal(rep.skipped, 3);
  assert.equal(rep.checked, 1);
  assert.equal(rep.mismatched, 0, "ATM 1000 = 35 matches");
  assert.equal(tariffKindOf({ kind: "withdraw", template: "x", counterpartyName: "ATM" }), "withdraw_atm");
});

/* ---- detectors ---- */

function tx(o: Partial<LedgerTx> & Pick<LedgerTx, "id" | "occurredAt" | "direction" | "amount">): LedgerTx {
  return { counterpartyKey: null, ...o };
}

test("tariff_cliff: Fuliza just over 1500 is a dearer band (21.60 -> 24), not a lost grace", () => {
  const f = detectTariffCliff([tx({ id: "d", occurredAt: NOW, direction: "in", amount: K(1520), kind: "loan_draw", counterpartyName: "Fuliza M-PESA" })])
    .find((x) => (x.evidence as any).type === "fuliza_grace");
  assert.ok(f);
  const ev = f.evidence as any;
  assert.equal(ev.losesGrace, false);
  assert.equal(ev.threeDayCostCents, K(72));
  assert.equal(ev.costAtBoundaryCents, 6480);
  assert.equal(ev.tariffVersion, "ke-fuliza-2022-10-01");
  assert.equal(ev.estimated, true);
});

test("tariff_cliff: draws just over 100 or 500 stay silent (free window absorbs the step)", () => {
  for (const kes of [102, 510]) {
    const f = detectTariffCliff([tx({ id: "d", occurredAt: NOW, direction: "in", amount: K(kes), kind: "loan_draw", counterpartyName: "Fuliza M-PESA" })]);
    assert.equal(f.length, 0, `draw ${kes}`);
  }
});

test("tariff_cliff: withdrawal splits are priced from the withdraw table", () => {
  const mk = (id: string, at: number) => tx({ id, occurredAt: at, direction: "out", amount: K(1000), fee: K(29), kind: "withdraw", counterpartyKey: "a:123456", counterpartyName: "Agent" });
  const f = detectTariffCliff([mk("w1", NOW), mk("w2", NOW + 3_600_000)]).find((x) => (x.evidence as any).type === "split_fees");
  assert.ok(f);
  assert.equal((f.evidence as any).individualFeesCents, K(58));
  assert.equal((f.evidence as any).combinedFeeCents, K(29)); // 2000 sits in the same 1501-2500 band
  assert.equal((f.evidence as any).avoidableCents, K(29));
});

test("tariff_cliff: unknown tariff means silence, not a guess", () => {
  const mk = (id: string, at: number) => tx({ id, occurredAt: at, direction: "out", amount: K(30), kind: "withdraw", counterpartyKey: "a:1", counterpartyName: "Agent" });
  assert.ok(!detectTariffCliff([mk("a", NOW), mk("b", NOW + 1000)]).some((x) => (x.evidence as any).type === "split_fees"));
});

test("fee_drag counts the stated Fuliza access fee and says daily fees are excluded", () => {
  const now = Date.now();
  const txs: LedgerTx[] = [
    ...Array.from({ length: 5 }, (_, i) => tx({ id: `s${i}`, occurredAt: now - i * 3_600_000, direction: "out", amount: K(500), kind: "send", fee: K(7), counterpartyKey: "p:1" })),
    tx({ id: "dr", occurredAt: now - 1000, direction: "in", amount: K(500), kind: "loan_draw", fee: K(5), provider: "mpesa" }),
    tx({ id: "dr2", occurredAt: now - 2000, direction: "in", amount: K(50), kind: "loan_draw", provider: "mpesa" }),
  ];
  const [f] = detectFeeDrag(txs, { days: 30 });
  assert.ok(f);
  const ev = f.evidence as any;
  assert.equal(ev.totalFeesCents, K(35) + K(5));
  assert.equal(ev.fulizaAccessFeesCents, K(5));
  assert.equal(ev.fulizaDrawsWithoutStatedFee, 1);
  assert.equal(ev.includesFulizaDailyFees, false);
  assert.equal(ev.byKind.loan_draw, K(5));
});
