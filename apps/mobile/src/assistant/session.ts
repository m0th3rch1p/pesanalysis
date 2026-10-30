import * as SQLite from "expo-sqlite";
import {
  buildZ2Payload, createAssistantClient, ensureAssistantTables, migrate, parseEndpoint,
  type AssistantCall, type Z2Payload,
} from "@yako/core";
import { randomHex } from "../../modules/yako-sms";
import { asDbAdapter } from "../db/open";
import { presetById, type AssistantSettings } from "./presets";
import { readApiKey } from "./store";

export type AssistantClient = ReturnType<typeof createAssistantClient>;

export const newSessionId = (): string => `s${randomHex(8)}`;

/** Builds the (single-host, pinned) egress client. Throws AssistantError when settings violate policy. */
export function makeClient(s: AssistantSettings, db: SQLite.SQLiteDatabase): AssistantClient {
  const preset = presetById(s.presetId);
  const ep = parseEndpoint(s.baseUrl);
  if (!preset || !ep) throw new Error("not_configured");
  const adapter = asDbAdapter(db);
  ensureAssistantTables(adapter);
  return createAssistantClient(
    {
      baseUrl: s.baseUrl.trim(), allowedHosts: [ep.hostKey], preset: preset.netClass, model: s.model.trim(),
      // Keyless presets never read or send a stored key.
      getApiKey: preset.needsKey ? readApiKey : undefined,
      caps: { callsPerDay: s.callsPerDay, tokensPerDay: s.tokensPerDay },
      // No tools are offered in v1: Ask-via-model and the tool loop are WS-G5, not shipped here.
      allowedTools: [],
    },
    // No logger: the audit table is the only record. `fetch` is only referenced when `send` runs.
    { fetch: (input, init) => fetch(input, init), db: adapter },
  );
}

/**
 * Payload for "Test connection". Built from a throw-away EMPTY in-memory ledger, so it is
 * structurally non-personal (no cells, no goals); the question text is a fixed canned prompt.
 */
export function buildTestCall(sessionId: string): AssistantCall {
  const mem = SQLite.openDatabaseSync(":memory:");
  let payload: Z2Payload;
  try {
    const a = asDbAdapter(mem);
    migrate(a);
    payload = buildZ2Payload(a, { granted: true, sessionId, capabilities: [] });
  } finally { try { mem.closeSync(); } catch { /* ignore */ } }
  return { mode: "ask", purpose: "test:connection", sessionId, payload, userText: "Connectivity test with no personal data. Reply with the single word: ok" };
}

/** Real-ledger payload for Personalize, from the user's own typed goals. Nothing is sent by building it. */
export function buildPersonalizeCall(db: SQLite.SQLiteDatabase, sessionId: string, goals: string[], note: string): AssistantCall {
  const payload = buildZ2Payload(asDbAdapter(db), {
    granted: true, sessionId, goals: goals.map((text, i) => ({ id: `g${i + 1}`, text })),
  });
  return {
    mode: "personalize", purpose: "personalize:pack", sessionId, payload,
    userText: note.trim() || "Suggest a starting setup from my goals and these summaries.",
  };
}

const ERRORS: Record<string, string> = {
  kill_switch: "The kill switch is on. Nothing can be sent.",
  consent_required: "Consent expired or the preview changed. Review the preview again.",
  daily_call_cap: "Daily request cap reached.", daily_token_cap: "Daily token cap reached.", session_call_cap: "Session request cap reached.",
  backoff: "Waiting after a recent failure. Try again shortly.", session_aborted: "Session stopped after repeated violations.",
  timeout: "The server did not answer in time.", network_error: "Could not reach the server.",
  redirect_blocked: "The server tried to redirect. Redirects are refused.", response_host_mismatch: "The answer came from a different host. Refused.",
  response_too_large: "The answer was too large. Refused.", bad_content_type: "The server did not answer with JSON.",
  http_401: "The server rejected the key (401).", http_403: "The server refused access (403).", http_404: "Endpoint or model not found (404).", http_429: "Rate limited by the server (429).",
  private_range_for_cloud: "Internet preset points at a private address.", dns_private_range: "That name resolves to a private address.",
  key_unavailable: "Could not read the saved key.", https_required: "https is required for this preset.",
};
export function explainError(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  return ERRORS[code] ?? (code.startsWith("bad_json") ? "The server answer was not valid JSON." : `Failed: ${code.slice(0, 60)}`);
}
