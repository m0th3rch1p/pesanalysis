/** Persona/tone/language packs are DATA (WP8). SCAFFOLD: types only. */
export interface VerticalPack {
  id: string; // e.g. "mama_mboga", "boda_rider", "forex_trader"
  name: string;
  defaultTags: { name: string; kind: "venture" | "user"; ventureKind?: string }[];
  kpis: { id: string; label: string; plan: object }[]; // plan = QueryPlan
  detectorOverrides?: Record<string, Record<string, number>>;
  questionTemplates: { kind: string; prompt: string }[];
  vocabulary: Record<string, string[]>;
}
export interface TonePack { id: string; name: string; systemFragment: string; glossary?: Record<string, string>; samples?: string[] }
export interface LanguagePack { id: string; name: string; lexicon: Record<string, string>; loraAdapterId?: string /* must exist in models/policy.json */ }
export interface ProfileState { verticals: string[]; tone: string; language: string; updatedAt: number }
