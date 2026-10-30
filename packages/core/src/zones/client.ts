/**
 * Minimal live Z1 client. The phone pushes an allowlisted snapshot or a JSON-RPC MCP
 * request to a host the user controls. Bearer token is supplied by the caller; this
 * module never stores it and never reads SMS bodies/notes/locations.
 */
import type { McpRequest, McpResponse } from "./mcp.js";
import type { Z1Snapshot } from "./hosts.js";

export interface Z1Endpoint { baseUrl: string; token: string; timeoutMs?: number }

function base(ep: Z1Endpoint): string { return ep.baseUrl.replace(/\/+$/, ""); }

async function post<T>(ep: Z1Endpoint, path: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ep.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(`${base(ep)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ep.token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`host HTTP ${res.status}`);
    return await res.json() as T;
  } finally { clearTimeout(timer); }
}

export async function z1Health(ep: Z1Endpoint, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; name?: string; version?: string }> {
  const res = await fetchImpl(`${base(ep)}/health`, {
    headers: { authorization: `Bearer ${ep.token}` },
  });
  if (!res.ok) throw new Error(`host HTTP ${res.status}`);
  return await res.json() as { ok: boolean; name?: string; version?: string };
}

export async function z1Mcp(ep: Z1Endpoint, req: McpRequest, fetchImpl: typeof fetch = fetch): Promise<McpResponse> {
  const out = await post<McpResponse>(ep, "/mcp", { jsonrpc: "2.0", id: req.id ?? 1, ...req }, fetchImpl);
  if (out.error) throw new Error(out.error.message);
  return out;
}

export async function z1PushSnapshot(ep: Z1Endpoint, snapshot: Z1Snapshot, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; rows: number }> {
  return post<{ ok: boolean; rows: number }>(ep, "/snapshot", snapshot, fetchImpl);
}

/** Convenience for the UI: initialize + tools/list in one round trip. */
export async function z1Test(ep: Z1Endpoint, fetchImpl: typeof fetch = fetch): Promise<{ server: string; tools: string[] }> {
  const init = await z1Mcp(ep, { id: 1, method: "initialize" }, fetchImpl);
  const info = init.result as { serverInfo?: { name?: string } } | undefined;
  const list = await z1Mcp(ep, { id: 2, method: "tools/list" }, fetchImpl);
  const tools = ((list.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name);
  return { server: info?.serverInfo?.name ?? "Z1 host", tools };
}

export async function z1Call(ep: Z1Endpoint, name: string, args: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<string> {
  const out = await z1Mcp(ep, { id: 3, method: "tools/call", params: { name, arguments: args } }, fetchImpl);
  const content = (out.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  return content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(out.result);
}
