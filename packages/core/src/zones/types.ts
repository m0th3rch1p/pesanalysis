/** Trust zones (D39). Spec: docs/PRIVACY_MODEL.md. */
import type { Zone } from "../models/policy.js";
export type { Zone };

export type Capability = "read_private" | "send_out" | "pure";

export interface RowPolicy {
  maxRows: number;
  /** Columns this tool may return, per zone. Enforced by the tool's SQL and checked in tests. */
  allowedColumns: Partial<Record<Zone, string[]>>;
  suppressBelowK?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
  returns: object;
  /** Zones allowed to call it. A private tool must never include Z2. */
  allowedZones: Zone[];
  capability: Capability;
  rowPolicy: RowPolicy;
  /** send_out tools require an explicit user tap. */
  confirm: "none" | "user_tap";
}

export interface PairedHost { id: string; name: string; zone: "Z1"; pairedAt: number; keyFingerprint: string; revokedAt?: number }

export interface ToolAuditEntry { zone: Zone; hostId?: string; tool: string; paramsJson: string; rowCount: number; at: number; ok: boolean }
