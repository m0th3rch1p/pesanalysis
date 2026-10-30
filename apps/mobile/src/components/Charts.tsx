import { useMemo } from "react";
import { useWindowDimensions, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { scaleBand, scaleLinear, scaleLog, scalePoint } from "d3-scale";
import { arc, line, pie } from "d3-shape";
import type { ChartSpec } from "@yako/core";
import { C, text } from "../ui";
import { Text } from "react-native";

const PALETTE = [C.blue, C.green, C.amber, "#FF9F0A", "#BF5AF2", "#64D2FF", C.red];

function chartWidth(windowWidth: number): number {
  return Math.max(240, Math.min(windowWidth - 64, 560));
}

export function shortKes(cents: number): string {
  const kes = cents / 100;
  const abs = Math.abs(kes);
  const sign = kes < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

function empty(title: string) {
  return (
    <View style={{ paddingVertical: 28, alignItems: "center" }}>
      <Text style={text(12, C.dim)}>{title}: not enough data yet.</Text>
    </View>
  );
}

export function LineChart({ spec, height = 150 }: { spec: ChartSpec; height?: number }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  const first = spec.series[0];
  if (!first || first.points.length === 0) return empty(spec.title);
  const xs = first.points.map((p) => String(p.x));
  const all = spec.series.flatMap((s) => s.points.map((p) => p.y));
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const x = scalePoint<string>().domain(xs).range([34, width - 8]).padding(0.2);
  const y = scaleLinear().domain([min, max]).range([height - 22, 8]);
  return (
    <Svg width={width} height={height}>
      {[0, 0.5, 1].map((f) => {
        const yy = 8 + (height - 30) * f;
        return <Line key={f} x1={30} x2={width - 8} y1={yy} y2={yy} stroke={C.line} strokeWidth={1} />;
      })}
      {spec.series.map((s, i) => {
        const color = s.color ?? PALETTE[i % PALETTE.length];
        const path = line<{ x: string | number; y: number }>()
          .x((p) => x(String(p.x)) ?? 34)
          .y((p) => y(p.y))(s.points) ?? "";
        return (
          <G key={s.key}>
            <Path d={path} stroke={color} strokeWidth={2} fill="none" />
            {s.points.map((p, j) => (
              <Circle key={j} cx={x(String(p.x)) ?? 0} cy={y(p.y)} r={2.4} fill={color} />
            ))}
          </G>
        );
      })}
      {xs.filter((_, i) => i === 0 || i === xs.length - 1 || (xs.length <= 6 && i % 1 === 0)).map((label) => (
        <SvgText key={label} x={x(label) ?? 0} y={height - 6} fill={C.dim} fontSize={9} textAnchor="middle">{label}</SvgText>
      ))}
      <SvgText x={2} y={12} fill={C.dim} fontSize={9}>{shortKes(max)}</SvgText>
    </Svg>
  );
}

export function HBarChart({ spec, height }: { spec: ChartSpec; height?: number }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  const s = spec.series[0];
  if (!s || !s.points.length) return empty(spec.title);
  const rows = s.points.slice(0, 8);
  const max = Math.max(1, ...rows.map((p) => Math.abs(p.y)));
  const rowH = 26;
  const h = height ?? rows.length * rowH + 8;
  const labelW = Math.min(112, width * 0.36);
  return (
    <Svg width={width} height={h}>
      {rows.map((p, i) => {
        const yy = i * rowH + 4;
        const barW = Math.max(1, ((width - labelW - 52) * Math.abs(p.y)) / max);
        return (
          <G key={`${p.x}-${i}`}>
            <SvgText x={0} y={yy + 13} fill={C.muted} fontSize={10}>{String(p.x).slice(0, 18)}</SvgText>
            <Rect x={labelW} y={yy + 4} width={barW} height={13} rx={4} fill={spec.series[0]!.color ?? PALETTE[i % PALETTE.length]} opacity={0.9} />
            <SvgText x={labelW + barW + 5} y={yy + 14} fill={C.muted} fontSize={9}>{shortKes(p.y)}</SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

export function StackedBarChart({ spec, height = 170 }: { spec: ChartSpec; height?: number }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  const labels = [...new Set(spec.series.flatMap((s) => s.points.map((p) => String(p.x))))];
  if (!labels.length) return empty(spec.title);
  const totals = labels.map((l) => spec.series.reduce((sum, s) => sum + (s.points.find((p) => String(p.x) === l)?.y ?? 0), 0));
  const max = Math.max(1, ...totals);
  const x = scalePoint<string>().domain(labels).range([30, width - 6]).padding(0.25);
  const plotH = height - 30;
  const bw = Math.max(10, (width - 40) / Math.max(1, labels.length) * 0.55);
  return (
    <Svg width={width} height={height}>
      {labels.map((label) => {
        let y0 = plotH;
        return (
          <G key={label}>
            {spec.series.map((s, i) => {
              const v = s.points.find((p) => String(p.x) === label)?.y ?? 0;
              const h = (v / max) * plotH;
              y0 -= h;
              return <Rect key={s.key} x={(x(label) ?? 0) - bw / 2} y={y0} width={bw} height={Math.max(0, h)} rx={2} fill={s.color ?? PALETTE[i % PALETTE.length]} opacity={0.9} />;
            })}
            <SvgText x={x(label) ?? 0} y={height - 6} fill={C.dim} fontSize={9} textAnchor="middle">{label}</SvgText>
          </G>
        );
      })}
      <SvgText x={2} y={10} fill={C.dim} fontSize={9}>{shortKes(max)}</SvgText>
    </Svg>
  );
}

export function DonutChart({ spec, size = 150 }: { spec: ChartSpec; size?: number }) {
  const series = spec.series[0];
  if (!series || !series.points.length) return empty(spec.title);
  const total = series.points.reduce((s, p) => s + p.y, 0) || 1;
  const arcs = pie<{ x: string | number; y: number }>().value((d) => d.y).sort(null)(series.points);
  const radius = size / 2;
  const ring = arc<{ x: string | number; y: number }>().innerRadius(radius * 0.62).outerRadius(radius * 0.92);
  return (
    <Svg width={size} height={size}>
      <G x={radius} y={radius}>
        {arcs.map((a, i) => (
          <Path key={String(a.data.x)} d={ring(a as never) ?? ""} fill={PALETTE[i % PALETTE.length]} />
        ))}
        <SvgText x={0} y={4} fill={C.text} fontSize={13} fontWeight="700" textAnchor="middle">{shortKes(total)}</SvgText>
      </G>
    </Svg>
  );
}

export function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.kind !== "stacked_bar" && spec.kind !== "donut" && spec.kind !== "line") return null;
  const items = spec.kind === "donut" ? (spec.series[0]?.points ?? []).map((p, i) => ({ label: String(p.x), color: PALETTE[i % PALETTE.length] })) : spec.series.map((s, i) => ({ label: s.label, color: s.color ?? PALETTE[i % PALETTE.length] }));
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
      {items.slice(0, 8).map((it) => (
        <View key={it.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: it.color }} />
          <Text style={text(10, C.muted)}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function Heatmap({ spec }: { spec: ChartSpec }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  const cells = spec.cells ?? [];
  if (!cells.length) return empty(spec.title);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const buckets = 12;
  const agg = new Map<string, number>();
  for (const c of cells) {
    const day = String(c.x);
    const hour = Number(c.y);
    const b = Math.floor(hour / 2);
    const key = `${day}|${b}`;
    agg.set(key, (agg.get(key) ?? 0) + c.v);
  }
  const max = Math.max(1, ...agg.values());
  const labelW = 30;
  const cellW = (width - labelW - 4) / buckets;
  const cellH = 16;
  const height = 7 * cellH + 18;
  return (
    <Svg width={width} height={height}>
      {days.map((d, row) => (
        <G key={d}>
          <SvgText x={0} y={row * cellH + 12} fill={C.muted} fontSize={9}>{d}</SvgText>
          {Array.from({ length: buckets }).map((_, b) => {
            const v = agg.get(`${d}|${b}`) ?? 0;
            const op = v ? 0.15 + 0.85 * (v / max) : 0.04;
            return <Rect key={b} x={labelW + b * cellW + 1} y={row * cellH + 2} width={Math.max(2, cellW - 2)} height={cellH - 3} rx={2} fill={C.blue} opacity={op} />;
          })}
        </G>
      ))}
      {[0, 6, 12, 18, 23].map((h) => (
        <SvgText key={h} x={labelW + Math.floor(h / 2) * cellW} y={height - 2} fill={C.dim} fontSize={8}>{h}:00</SvgText>
      ))}
    </Svg>
  );
}

export function MiniBars({ values, color = C.blue }: { values: number[]; color?: string }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: 28 }}>
      {values.map((v, i) => (
        <View key={i} style={{ width: 4, height: Math.max(2, (v / max) * 28), borderRadius: 2, backgroundColor: color, opacity: 0.7 }} />
      ))}
    </View>
  );
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const chart = useMemo(() => {
    switch (spec.kind) {
      case "line": return <LineChart spec={spec} />;
      case "bar": return <HBarChart spec={spec} />;
      case "stacked_bar": return <StackedBarChart spec={spec} />;
      case "donut": return <DonutChart spec={spec} />;
      case "heatmap": return <Heatmap spec={spec} />;
      default: return empty(spec.title);
    }
  }, [spec]);
  return (
    <View>
      {chart}
      <Legend spec={spec} />
    </View>
  );
}


export interface WaterfallDatum {
  label: string;
  value: number;
  kind: "total" | "positive" | "negative";
}

/** P&L bridge: money in -> fees -> money out -> free cash flow. */
export function WaterfallChart({ data, height = 210 }: { data: WaterfallDatum[]; height?: number }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  if (!data.length) return empty("Cash-flow bridge");
  const positives = data.map((d) => d.value);
  const max = Math.max(1, ...positives, 0);
  const min = Math.min(0, ...positives);
  const plotH = height - 52;
  const topPad = 28;
  const y = scaleLinear().domain([min, max]).range([plotH, topPad]);
  const bw = Math.min(54, (width - 24) / data.length * 0.58);
  let running = 0;
  return (
    <View>
      <Svg width={width} height={height}>
        {[...new Set([max, 0, min])].map((v) => {
          const yy = y(v);
          return (
            <G key={v}>
              <Line x1={0} x2={width} y1={yy} y2={yy} stroke={v === 0 ? C.muted : C.line} strokeWidth={1} strokeDasharray={v === 0 ? "0" : "2 4"} />
              <SvgText x={0} y={yy - 3} fill={v === 0 ? C.muted : C.dim} fontSize={8}>{shortKes(v)}</SvgText>
            </G>
          );
        })}
        {data.map((d, i) => {
          const cx = ((i + 0.5) / data.length) * width;
          let y0: number, y1: number;
          if (d.kind === "total") {
            y0 = y(0); y1 = y(d.value); running = d.value;
          } else {
            const next = running + d.value;
            y0 = y(running); y1 = y(next); running = next;
          }
          const top = Math.min(y0, y1);
          const h = Math.max(1, Math.abs(y1 - y0));
          const color = d.kind === "total" ? (d.value >= 0 ? C.green : C.red) : d.value >= 0 ? C.green : C.red;
          return (
            <G key={d.label}>
              <Rect x={cx - bw / 2} y={top} width={bw} height={h} rx={4} fill={color} opacity={d.kind === "total" ? 0.95 : 0.78} />
              {i < data.length - 1 && (
                <Line x1={cx + bw / 2} x2={((i + 1.5) / data.length) * width - bw / 2} y1={y1} y2={y1} stroke={C.dim} strokeWidth={1} strokeDasharray="2 3" />
              )}
              <SvgText x={cx} y={Math.max(10, Math.min(top - 5, height - 30))} fill={d.kind === "total" ? C.text : C.muted} fontSize={9} textAnchor="middle">
                {d.kind === "total" ? shortKes(d.value) : `${d.value < 0 ? "−" : "+"}${shortKes(Math.abs(d.value))}`}
              </SvgText>
              <SvgText x={cx} y={height - 8} fill={C.dim} fontSize={8} textAnchor="middle">{d.label}</SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

export interface ScatterDatum { x: number; y: number; label?: string }

export function ScatterChart({
  points, xLabel, yLabel, height = 190,
}: { points: ScatterDatum[]; xLabel: string; yLabel: string; height?: number }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  const clean = points.filter((p) => p.x > 0 && p.y >= 0);
  if (!clean.length) return empty("Relationship");
  const xs = clean.map((p) => p.x), ys = clean.map((p) => p.y);
  const xMin = Math.max(1, Math.min(...xs) * 0.85), xMax = Math.max(1, Math.max(...xs) * 1.15);
  const yMax = Math.max(1, Math.max(...ys) * 1.15);
  const x = scaleLog().domain([xMin, xMax]).range([38, width - 8]);
  const y = scaleLinear().domain([0, yMax]).range([height - 30, 10]);
  const ticks = [10, 100, 1_000, 10_000, 100_000, 1_000_000].filter((v) => v >= xMin && v <= xMax);
  return (
    <Svg width={width} height={height}>
      {[0, 0.5, 1].map((f) => {
        const yy = 10 + (height - 40) * f;
        return <Line key={f} x1={34} x2={width - 6} y1={yy} y2={yy} stroke={C.line} strokeWidth={1} />;
      })}
      {clean.map((p, i) => (
        <Circle key={i} cx={x(p.x)} cy={y(p.y)} r={3} fill={p.y > 0 ? C.amber : C.blue} opacity={0.62} />
      ))}
      {ticks.map((v) => (
        <SvgText key={v} x={x(v)} y={height - 12} fill={C.dim} fontSize={8} textAnchor="middle">{shortKes(v)}</SvgText>
      ))}
      <SvgText x={34} y={height - 2} fill={C.dim} fontSize={8}>{xLabel} (log)</SvgText>
      <SvgText x={4} y={10} fill={C.dim} fontSize={8}>{yLabel}</SvgText>
      <SvgText x={2} y={height - 12} fill={C.dim} fontSize={8}>0</SvgText>
    </Svg>
  );
}

export interface CompareDatum { label: string; current: number; prior: number | null }

export function GroupedBarChart({
  data, height = 190, currentLabel = "Now", priorLabel = "Prior",
}: { data: CompareDatum[]; height?: number; currentLabel?: string; priorLabel?: string }) {
  const { width: win } = useWindowDimensions();
  const width = chartWidth(win);
  if (!data.length) return empty("Period comparison");
  const max = Math.max(1, ...data.flatMap((d) => [d.current, d.prior ?? 0]));
  const plotH = height - 42;
  const y = scaleLinear().domain([0, max]).range([plotH, 8]);
  const x = scaleBand<string>().domain(data.map((d) => d.label)).range([28, width - 6]).padding(0.28);
  const bw = Math.max(7, x.bandwidth() / 2 - 2);
  return (
    <Svg width={width} height={height}>
      {[0, 0.5, 1].map((f) => {
        const yy = 8 + plotH * f;
        return <Line key={f} x1={24} x2={width - 6} y1={yy} y2={yy} stroke={C.line} strokeWidth={1} />;
      })}
      {data.map((d) => {
        const cx = x(d.label) ?? 0;
        return (
          <G key={d.label}>
            <Rect x={cx} y={y(d.current)} width={bw} height={Math.max(1, plotH - y(d.current))} rx={3} fill={C.blue} opacity={0.95} />
            {d.prior != null && <Rect x={cx + bw + 2} y={y(d.prior)} width={bw} height={Math.max(1, plotH - y(d.prior))} rx={3} fill={C.dim} opacity={0.55} />}
            <SvgText x={cx + bw} y={height - 22} fill={C.dim} fontSize={8} textAnchor="middle">{d.label}</SvgText>
          </G>
        );
      })}
      <SvgText x={2} y={10} fill={C.dim} fontSize={8}>{shortKes(max)}</SvgText>
    </Svg>
  );
}

/** A single target/actual bar with a reference marker. */
export function BulletChart({
  value, max, target, label, valueText,
}: { value: number; max: number; target?: number | null; label: string; valueText: string }) {
  const { width: win } = useWindowDimensions();
  const width = Math.min(win - 64, 560);
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const tpct = target != null && max > 0 ? Math.max(0, Math.min(1, target / max)) : null;
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={text(10, C.dim)}>{label}</Text>
        <Text style={text(10, C.muted, "600")}>{valueText}</Text>
      </View>
      <Svg width={width} height={14} style={{ marginTop: 4 }}>
        <Rect x={0} y={3} width={width} height={8} rx={4} fill={C.line} />
        <Rect x={0} y={3} width={Math.max(2, width * pct)} height={8} rx={4} fill={pct > 0.5 ? C.green : C.amber} />
        {tpct != null && <Line x1={width * tpct} x2={width * tpct} y1={1} y2={13} stroke={C.text} strokeWidth={1.5} />}
      </Svg>
    </View>
  );
}
