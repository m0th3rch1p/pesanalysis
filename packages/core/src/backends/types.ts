/**
 * Stack-agnostic inference interfaces (D44). SCAFFOLD: types only.
 * Adapters (not yet written): `qvac-device` (Z0), `openai-compatible-host` (Z1), `external-api` (Z2, off by default).
 * No vendor SDK is imported in core; adapters live in apps/mobile or tools.
 */
import type { Zone } from "../models/policy.js";

export interface BackendInfo {
  id: string;
  /** Must match a models/policy.json entry. */
  modelId: string;
  zone: Zone;
  capabilities: { constrainedJson: boolean; toolChoice: boolean; embeddings: boolean; lora: boolean; vision: boolean; speech: boolean };
  ctxTokens: number;
}

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string }

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Disable reasoning/thinking output for latency (Qwen3 `reasoning_budget: 0`). */
  noThink?: boolean;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  stopReason: "eos" | "length" | "cancelled" | "error";
  stats?: { promptTokens?: number; genTokens?: number; tokPerSec?: number; ms: number };
}

export interface InferenceBackend {
  info: BackendInfo;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Output constrained to a JSON Schema (grammar/tool-call constrained). Rejects if the backend cannot constrain. */
  planConstrained(req: CompletionRequest, jsonSchema: object, toolName: string): Promise<{ json: unknown; raw: string; ms: number }>;
}

export interface EmbeddingBackend {
  info: BackendInfo & { dim: number };
  embed(texts: string[]): Promise<number[][]>;
}

export interface SpeechBackend {
  info: BackendInfo;
  transcribe(audio: Uint8Array, opts?: { lang?: string }): Promise<{ text: string; lang?: string; confidence?: number }>;
}
