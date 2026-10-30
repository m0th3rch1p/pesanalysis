import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  debtSummary, exploreCategories, exploreCounterparties, explorePlaces, exploreSummary, exploreTransactions,
  financeReport, fulizaState, wrapped, wrappedAccess,
  type ExploreBucket, type ExploreFilters, type ExplorePeriod, type ExplorePlace, type ExploreTx,
  type ComparisonMode, type FinanceKpi, type FinanceReport, type WrappedAccess, type WrappedResult,
} from "@yako/core";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { Chart, GroupedBarChart, ScatterChart, WaterfallChart, BulletChart, shortKes } from "../components/Charts";
const PlacesMap = lazy(async () => ({ default: (await import("../components/PlacesMap")).PlacesMap }));
import { Btn, C, Card, Empty, Pill, Screen, SectionTitle, kes, text } from "../ui";

type Mode = "overview" | "deep" | "map" | "wrapped";
type Direction = "all" | "in" | "out";

const PERIODS: Array<[ExplorePeriod, string]> = [
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["this_year", "This year"],
  ["all", "All time"],
];

function numInput(s: string): number | undefined {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
}

function Seg({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const items: Array<[Mode, string]> = [["overview", "Brief"], ["deep", "Deep dive"], ["map", "Places"], ["wrapped", "Wrapped"]];
  return (
    <View style={{ flexDirection: "row", backgroundColor: C.card2, borderRadius: 14, padding: 4, marginTop: 14 }}>
      {items.map(([id, label]) => (
        <TouchableOpacity key={id} onPress={() => onChange(id)} activeOpacity={0.8}
          style={{ flex: 1, borderRadius: 11, paddingVertical: 8, backgroundColor: value === id ? C.blue : "transparent", alignItems: "center" }}>
          <Text style={text(11, value === id ? "#fff" : C.muted, "600")}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function Summary({ s }: { s: ReturnType<typeof exploreSummary> }) {
  return (
    <Card style={{ marginTop: 12 }}>
      <Text style={text(10, C.muted, "700")}>MONEY THIS PERIOD</Text>
      <Text style={[text(34, s.netCents >= 0 ? C.green : C.red, "700"), { marginTop: 5 }]}>
        {s.netCents >= 0 ? "+" : "−"}{kes(Math.abs(s.netCents))}
      </Text>
      <Text style={text(11, C.dim)}>{s.netCents >= 0 ? "left after spending and fees" : "more went out than came in"}</Text>
      {s.hiddenFeeCents > 0 && (
        <Text style={[text(10, C.amber), { marginTop: 10 }]}>
          {kes(s.hiddenFeeCents)} of airtime value was withheld inside purchases; it is already inside OUT, not double-counted.
        </Text>
      )}
      <View style={{ flexDirection: "row", marginTop: 16, gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={text(10, C.dim)}>IN</Text>
          <Text style={[text(15, C.green, "700"), { marginTop: 2 }]}>{kes(s.incomeCents)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={text(10, C.dim)}>OUT</Text>
          <Text style={[text(15, C.red, "700"), { marginTop: 2 }]}>{kes(s.spendCents)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={text(10, C.dim)}>FEES</Text>
          <Text style={[text(15, C.text, "700"), { marginTop: 2 }]}>{kes(s.feeCents)}</Text>
        </View>
      </View>
      <Text style={[text(10, C.dim), { marginTop: 12 }]}>{s.count} payment{s.count === 1 ? "" : "s"} · {s.range.label}</Text>
    </Card>
  );
}

function BucketBars({ title, rows, empty, showShare }: { title: string; rows: ExploreBucket[]; empty: string; showShare?: boolean }) {
  if (!rows.length) return <Card style={{ marginTop: 10 }}><Text style={text(13, C.muted)}>{empty}</Text></Card>;
  const total = rows.reduce((s, r) => s + r.totalCents, 0) || 1;
  const max = Math.max(1, ...rows.map((r) => r.totalCents));
  return (
    <Card style={{ marginTop: 10 }}>
      <Text style={text(13, C.text, "700")}>{title}</Text>
      {rows.map((r) => (
        <View key={r.name} style={{ marginTop: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <Text style={[text(12, C.text), { flex: 1 }]} numberOfLines={1}>{r.name}</Text>
            <Text style={text(11, C.muted, "600")}>{kes(r.totalCents)}{showShare ? ` · ${Math.round((r.totalCents / total) * 100)}%` : ""}</Text>
          </View>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: C.line, marginTop: 5, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, (r.totalCents / max) * 100)}%`, height: 5, borderRadius: 3, backgroundColor: C.blue }} />
          </View>
          <Text style={[text(9, C.dim), { marginTop: 2 }]}>{r.count} payment{r.count === 1 ? "" : "s"}</Text>
        </View>
      ))}
    </Card>
  );
}

function pctText(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(1)}%`;
}

function ptsText(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(1)} pts`;
}

function deltaColor(kind: "up" | "down" | "none", delta: number | null | undefined): string {
  if (delta == null || delta === 0 || kind === "none") return C.muted;
  const good = kind === "up" ? delta > 0 : delta < 0;
  return good ? C.green : C.red;
}

function valueOf(k: FinanceKpi): string {
  if (k.id === "savings") return k.valuePct == null ? "—" : `${Math.round(k.valuePct * 100)}%`;
  if (k.id === "runway") return k.valueMonths == null ? "—" : `${k.valueMonths.toFixed(1)} mo`;
  if (k.id === "fee") return k.valueCents == null ? "—" : `KES ${(k.valueCents / 100).toFixed(2)}`;
  if (k.valueCents == null) return "—";
  return `${k.valueCents < 0 ? "−" : ""}${kes(Math.abs(k.valueCents))}`;
}

function KpiCard({ k }: { k: FinanceKpi }) {
  const delta = k.deltaPct != null ? pctText(k.deltaPct) : k.deltaPts != null ? ptsText(k.deltaPts) : null;
  const tone = k.deltaPct != null ? deltaColor(k.goodWhen, k.deltaPct) : deltaColor(k.goodWhen, k.deltaPts);
  return (
    <Card style={{ width: "48%", flexGrow: 1, minWidth: 145, padding: 13, marginBottom: 0 }}>
      <Text style={text(9, C.dim, "700")}>{k.label.toUpperCase()}</Text>
      <Text style={[text(21, C.text, "700"), { marginTop: 5 }]} numberOfLines={1}>{valueOf(k)}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 }}>
        {delta && <Text style={text(10, tone, "700")}>{delta}</Text>}
        <Text style={[text(9, C.dim), { flex: 1 }]} numberOfLines={2}>{k.note}</Text>
      </View>
      <Text style={[text(8, C.dim), { marginTop: 5, lineHeight: 11 }]}>{k.formula}</Text>
    </Card>
  );
}

function DeltaTable({ f }: { f: FinanceReport }) {
  return (
    <View style={{ marginTop: 12 }}>
      <View style={{ flexDirection: "row", paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <Text style={[text(9, C.dim, "700"), { flex: 1.2 }]}>LINE</Text>
        <Text style={[text(9, C.dim, "700"), { flex: 1, textAlign: "right" }]}>NOW</Text>
        <Text style={[text(9, C.dim, "700"), { flex: 1, textAlign: "right" }]}>PRIOR</Text>
        <Text style={[text(9, C.dim, "700"), { flex: 1, textAlign: "right" }]}>CHANGE</Text>
      </View>
      {f.deltas.map((d) => (
        <View key={d.id} style={{ flexDirection: "row", paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: "#1B1B24" }}>
          <Text style={[text(11, C.text), { flex: 1.2 }]}>{d.label}</Text>
          <Text style={[text(11, d.currentCents < 0 ? C.red : C.text, "600"), { flex: 1, textAlign: "right" }]}>{kes(d.currentCents)}</Text>
          <Text style={[text(11, C.muted), { flex: 1, textAlign: "right" }]}>{d.priorCents == null ? "—" : kes(d.priorCents)}</Text>
          <Text style={[text(11, deltaColor(d.goodWhen, d.pct), "600"), { flex: 1, textAlign: "right" }]}>{pctText(d.pct)}</Text>
        </View>
      ))}
    </View>
  );
}

function CategoryRows({ f }: { f: FinanceReport }) {
  if (!f.categories.length) return <Card style={{ marginTop: 10 }}><Text style={text(13, C.muted)}>No outflows in this segment.</Text></Card>;
  return (
    <Card style={{ marginTop: 10 }}>
      <Text style={text(13, C.text, "700")}>Where outflows went</Text>
      {f.categories.map((c) => (
        <View key={c.name} style={{ marginTop: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <Text style={[text(12, C.text), { flex: 1 }]} numberOfLines={1}>{c.name}</Text>
            <Text style={text(11, C.muted, "600")}>{kes(c.currentCents)} · {Math.round(c.share * 100)}%</Text>
          </View>
          <View style={{ height: 5, backgroundColor: C.line, borderRadius: 3, marginTop: 5, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, c.share * 100)}%`, height: 5, borderRadius: 3, backgroundColor: C.blue }} />
          </View>
          <Text style={[text(9, C.dim), { marginTop: 2 }]}>{c.count} payment{c.count === 1 ? "" : "s"}{c.priorCents != null ? ` · prior ${kes(c.priorCents)}` : ""}</Text>
        </View>
      ))}
    </Card>
  );
}

function DeepDive({ f, onShare, comparisonMode, onComparisonChange }: {
  f: FinanceReport; onShare: () => void;
  comparisonMode: ComparisonMode; onComparisonChange: (m: ComparisonMode) => void;
}) {
  if (f.current.count === 0) {
    return <Empty title="Nothing to analyse yet" body="Add payments or change the period. Every number in this report comes from your own messages." />;
  }
  const inFlow = Math.max(1, f.current.incomeCents);
  const spendShare = f.current.spendCents / inFlow;
  const feeShare = f.current.feeCents / inFlow;
  const keptShare = f.current.netCents / inFlow;
  const negativeMonths = f.monthly.filter((m) => m.netCents < 0).length;
  const topCategory = f.categories[0];
  const smallBand = f.feeBands[0]!;
  const largeBand = f.feeBands[2]!;
  const topPayer = f.risk.topIncomeShare;
  const topVenture = f.ventures.slice().sort((a, b) => b.netCents - a.netCents)[0];
  const comparison = f.comparison.priorLabel ? `vs ${f.comparison.priorLabel}` : "no prior window";
  const spendLine = f.current.incomeCents <= 0
    ? "No money in during this segment; every flow shown is an outflow."
    : f.current.spendCents > 0
      ? `Of every KES 1,000 that came in, ${Math.round(spendShare * 1000)} went out and ${Math.round(feeShare * 1000)} went to fees.`
      : "No outflows in this segment.";
  return (
    <View>
      <Card style={{ marginTop: 12, backgroundColor: "#111B33", borderColor: "#20345C" }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={text(9, C.blue, "700")}>MANAGEMENT REPORT</Text>
          <View style={{ flex: 1 }} />
          <Text style={text(9, C.dim)}>{f.comparison.current.label}</Text>
        </View>
        <Text style={[text(24, C.text, "700"), { marginTop: 9, lineHeight: 31 }]}>{f.headline}</Text>
        <Text style={[text(11, C.muted), { marginTop: 6, lineHeight: 17 }]}>{f.subhead}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          <Pill label={comparison} tone={f.prior ? "blue" : "dim"} />
          <TouchableOpacity onPress={() => onComparisonChange("like_for_like")} activeOpacity={0.8}>
            <Pill label={comparisonMode === "like_for_like" ? "✓ like-for-like days" : "like-for-like days"} tone={comparisonMode === "like_for_like" ? "blue" : "dim"} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onComparisonChange("full")} activeOpacity={0.8}>
            <Pill label={comparisonMode === "full" ? "✓ full periods" : "full periods"} tone={comparisonMode === "full" ? "blue" : "dim"} />
          </TouchableOpacity>
        </View>
        <Text style={[text(9, C.dim), { marginTop: 6, lineHeight: 14 }]}>
          Like-for-like stops the prior window at the same elapsed day. Full periods compare the complete previous month/year. The toggle is live; the table recomputes.
        </Text>
      </Card>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 10 }}>
        {f.kpis.map((k) => <KpiCard key={k.id} k={k} />)}
      </View>

      <SectionTitle right={<Text style={text(9, C.dim)}>current vs prior</Text>}>HORIZONTAL ANALYSIS</SectionTitle>
      <Card>
        <Text style={[text(12, C.text, "700")]}>{f.headline}</Text>
        <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>
          Compare the same lines over two aligned windows. For an incomplete month, the prior window stops at the same elapsed point.
        </Text>
        <View style={{ marginTop: 8 }}>
          <GroupedBarChart
            data={f.deltas.filter((d) => d.id === "income" || d.id === "spend").map((d) => ({
              label: d.id === "income" ? "In" : "Out", current: d.currentCents, prior: d.priorCents,
            }))}
            currentLabel="this period" priorLabel="prior"
          />
        </View>
        <View style={{ flexDirection: "row", gap: 14, marginTop: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: C.blue }} />
            <Text style={text(9, C.muted)}>This period</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: C.dim }} />
            <Text style={text(9, C.muted)}>Prior</Text>
          </View>
          <Text style={[text(9, C.dim), { flex: 1, textAlign: "right" }]}>fees stay in the table</Text>
        </View>
        <DeltaTable f={f} />
        <Text style={[text(9, C.dim), { marginTop: 8, lineHeight: 14 }]}>
          A blank prior means there were no transactions in that window. Percent change is not calculated on a zero or negative base.
        </Text>
      </Card>

      <SectionTitle>VERTICAL ANALYSIS</SectionTitle>
      <Card>
        <Text style={[text(12, C.text, "700")]}>{spendLine}</Text>
        <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>Every flow as a share of money in — not a comparison to an invented external benchmark.</Text>
        <View style={{ marginTop: 8 }}>
          <WaterfallChart data={[
            { label: "In", value: f.current.incomeCents, kind: "total" },
            { label: "Fees", value: -f.current.feeCents, kind: f.current.feeCents ? "negative" : "total" },
            { label: "Spend", value: -f.current.spendCents, kind: f.current.spendCents ? "negative" : "total" },
            { label: "Kept", value: f.current.netCents, kind: "total" },
          ]} />
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          {[
            ["OUT", `${Math.round(spendShare * 1000)} / 1,000`, C.red],
            ["FEES", `${Math.round(feeShare * 1000)} / 1,000`, C.amber],
            ["KEPT", `${Math.round(keptShare * 1000)} / 1,000`, keptShare >= 0 ? C.green : C.red],
          ].map(([label, value, color]) => (
            <View key={label} style={{ flex: 1 }}>
              <Text style={text(8, C.dim)}>{label}</Text>
              <Text style={[text(11, color, "700"), { marginTop: 2 }]}>{value}</Text>
            </View>
          ))}
        </View>
      </Card>
      <CategoryRows f={f} />

      <SectionTitle right={<Text style={text(9, C.dim)}>{f.scatter.length} payments</Text>}>UNIT ECONOMICS</SectionTitle>
      <Card>
        <Text style={[text(12, C.text, "700")]}>
          {smallBand.count > 0 && largeBand.count > 0 && smallBand.rate != null && largeBand.rate != null
            ? `Small payments cost ${(smallBand.rate * 100).toFixed(1)}% in fees; KES 1,000+ payments cost ${(largeBand.rate * 100).toFixed(2)}%.`
            : `Average payment ${kes(f.current.avgOutCents)}; median ${kes(f.current.medianOutCents)}.`}
        </Text>
        <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>
          Each dot is one outflow: amount on the horizontal axis, fee on the vertical. The gap between small and large tickets is the unit-cost story.
        </Text>
        <View style={{ marginTop: 8 }}>
          <ScatterChart points={f.scatter.map((p) => ({ x: p.amountCents, y: p.feeCents, label: p.name ?? p.kind }))} xLabel="payment" yLabel="fee" />
        </View>
        <View style={{ marginTop: 10 }}>
          {f.feeBands.map((b) => (
            <View key={b.label} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 5, borderTopWidth: 1, borderTopColor: "#1B1B24" }}>
              <Text style={[text(10, C.muted), { flex: 1 }]}>{b.label}</Text>
              <Text style={[text(10, C.text, "600"), { width: 68, textAlign: "right" }]}>{b.count} payments</Text>
              <Text style={[text(10, b.rate != null && b.rate > 0.01 ? C.amber : C.dim), { width: 70, textAlign: "right" }]}>{b.rate == null ? "—" : `${(b.rate * 100).toFixed(2)}%`}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          {[
            ["AVG TICKET", kes(f.current.avgOutCents)],
            ["MEDIAN", kes(f.current.medianOutCents)],
            ["PER ACTIVE DAY", `${f.current.activeDays ? (f.current.outCount / f.current.activeDays).toFixed(1) : "—"} out`],
            ["FEE / PAYMENT", kes(f.current.avgFeeCents)],
          ].map(([label, value]) => (
            <View key={label} style={{ flex: 1 }}>
              <Text style={text(8, C.dim)}>{label}</Text>
              <Text style={[text(10, C.text, "600"), { marginTop: 2 }]}>{value}</Text>
            </View>
          ))}
        </View>
      </Card>

      <SectionTitle right={<Text style={text(9, C.dim)}>trailing {f.monthly.length} months</Text>}>TREND</SectionTitle>
      <Card>
        <Text style={[text(12, C.text, "700")]}>
          {negativeMonths === 0
            ? "Every month in the window retained cash."
            : negativeMonths >= Math.ceil(f.monthly.length / 2)
              ? `Net cash was negative in ${negativeMonths} of ${f.monthly.length} months.`
              : `Net cash was negative in ${negativeMonths} of ${f.monthly.length} months — the trend is not one bad day.`}
        </Text>
        <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>Monthly free cash flow. The point is direction, not a forecast.</Text>
        <View style={{ marginTop: 8 }}>
          <Chart spec={{
            kind: "line", title: "Monthly free cash flow", unit: "KES",
            series: [{ key: "net", label: "Net", color: C.blue, points: f.monthly.map((m) => ({ x: m.label, y: m.netCents })) }],
          }} />
        </View>
      </Card>

      <SectionTitle>LIQUIDITY, CONCENTRATION & FULIZA</SectionTitle>
      <Card>
        <Text style={[text(12, C.text, "700")]}>
          {topPayer == null ? "No inflows yet." : topPayer >= 0.5 ? `One payer supplies ${Math.round(topPayer * 100)}% of inflows.` : `Income is spread: the largest payer supplies ${Math.round(topPayer * 100)}%.`}
        </Text>
        <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>Concentration is a resilience check, not a judgement about the people behind it.</Text>
        {f.liquidity.runwayMonths != null && (
          <BulletChart value={Math.min(f.liquidity.runwayMonths, 12)} max={12} target={3} label="Runway (months of outflows)" valueText={`${f.liquidity.runwayMonths.toFixed(1)} mo`} />
        )}
        <View style={{ marginTop: 10 }}>
          {[
            ["Liquid balances", f.liquidity.liquidCents == null ? "No stated balance" : kes(f.liquidity.liquidCents)],
            ["Average monthly outflow", f.liquidity.monthlyBurnCents == null ? "—" : kes(f.liquidity.monthlyBurnCents)],
            ["Income HHI", f.risk.incomeHhi == null ? "—" : f.risk.incomeHhi.toFixed(2)],
            ["Top 5 spend share", f.risk.topSpendShare == null ? "—" : `${Math.round(f.risk.topSpendShare * 100)}%`],
            ["Largest single expense", f.risk.largestExpenseShare == null ? "—" : `${Math.round(f.risk.largestExpenseShare * 100)}% of outflows`],
            ["Income volatility", f.risk.incomeVolatility == null ? "Not enough months" : `${Math.round(f.risk.incomeVolatility * 100)}% CV`],
            ["Fuliza draws", f.risk.fulizaDraws ? `${f.risk.fulizaDraws} · ${kes(f.risk.fulizaDrawCents)}` : "None in period"],
            ["Fuliza / income", f.risk.fulizaShare == null ? "—" : `${Math.round(f.risk.fulizaShare * 100)}%`],
          ].map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", paddingVertical: 5, borderTopWidth: 1, borderTopColor: "#1B1B24" }}>
              <Text style={[text(10, C.muted), { flex: 1 }]}>{label}</Text>
              <Text style={[text(10, C.text, "600"), { textAlign: "right" }]}>{value}</Text>
            </View>
          ))}
        </View>
        <Text style={[text(9, C.dim), { marginTop: 7, lineHeight: 14 }]}>{f.liquidity.method}</Text>
      </Card>

      {f.ventures.length > 0 && (
        <>
          <SectionTitle right={<Text style={text(9, C.dim)}>tagged ventures</Text>}>VENTURE ECONOMICS</SectionTitle>
          <Card>
            <Text style={[text(12, C.text, "700")]}>
              {topVenture ? `${topVenture.name}: ${topVenture.netCents >= 0 ? "positive" : "negative"} contribution of ${kes(topVenture.netCents)}.` : "No venture activity."}
            </Text>
            <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>Only transactions tagged to a venture. Untagged business spending is not assigned by guesswork.</Text>
            {f.ventures.map((v) => (
              <View key={v.name} style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }}>
                <View style={{ flexDirection: "row" }}>
                  <Text style={[text(12, C.text, "600"), { flex: 1 }]}>{v.name}</Text>
                  <Text style={[text(11, v.netCents >= 0 ? C.green : C.red, "700")]}>{kes(v.netCents)}</Text>
                </View>
                <Text style={[text(9, C.dim), { marginTop: 2 }]}>
                  {v.count} payments · in {kes(v.incomeCents)} · out {kes(v.expenseCents)} · fees {kes(v.feeCents)}{v.margin != null ? ` · margin ${Math.round(v.margin * 100)}%` : ""}
                </Text>
              </View>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>METHOD & RECONCILIATION</SectionTitle>
      <Card>
        <Text style={[text(11, C.text, "600")]}>Free cash flow = money in − money out − fees</Text>
        <Text style={[text(10, C.muted), { marginTop: 5 }]}>{kes(f.current.incomeCents)} − {kes(f.current.spendCents)} − {kes(f.current.feeCents)} = <Text style={text(10, f.current.netCents >= 0 ? C.green : C.red, "700")}>{kes(f.current.netCents)}</Text></Text>
        <Text style={[text(11, C.text, "600"), { marginTop: 10 }]}>Savings rate = free cash flow ÷ money in</Text>
        <Text style={[text(10, C.muted), { marginTop: 5 }]}>{f.current.savingsRate == null ? "No inflows in this segment." : `${kes(f.current.netCents)} ÷ ${kes(f.current.incomeCents)} = ${(f.current.savingsRate * 100).toFixed(1)}%`}</Text>
        <View style={{ height: 1, backgroundColor: C.line, marginVertical: 10 }} />
        {f.current.hiddenFeeCents > 0 && (
          <Text style={[text(9, C.amber, "600"), { lineHeight: 14, marginBottom: 5 }]}>
            • Airtime value withheld inside purchases: {kes(f.current.hiddenFeeCents)}. It is part of money out, not an extra fee.
          </Text>
        )}
        {f.method.map((m) => <Text key={m} style={[text(9, C.dim), { lineHeight: 14, marginBottom: 5 }]}>• {m}</Text>)}
        <Text style={[text(9, C.dim), { lineHeight: 14, marginTop: 4 }]}>
          These are management measures adapted for a phone ledger, not GAAP/IFRS financial statements. There is no audit, no accrual, no tax calculation and no external benchmark. “Runway” assumes the trailing 90-day outflow repeats.
        </Text>
      </Card>

      <Btn label="Share this report" kind="soft" onPress={onShare} style={{ marginTop: 12 }} />
    </View>
  );
}

function dateLabel(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms + 3 * 3_600_000);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function WrappedLock({ access, cadence }: { access: WrappedAccess; cadence: "month" | "year" }) {
  const title = cadence === "month" ? "Monthly Wrapped" : "Yearly Wrapped";
  const body = access.reason === "no_data"
    ? "Wrapped needs a little history first. Add payments, or seed the demo ledger, then come back."
    : `Unlocks ${dateLabel(access.unlockAt)} — after ${cadence === "month" ? "one full calendar month" : "twelve months"} of recorded money.`;
  return (
    <Card style={{ marginTop: 12, borderColor: "#3A2E12", backgroundColor: "#17130A" }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={text(10, C.amber, "700")}>LOCKED</Text>
        <View style={{ flex: 1 }} />
        <Text style={text(9, C.dim)}>{Math.round(access.progress * 100)}%</Text>
      </View>
      <Text style={[text(22, C.text, "700"), { marginTop: 8 }]}>{title}</Text>
      <Text style={[text(11, C.muted), { marginTop: 5, lineHeight: 17 }]}>{body}</Text>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: "#2A2314", marginTop: 14, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(2, access.progress * 100)}%`, height: 5, borderRadius: 3, backgroundColor: C.amber }} />
      </View>
      <Text style={[text(9, C.dim), { marginTop: 7 }]}>
        {access.firstAt == null ? "No recorded history yet." : `History starts ${dateLabel(access.firstAt)}.`}
      </Text>
    </Card>
  );
}

function WrappedCard({ w }: { w: WrappedResult }) {
  const title = w.range.period === "this_year" ? "Your year so far" : w.range.period === "last_month" ? "Last month, wrapped" : "This month, wrapped";
  return (
    <View>
      <Card style={{ marginTop: 12, backgroundColor: "#111B33", borderColor: "#20345C" }}>
        <Text style={text(10, C.blue, "700")}>PESANALYSIS WRAPPED</Text>
        <Text style={[text(26, C.text, "700"), { marginTop: 8, lineHeight: 33 }]}>{title}</Text>
        <Text style={[text(12, C.muted), { marginTop: 5, lineHeight: 18 }]}>
          {w.summary.count} payments across {w.activeDays} day{w.activeDays === 1 ? "" : "s"}. Here is what your money did.
        </Text>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
          <View style={{ flex: 1, backgroundColor: "#0B1428", borderRadius: 14, padding: 12 }}>
            <Text style={text(9, C.dim)}>MONEY IN</Text>
            <Text style={[text(16, C.green, "700"), { marginTop: 3 }]}>{shortKes(w.summary.incomeCents)}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#0B1428", borderRadius: 14, padding: 12 }}>
            <Text style={text(9, C.dim)}>MONEY OUT</Text>
            <Text style={[text(16, C.red, "700"), { marginTop: 3 }]}>{shortKes(w.summary.spendCents)}</Text>
          </View>
        </View>
      </Card>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        {w.highlights.map((h) => (
          <Card key={h.label} style={{ width: "48%", flexGrow: 1, minWidth: 145, marginBottom: 0 }}>
            <Text style={text(9, C.dim, "700")}>{h.label.toUpperCase()}</Text>
            <Text style={[text(17, C.text, "700"), { marginTop: 5 }]} numberOfLines={2}>{h.value}</Text>
            <Text style={[text(10, C.muted), { marginTop: 4, lineHeight: 15 }]}>{h.detail}</Text>
          </Card>
        ))}
      </View>

      {w.places.count > 0 && (
        <Card style={{ marginTop: 10 }}>
          <Text style={text(13, C.text, "700")}>Where it happened</Text>
          {w.places.top.map((p) => (
            <View key={p.key} style={{ marginTop: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={[text(12, C.text, "600"), { flex: 1, flexShrink: 1 }]} numberOfLines={1}>{p.label ? `Usually ${p.label}` : `Near ${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`}</Text>
                <Text style={text(12, C.muted)}>{p.count} payment{p.count === 1 ? "" : "s"}</Text>
              </View>
              <Text style={[text(11, C.muted), { marginTop: 2 }]}>{kes(p.spendCents)} spent{p.incomeCents > 0 ? ` · ${kes(p.incomeCents)} received` : ""} · {p.lat.toFixed(3)}, {p.lng.toFixed(3)}</Text>
            </View>
          ))}
          <Text style={[text(10, C.dim), { marginTop: 10, lineHeight: 15 }]}>
            {w.places.locatedTx} of {w.summary.count} payments carried a recent location fix
            {w.places.locatedShare != null ? ` (${Math.round(w.places.locatedShare * 100)}%)` : ""}. Places are coarse ~110 m clusters computed on this phone; no map provider is called. Older messages cannot be placed retroactively.
          </Text>
        </Card>
      )}

      <Card style={{ marginTop: 10 }}>
        <Text style={text(13, C.text, "700")}>Days worth knowing</Text>
        {w.busiestDay && <Text style={[text(12, C.muted), { marginTop: 8 }]}>Busiest day: <Text style={text(12, C.text, "600")}>{w.busiestDay.day}</Text> · {w.busiestDay.count} payments</Text>}
        {w.biggestDay && <Text style={[text(12, C.muted), { marginTop: 5 }]}>Largest spending day: <Text style={text(12, C.text, "600")}>{w.biggestDay.day}</Text> · {kes(w.biggestDay.cents)}</Text>}
        {w.fulizaDraws > 0 && <Text style={[text(12, C.muted), { marginTop: 5 }]}>Fuliza used: <Text style={text(12, C.amber, "600")}>{w.fulizaDraws} time{w.fulizaDraws === 1 ? "" : "s"}</Text> · {kes(w.fulizaDrawCents)}</Text>}
        {w.offRadarCents > 0 && <Text style={[text(12, C.muted), { marginTop: 5 }]}>Moved outside SMS view: <Text style={text(12, C.text, "600")}>{kes(w.offRadarCents)}</Text></Text>}
      </Card>

      <Btn label="Share this summary" kind="soft" onPress={() => {
        const lines = [`Pesanalysis — ${title}`, ...w.highlights.map((h) => `${h.label}: ${h.value} (${h.detail})`)];
        if (w.places.count > 0) lines.push(`Places: ${w.places.top.map((p) => `${p.label ?? p.key} (${p.count})`).join(", ")}`);
        void Share.share({ title: "My Pesanalysis wrapped", message: lines.join("\n") });
      }} style={{ marginTop: 12 }} />
      <Text style={[text(10, C.dim), { textAlign: "center", marginTop: 12, lineHeight: 15 }]}>
        This is a mirror, not a judgement. Every number came from your own messages.
      </Text>
    </View>
  );
}

export function AnalyseScreen({ refreshKey, onMore }: { refreshKey: number; onMore: () => void }) {
  const db = getLedger().db;
  const a = useMemo(() => asDbAdapter(db), [db]);
  const [mode, setMode] = useState<Mode>("overview");
  const [period, setPeriod] = useState<ExplorePeriod>("this_month");
  const [wrapCadence, setWrapCadence] = useState<"month" | "year">("month");
  const [dir, setDir] = useState<Direction>("all");
  const [label, setLabel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("like_for_like");

  useEffect(() => {
    try { setLabels((a.all(`SELECT name FROM labels WHERE status = 'active' ORDER BY name`) as Array<{ name: string }>).map((r) => r.name)); }
    catch { setLabels([]); }
  }, [a, refreshKey]);

  const filters: ExploreFilters = useMemo(() => ({
    period,
    direction: dir === "all" ? undefined : dir,
    label: label ?? undefined,
    search: search.trim() || undefined,
    minCents: numInput(min),
    maxCents: numInput(max),
  }), [period, dir, label, search, min, max]);

  const wrapFilters: ExploreFilters = useMemo(() => ({
    ...filters,
    period: wrapCadence === "year" ? "this_year" : period === "last_month" ? "last_month" : "this_month",
    direction: undefined,
  }), [filters, wrapCadence, period]);

  const data = useMemo(() => {
    try {
      return {
        summary: exploreSummary(a, filters),
        cats: exploreCategories(a, filters, 7),
        mers: exploreCounterparties(a, filters, 7),
        txs: exploreTransactions(a, filters, 80),
        places: explorePlaces(a, filters),
        wrap: wrapped(a, wrapFilters),
        finance: financeReport(a, filters, Date.now(), comparisonMode),
        monthAccess: wrappedAccess(a, "month"),
        yearAccess: wrappedAccess(a, "year"),
        fuliza: fulizaState(a),
        debt: debtSummary(a),
      };
    } catch {
      return null;
    }
  }, [a, filters, wrapFilters, refreshKey, comparisonMode]);

  const exportCsv = async () => {
    try {
      const rows = exploreTransactions(a, filters, 500);
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [
        ["date", "amount_kes", "direction", "label", "counterparty", "kind", "fee_kes", "note", "lat", "lng"].join(","),
        ...rows.map((r) => [
          new Date(r.occurredAt).toISOString(), (r.amount / 100).toFixed(2), r.direction, r.label ?? "",
          r.cpName ?? "", r.kind, r.fee != null ? (r.fee / 100).toFixed(2) : "", r.note ?? "", r.lat ?? "", r.lng ?? "",
        ].map(esc).join(",")),
      ].join("\n");
      const dirObj = new Directory(Paths.cache, "exports");
      if (!dirObj.exists) dirObj.create({ intermediates: true, idempotent: true });
      const file = new File(dirObj, `pesanalysis-${period}-${Date.now()}.csv`);
      file.writeSync(csv);
      if (!(await Sharing.isAvailableAsync())) throw new Error("sharing is not available");
      await Sharing.shareAsync(file.uri, { mimeType: "text/csv", dialogTitle: "Pesanalysis filtered data" });
    } catch (e) { Alert.alert("Could not export", String(e).slice(0, 180)); }
  };

  const shareReport = async () => {
    if (!data) return;
    const f = data.finance;
    const lines = [
      `Pesanalysis management report — ${f.comparison.current.label}`,
      f.headline,
      f.subhead,
      "",
      ...f.kpis.map((k) => `${k.label}: ${valueOf(k)} (${k.note})`),
      "",
      "Horizontal analysis",
      ...f.deltas.map((d) => `${d.label}: ${kes(d.currentCents)} vs ${d.priorCents == null ? "—" : kes(d.priorCents)} (${pctText(d.pct)})`),
      "",
      "Vertical analysis",
      `Money in ${kes(f.current.incomeCents)}; out ${kes(f.current.spendCents)}; fees ${kes(f.current.feeCents)}; kept ${kes(f.current.netCents)}.`,
      "",
      "Categories",
      ...f.categories.map((c) => `${c.name}: ${kes(c.currentCents)} (${Math.round(c.share * 100)}%)`),
      "",
      "Method",
      ...f.method.map((m) => `- ${m}`),
    ];
    const md = lines.join("\n");
    try {
      const dirObj = new Directory(Paths.cache, "exports");
      if (!dirObj.exists) dirObj.create({ intermediates: true, idempotent: true });
      const file = new File(dirObj, `pesanalysis-report-${period}-${Date.now()}.md`);
      file.writeSync(md);
      if (!(await Sharing.isAvailableAsync())) throw new Error("sharing is not available");
      await Sharing.shareAsync(file.uri, { mimeType: "text/markdown", dialogTitle: "Pesanalysis management report" });
    } catch (e) { Alert.alert("Could not share report", String(e).slice(0, 180)); }
  };

  if (!data) return <Screen><View style={{ padding: 20 }}><Text style={text(14, C.muted)}>Reading your ledger…</Text></View></Screen>;
  const { summary, cats, mers, places, wrap, finance, monthAccess, yearAccess, fuliza, debt } = data;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 22, paddingBottom: 38 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <View style={{ flex: 1 }}>
            <Text style={text(30, C.text, "700")}>Analysis</Text>
            <Text style={[text(12, C.muted), { marginTop: 2 }]}>Look closely at your own money.</Text>
          </View>
          <TouchableOpacity onPress={() => void exportCsv()} style={{ backgroundColor: C.card2, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7 }}>
            <Text style={text(11, C.blue, "600")}>Export</Text>
          </TouchableOpacity>
        </View>

        <Seg value={mode} onChange={setMode} />

        {mode !== "wrapped" && (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }} contentContainerStyle={{ gap: 7 }}>
              {PERIODS.map(([id, labelText]) => (
                <TouchableOpacity key={id} onPress={() => setPeriod(id)} activeOpacity={0.8}>
                  <Pill label={labelText} tone={period === id ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setShowFilters((v) => !v)} activeOpacity={0.8}>
                <Pill label={showFilters ? "Hide filters ×" : "Filters"} tone={showFilters ? "amber" : "dim"} />
              </TouchableOpacity>
            </ScrollView>

            {showFilters && (
              <Card style={{ marginTop: 10 }}>
                <Text style={text(11, C.muted, "700")}>FIND A PAYMENT</Text>
                <TextInput value={search} onChangeText={setSearch} placeholder="Name, category, note or message type"
                  placeholderTextColor={C.dim} autoCorrect={false}
                  style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginTop: 8 }]} />
                <View style={{ flexDirection: "row", gap: 6, marginTop: 9 }}>
                  {([["all", "All"], ["in", "Money in"], ["out", "Money out"]] as Array<[Direction, string]>).map(([id, l]) => (
                    <TouchableOpacity key={id} onPress={() => setDir(id)}><Pill label={l} tone={dir === id ? "blue" : "dim"} /></TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
                  <TextInput value={min} onChangeText={setMin} placeholder="Min KES" placeholderTextColor={C.dim} keyboardType="decimal-pad"
                    style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }]} />
                  <TextInput value={max} onChangeText={setMax} placeholder="Max KES" placeholderTextColor={C.dim} keyboardType="decimal-pad"
                    style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }]} />
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <TouchableOpacity onPress={() => setLabel(null)}><Pill label="Any category" tone={label == null ? "blue" : "dim"} /></TouchableOpacity>
                    {labels.map((l) => (
                      <TouchableOpacity key={l} onPress={() => setLabel(l)}><Pill label={l} tone={label === l ? "blue" : "dim"} /></TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
                <TouchableOpacity onPress={() => { setSearch(""); setMin(""); setMax(""); setDir("all"); setLabel(null); }} style={{ marginTop: 10 }}>
                  <Text style={text(11, C.blue, "600")}>Clear filters</Text>
                </TouchableOpacity>
              </Card>
            )}
          </>
        )}

        {mode === "overview" && (
          <>
            <Summary s={summary} />
            <Card style={{ marginTop: 10 }}>
              <Text style={text(9, C.blue, "700")}>ONE-LINE READ</Text>
              <Text style={[text(16, C.text, "700"), { marginTop: 6, lineHeight: 22 }]}>{finance.headline}</Text>
              <Text style={[text(10, C.muted), { marginTop: 5, lineHeight: 15 }]}>{finance.subhead}</Text>
              <TouchableOpacity onPress={() => setMode("deep")} style={{ marginTop: 9 }}>
                <Text style={text(10, C.blue, "600")}>Open the management report →</Text>
              </TouchableOpacity>
            </Card>
            {debt.active > 0 && (
              <Card style={{ marginTop: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                  <Text style={text(13, C.text, "700")}>Debt</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={text(13, C.amber, "700")}>{kes(debt.outstandingCents)} outstanding</Text>
                </View>
                <Text style={[text(11, C.muted), { marginTop: 5, lineHeight: 16 }]}>
                  {debt.active} active debt{debt.active === 1 ? "" : "s"} · {debt.monthlyCents ? `${kes(debt.monthlyCents)} scheduled monthly` : "no payment schedule set"} · {debt.linkedRepayments} linked repayment{debt.linkedRepayments === 1 ? "" : "s"}.
                  This is separate from cash flow; repayments appear as Debt repayment when you link them.
                </Text>
              </Card>
            )}
            {fuliza && (fuliza.availableCents != null || (fuliza.outstandingCents ?? 0) > 0) && (
              <Card style={{ marginTop: 10, borderColor: fuliza.outstandingCents ? C.amber : C.line }}>
                <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                  <Text style={text(13, C.text, "700")}>Fuliza</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={text(13, C.amber, "700")}>{fuliza.availableCents != null ? `${kes(fuliza.availableCents)} available` : "limit seen"}</Text>
                </View>
                <Text style={[text(11, C.muted), { marginTop: 5, lineHeight: 16 }]}>
                  {fuliza.outstandingCents != null && fuliza.outstandingCents > 0
                    ? `${kes(fuliza.outstandingCents)} is used${fuliza.dueAt ? ` and due ${new Date(fuliza.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. Clear it before midnight to stop another daily fee.`
                    : fuliza.outstandingCents === 0
                      ? "No Fuliza balance is outstanding right now."
                      : "Your latest Fuliza message does not state an outstanding balance."}
                  {fuliza.limitCents != null ? ` Limit ${kes(fuliza.limitCents)}.` : ""}
                </Text>
              </Card>
            )}
            <SectionTitle>WHERE IT WENT</SectionTitle>
            <BucketBars title="Spending groups" rows={cats} empty="No spending matches these filters." />
            <BucketBars title="People and businesses you paid" rows={mers} empty="No payments match these filters." />
            {cats.length > 0 && (
              <Card style={{ marginTop: 10 }}>
                <Chart spec={{
                  kind: "bar", title: "Spending groups", unit: "KES",
                  series: [{ key: "spend", label: "Spent", color: C.blue, points: cats.map((c) => ({ x: c.name, y: c.totalCents })) }],
                }} />
              </Card>
            )}
          </>
        )}

        {mode === "deep" && <DeepDive f={finance} onShare={() => void shareReport()} comparisonMode={comparisonMode} onComparisonChange={setComparisonMode} />}

        {mode === "map" && (
          <>
            <SectionTitle>PLACES</SectionTitle>
            <Card style={{ marginTop: 4 }}>
              <Text style={[text(11, C.muted), { lineHeight: 17 }]}>
                {places.length
                  ? `${places.length} place${places.length === 1 ? "" : "s"} where payments carried a location. The map is OpenStreetMap data on top of your own passive last-known fixes.`
                  : "No payments with a location yet. Past SMS cannot be retro-located; new messages carry a passive last-known place only when the phone has a recent fix."}
              </Text>
            </Card>
            <Suspense fallback={<View style={{ height: 360, alignItems: "center", justifyContent: "center" }}><Text style={text(12, C.dim)}>Loading map…</Text></View>}><PlacesMap places={places} preview /></Suspense>
            {places.map((p, i) => (
              <Card key={p.key} style={{ marginTop: 8, padding: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: C.blue, alignItems: "center", justifyContent: "center" }}>
                    <Text style={text(10, "#fff", "700")}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 9 }}>
                    <Text style={text(13, C.text, "600")}>Area {i + 1} · {p.lat.toFixed(3)}, {p.lng.toFixed(3)}</Text>
                    <Text style={text(10, C.dim)}>{p.count} payment{p.count === 1 ? "" : "s"} · {p.spendCents ? `${kes(p.spendCents)} out` : ""}{p.incomeCents ? `${p.spendCents ? " · " : ""}${kes(p.incomeCents)} in` : ""}{p.accuracy ? ` · ±${Math.round(p.accuracy)}m` : ""}</Text>
                  </View>
                </View>
              </Card>
            ))}
            {places.length === 0 && <Btn label="Open Live connectors" kind="soft" onPress={onMore} style={{ marginTop: 10 }} />}
            <Text style={[text(10, C.dim), { marginTop: 12, lineHeight: 15 }]}>
              Location is captured once when an SMS arrives. Pesanalysis does not follow you.
            </Text>
          </>
        )}

        {mode === "wrapped" && (
          <>
            <View style={{ flexDirection: "row", gap: 7, marginTop: 12 }}>
              <TouchableOpacity onPress={() => setWrapCadence("month")} activeOpacity={0.8}>
                <Pill label="Monthly" tone={wrapCadence === "month" ? "blue" : "dim"} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setWrapCadence("year")} activeOpacity={0.8}>
                <Pill label="Yearly" tone={wrapCadence === "year" ? "blue" : "dim"} />
              </TouchableOpacity>
            </View>
            {wrapCadence === "month" && (monthAccess.unlocked ? <WrappedCard w={wrap} /> : <WrappedLock access={monthAccess} cadence="month" />)}
            {wrapCadence === "year" && (yearAccess.unlocked ? <WrappedCard w={wrap} /> : <WrappedLock access={yearAccess} cadence="year" />)}
            {wrapCadence === "month" && monthAccess.unlocked && !yearAccess.unlocked && (
              <Card style={{ marginTop: 10, borderColor: "#3A2E12", backgroundColor: "#17130A" }}>
                <Text style={text(10, C.amber, "700")}>YEARLY</Text>
                <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 16 }]}>Yearly Wrapped unlocks {dateLabel(yearAccess.unlockAt)}. Monthly is already available.</Text>
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
