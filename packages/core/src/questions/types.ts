/** Clarifying-question queue (WP7). SCAFFOLD: types only. Ranking is code, not the LLM. */
export type QuestionKind = "untagged_cluster" | "unknown_role" | "label_conflict" | "venture_boundary" | "recurring_unowned" | "income_type" | "place_name" | "pending_label";

export interface Question {
  id: number;
  kind: QuestionKind;
  subjectRef: string;
  prompt: string;
  options?: string[];
  /** Expected information gain x money at stake x recency; computed in core. */
  score: number;
  status: "pending" | "answered" | "dismissed" | "expired";
  /** Always shown: "why am I asking this". */
  why: string;
}

export interface QuestionBudget { maxOpenPerDay: number; quietHours?: { fromHour: number; toHour: number } }
