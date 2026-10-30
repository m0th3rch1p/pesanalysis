import type { DbAdapter } from "../db/migrate.js";
import { createRegistry, installBuiltins, ZoneViolation, type Registry } from "./registry.js";
import type { Zone } from "./types.js";

export interface McpRequest {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Transport-independent MCP handler. Exposes only tools allowed in the chosen zone. */
export function handleMcpRequest(db: DbAdapter, zone: Zone, req: McpRequest, registry?: Registry, now = Date.now()): McpResponse {
  const id = req.id ?? null;
  const reg = registry ?? installBuiltins(createRegistry({ db, now: () => now }));
  try {
    switch (req.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "pesanalysis", version: "4.0.0" }, capabilities: { tools: {} } } };
      case "tools/list":
        return {
          jsonrpc: "2.0", id,
          result: {
            tools: reg.toolsForZone(zone).map((t) => ({
              name: t.name, description: t.description, inputSchema: t.parameters,
            })),
          },
        };
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const result = reg.invokeTool(zone, name, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${req.method}` } };
    }
  } catch (e) {
    if (e instanceof ZoneViolation) return { jsonrpc: "2.0", id, error: { code: -32001, message: e.message } };
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e).slice(0, 200) } };
  }
}
