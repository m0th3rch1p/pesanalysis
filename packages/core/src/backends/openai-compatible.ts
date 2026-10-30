import type { InferenceBackend, CompletionRequest, CompletionResult } from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string; apiKey?: string; modelId: string;
  zone: "Z1" | "Z2";
  timeoutMs?: number;
  ctxTokens?: number;
}

/**
 * Z1/Z2 adapter for an OpenAI-compatible server (qvac serve, llama.cpp, vLLM, Ollama).
 * Z2 callers must pass airlock aggregates only; this adapter never sees the ledger.
 */
export function openAICompatibleBackend(cfg: OpenAICompatibleConfig): InferenceBackend {
  const run = async (messages: Array<{ role: string; content: string }>, maxTokens: number, temperature = 0.2, responseFormat?: object, signal?: AbortSignal): Promise<{ text: string; json: Record<string, unknown> }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 60_000);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.modelId,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
      const json = await res.json() as Record<string, unknown>;
      const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
      return { text: choices?.[0]?.message?.content?.trim() ?? "", json };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    info: {
      id: `openai-compatible:${cfg.modelId}`,
      modelId: cfg.modelId,
      zone: cfg.zone,
      capabilities: { constrainedJson: true, toolChoice: false, embeddings: false, lora: false, vision: false, speech: false },
      ctxTokens: cfg.ctxTokens ?? 4096,
    },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const t0 = Date.now();
      try {
        const out = await run(req.messages, req.maxTokens, req.temperature, undefined, req.signal);
        return { text: out.text, stopReason: "eos", stats: { ms: Date.now() - t0 } };
      } catch (e) {
        return { text: "", stopReason: "error", stats: { ms: Date.now() - t0 } };
      }
    },
    async planConstrained(req: CompletionRequest, jsonSchema: object, toolName: string) {
      const t0 = Date.now();
      const out = await run(
        req.messages, req.maxTokens, 0,
        { type: "json_schema", json_schema: { name: toolName, schema: jsonSchema, strict: true } },
        req.signal,
      );
      return { json: JSON.parse(out.text) as unknown, raw: out.text, ms: Date.now() - t0 };
    },
  };
}
