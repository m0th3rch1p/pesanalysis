/**
 * kNN over confirmed transactions using character-trigram TF vectors. Runs anywhere (Node, Hermes,
 * Bare) with zero native deps. Designed to be swappable with QVAC embedding vectors later:
 * `suggest()` accepts either text or precomputed vectors per history item.
 */
export interface KnnItem {
  id: string; label: string; text: string; vec?: Map<string, number>;
  /** parsed SMS kind the label was learned from; used to stop cross-class contamination (WS0.3) */
  kind?: string | null;
}
export interface KnnHit { id: string; label: string; sim: number }

const GRAM_N = 3;

export function trigramVec(text: string): Map<string, number> {
  const s = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const v = new Map<string, number>();
  const padded = `  ${s} `;
  for (let i = 0; i + GRAM_N <= padded.length; i++) {
    const g = padded.slice(i, i + GRAM_N);
    v.set(g, (v.get(g) ?? 0) + 1);
  }
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [g, y] of b) { nb += y * y; const x = a.get(g); if (x) dot += x * y; }
  return dot / Math.sqrt(na * nb || 1);
}

export interface KnnResult { label: string; margin: number; top: KnnHit[] }

/**
 * Neighbour vote with margin calibration: margin = sim(top1) - sim(best different-label neighbour).
 * margin in [0,1]; callers turn it into a confidence with their own calibration.
 */
export function knnLabel(query: string, history: KnnItem[], k = 5, minSim = 0): KnnResult | null {
  if (history.length === 0) return null;
  const qv = trigramVec(query);
  const hits: KnnHit[] = history
    .map((h) => ({ id: h.id, label: h.label, sim: cosine(qv, h.vec ?? trigramVec(h.text)) }))
    .filter((h) => h.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
  if (!hits.length || hits[0]!.sim <= 0.05) return null;
  const votes = new Map<string, number>();
  for (const h of hits) votes.set(h.label, (votes.get(h.label) ?? 0) + h.sim);
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  const topLabel = ranked[0]![0];
  const otherBest = ranked.find(([l]) => l !== topLabel)?.[1] ?? 0;
  return { label: topLabel, margin: ranked[0]![1] - otherBest, top: hits };
}
