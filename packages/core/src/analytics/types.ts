/** Hub analysis contract. SCAFFOLD: types only. See docs/IMPLEMENTATION.md section 3.4. */
export type ChartKind = "line" | "bar" | "stacked_bar" | "donut" | "heatmap" | "sparkline" | "table";

export interface ChartSeries { key: string; label: string; points: { x: string | number; y: number }[]; color?: string }

export interface ChartSpec {
  kind: ChartKind;
  title: string;
  unit: "KES" | "count" | "percent";
  series: ChartSeries[];
  /** Heatmap cells etc. */
  cells?: { x: string | number; y: string | number; v: number }[];
  annotations?: { x: string | number; label: string }[];
}

export interface AnalysisResult {
  id: string;
  kind: string;
  title: string;
  chart?: ChartSpec;
  /** Plain-language findings with n and how computed; numbers come from code. */
  findings: { text: string; n: number; evidence: Record<string, unknown> }[];
  computedAt: number;
  dataVersion: number;
}
