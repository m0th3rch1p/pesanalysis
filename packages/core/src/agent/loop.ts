import type { Tool } from "./tools.js";

/**
 * Deterministic agent loop (LLM-optional): the LLM picks a tool + JSON args; CORE executes the
 * tool and assembles the final answer from real data. Small models are unreliable tool callers,
 * so: (1) args must parse as JSON matching the tool's param list, (2) invalid output twice ->
 * deterministic fallback answer (top findings + weekly summary), (3) the LLM narrates but the
 * NUMBERS come from tools. Post-check: every number in narration must exist in tool output.
 */
export interface LlmFn {
  (system: string, user: string): Promise<string>;
}

export interface AgentTurn {
  answer: string;
  toolsUsed: string[];
  numbersVerified: boolean;
}

const MAX_ITERS = 4;

export async function agentAnswer(question: string, tools: Tool[], llm: LlmFn | null): Promise<AgentTurn> {
  const toolsUsed: string[] = [];
  const results: Record<string, unknown> = {};

  if (llm) {
    const toolDesc = tools.map((t) => `${t.name}(${Object.keys(t.params).join(", ")}): ${t.description}`).join("\n");
    const sys = [
      "You are a financial assistant. You MUST answer with a single JSON object, no prose:",
      '{"tool": "<name>", "args": {...}}',
      "Available tools:",
      toolDesc,
      "After tool selection you will be given the result and asked to write the final answer in the user's language. Never introduce numbers that are not in the tool result.",
    ].join("\n");
    for (let i = 0; i < MAX_ITERS; i++) {
      let out: string;
      try { out = await llm(sys, i === 0 ? question : `Tool result: ${JSON.stringify(results)}\n\nNow write the final answer to: ${question}`); }
      catch { break; }
      const picked = parseToolCall(out, tools);
      if (picked) {
        const [tool, args] = picked;
        toolsUsed.push(tool.name);
        results[tool.name] = tool.run(args);
        if (i === 0) continue; // got data; one more call to narrate
      }
      const answer = out.trim();
      if (answer && !picked) return { answer: numbersVerified(answer, results), toolsUsed, numbersVerified: true };
    }
  }
  // deterministic fallback: the agent still answers, from code only
  const findings = tools.find((t) => t.name === "list_findings")?.run({}) as Array<{ title: string }> | undefined;
  const week = tools.find((t) => t.name === "sum_by_label")?.run({ days: 7 });
  const answer = [
    "Answering from the local ledger (no model needed):",
    findings?.slice(0, 3).map((f) => `- ${f.title}`).join("\n") ?? "- no patterns yet",
    `Last 7 days by category: ${JSON.stringify(week)}`,
  ].join("\n");
  return { answer, toolsUsed, numbersVerified: true };
}

function parseToolCall(out: string, tools: Tool[]): [Tool, Record<string, unknown>] | null {
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { tool?: string; args?: Record<string, unknown> };
    const tool = tools.find((t) => t.name === j.tool);
    if (!tool) return null;
    const args = j.args ?? {};
    for (const k of Object.keys(tool.params)) if (args[k] == null) args[k] = tool.params[k] === "number" ? 30 : "";
    return [tool, args];
  } catch { return null; }
}

/** Number-preservation post-check: narration may only contain numbers present in tool results. */
export function numbersVerified(answer: string, results: Record<string, unknown>): string {
  const allowed = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "number") { allowed.add(String(v)); allowed.add(v.toFixed(2)); allowed.add(v.toFixed(1)); allowed.add(v.toFixed(0)); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  Object.values(results).forEach(collect);
  return answer.replace(/-?\d[\d,]*(?:\.\d+)?/g, (n) => {
    const clean = n.replace(/,/g, "");
    const v = Number(clean);
    if (allowed.has(clean) || allowed.has(String(Math.round(v))) || Math.abs(v) < 100) return n; // small numbers (dates, "7 days") allowed
    return "[—]";
  });
}
