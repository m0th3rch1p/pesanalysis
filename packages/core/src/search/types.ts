/** Search query grammar. SCAFFOLD: types only. Tokens: >500 <100 tag:rent cat:groceries @home "last week" + free text (FTS5). */
import type { PlanFilters } from "../analyst/plan.js";

export type SearchFilters = PlanFilters & { place?: string };

export interface ParsedSearch {
  filters: SearchFilters;
  /** Remaining free text for FTS5 MATCH. */
  fts: string;
  /** Chips shown to the user explaining how the query was understood; each removable. */
  chips: { id: string; label: string; kind: "amount" | "tag" | "label" | "time" | "place" | "text" }[];
}
