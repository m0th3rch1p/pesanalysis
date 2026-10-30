/**
 * Detail completeness (F-MOMENTS reward). The reward is how much a record says, never how often you tapped:
 * there are no streaks, and the score is monotonic (adding detail never lowers it).
 */
export interface DetailFlags {
  label: boolean;
  note: boolean;
  tag: boolean;
  photo: boolean;
  voice: boolean;
  place: boolean;
  counterpartyRole: boolean;
}

export const DETAIL_FIELDS = ["label", "note", "tag", "photo", "voice", "place", "counterpartyRole"] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];

/** Sums to 100. */
export const DETAIL_WEIGHTS: Record<DetailField, number> = { label: 30, note: 15, tag: 5, photo: 15, voice: 15, place: 10, counterpartyRole: 10 };

export type CompletenessLevel = "empty" | "partial" | "filed" | "detailed" | "rich";

export interface Completeness {
  score: number;
  /** F-REVIEWLOOP: a category plus at least one of note, tag, photo or voice */
  submitted: boolean;
  level: CompletenessLevel;
  present: DetailField[];
  missing: DetailField[];
  /** the single highest-value addition */
  next: DetailField | null;
}

export const noDetails = (): DetailFlags => ({ label: false, note: false, tag: false, photo: false, voice: false, place: false, counterpartyRole: false });

export function detailCompleteness(d: Partial<DetailFlags>): Completeness {
  const present = DETAIL_FIELDS.filter((f) => d[f]);
  const missing = DETAIL_FIELDS.filter((f) => !d[f]);
  const score = present.reduce((a, f) => a + DETAIL_WEIGHTS[f], 0);
  const submitted = !!d.label && !!(d.note || d.tag || d.photo || d.voice);
  const level: CompletenessLevel = score === 0 ? "empty" : !submitted ? "partial" : score >= 85 ? "rich" : score >= 60 ? "detailed" : "filed";
  const next = [...missing].sort((a, b) => DETAIL_WEIGHTS[b] - DETAIL_WEIGHTS[a])[0] ?? null;
  return { score, submitted, level, present, missing, next };
}

export interface MomentsItem { txId: number; details: Partial<DetailFlags> }
export interface MomentsSummary {
  n: number;
  avgScore: number | null;
  submitted: number;
  submittedShare: number | null;
  levels: Record<CompletenessLevel, number>;
  /** how many records lack each field, most common first */
  missingByField: Array<{ field: DetailField; count: number }>;
}

/** Aggregate over any set of records (a week, a month). Counts are returned with every share; nothing is a streak. */
export function summariseMoments(items: MomentsItem[]): MomentsSummary {
  const levels: Record<CompletenessLevel, number> = { empty: 0, partial: 0, filed: 0, detailed: 0, rich: 0 };
  const miss = new Map<DetailField, number>();
  let sum = 0, submitted = 0;
  for (const it of items) {
    const c = detailCompleteness(it.details);
    sum += c.score; levels[c.level]++;
    if (c.submitted) submitted++;
    for (const f of c.missing) miss.set(f, (miss.get(f) ?? 0) + 1);
  }
  const n = items.length;
  return {
    n, avgScore: n ? Math.round((sum / n) * 10) / 10 : null, submitted, submittedShare: n ? submitted / n : null, levels,
    missingByField: [...miss].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count || DETAIL_FIELDS.indexOf(a.field) - DETAIL_FIELDS.indexOf(b.field)),
  };
}
