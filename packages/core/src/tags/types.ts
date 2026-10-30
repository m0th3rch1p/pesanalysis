/** Tags, ventures, retroactive proposals. SCAFFOLD: types only. See IMPLEMENTATION section 3.2 and WP1. */
export type TagKind = "user" | "suggested" | "auto" | "venture";
export type TagSource = "user" | "rule" | "cluster" | "llm";
export type VentureKind = "project" | "business" | "investment" | "savings_goal" | "trip" | "event";

export interface Tag { id: number; name: string; kind: TagKind; color?: string; parentId?: number; status: "active" | "merged" | "archived"; mergedInto?: number }

export interface TagProposal {
  tag: string;
  kind: TagKind;
  candidateTxIds: number[];
  /** Why this is proposed: shown to the user. */
  why: string;
  source: Exclude<TagSource, "user">;
  evidence: Record<string, unknown>;
  confidence: number;
}

export interface VenturePnL {
  tagId: number;
  incomeCents: number;
  expenseCents: number;
  feeCents: number;
  netCents: number;
  txCount: number;
  from: number;
  to: number;
}
