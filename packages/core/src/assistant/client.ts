/**
 * Assistant egress client (docs/plan/09 I-4, I-5, I-9, I-10, I-11, I-12, I-14).
 *
 * Plain `fetch` (injected) to ONE user-configured, pinned host. No third-party AI SDK.
 *
 *  I-9   host allowlist pinned from user config; https required (http only for loopback, or a LAN
 *        preset to a private address); no redirects followed (redirect:"manual", and any 3xx /
 *        redirected / cross-host response is refused unread); timeout; response size cap
 *        (content-length check + capped streaming read); cloud preset refuses private/loopback
 *        literals and, when a resolver is injected, hostnames that resolve to them.
 *  I-10  the API key is fetched per call from an injected getter, sent only as the Authorization
 *        header, and never written to the DB, the audit, the logger, or an error message.
 *  I-11  every attempt writes an `assistant_audit` row (host, model, mode, purpose, bytes, payload
 *        hash, field list, validation); the exact request body is retained locally (switchable) so
 *        the user can inspect it; the logger only ever receives metadata, never bodies.
 *  I-12  per-session consent bound to the sha256 of the exact preview; global kill switch (persisted)
 *        that also wipes retained payload text and invalidates earlier consents.
 *  I-14  per-session and per-day call caps, per-day token cap (reserved before the call, corrected
 *        after), exponential backoff after failures, `usageToday` for the visible counter.
 *  I-4/5 model output is data: control chars stripped, markdown links/images and URLs removed,
 *        HTML stripped, length capped; tool calls outside the closed allowlist, with oversized or
 *        schema-invalid arguments, are dropped and counted; enough violations abort the session.
 *  I-1   `send` only accepts payloads issued by `buildZ2Payload`.
 */
import type { DbAdapter } from "../db/migrate.js";
import { sha256Hex } from "../util/sha256.js";
import { StrictJsonError, canonicalJson, strictParseJson, utf8Length } from "./json.js";
import { extractJsonObject, parsePack, type PackVerdict, type ValidateContext } from "./pack-schema.js";
import { isIssuedPayload, serialiseZ2Payload, z2FieldList, type Z2Payload } from "./payload.js";
import { getAssistantState, setAssistantState } from "./tables.js";

export type Preset = "cloud" | "lan" | "loopback";
export type Mode = "ask" | "personalize";

export interface ToolDef { name: string; description: string; parameters: JsonSchema }
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number>;
  minimum?: number; maximum?: number; maxLength?: number; maxItems?: number;
  items?: JsonSchema;
}

export interface AssistantConfig {
  baseUrl: string;
  /** Pinned allowlist from the user's settings: "host" or "host:port". The base URL host must be in it. */
  allowedHosts: string[];
  preset: Preset;
  model: string;
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxOutputTokens?: number;
  caps?: { callsPerDay?: number; tokensPerDay?: number; callsPerSession?: number };
  /** Closed tool allowlist (default-deny). Names must also be supplied as ToolDefs per call. */
  allowedTools?: string[];
  maxToolViolations?: number;
  consentTtlMs?: number;
  /** Keep the exact request text in the local audit (I-11). Default true. */
  retainPayload?: boolean;
}
export type LogEvent = { event: string; host: string; status: string; purpose: string; bytesOut: number; bytesIn: number; auditId: number | null; code?: string };
export interface AssistantDeps {
  fetch: typeof fetch;
  db: DbAdapter;
  now?: () => number;
  /** Optional DNS resolver (platform-provided). Used for the cloud/LAN private-range check. */
  resolveHost?: (host: string) => Promise<string[]>;
  logger?: (e: LogEvent) => void;
}

export class AssistantError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AssistantError"; }
}

const DEFAULTS = {
  timeoutMs: 30_000, maxResponseBytes: 262_144, maxOutputTokens: 800,
  callsPerDay: 50, tokensPerDay: 200_000, callsPerSession: 20,
  maxToolViolations: 3, consentTtlMs: 30 * 60_000,
};
const EAT_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_TEXT_CHARS = 8_000;

// ----- endpoint parsing / classification -------------------------------------------------------
export interface Endpoint { scheme: "http" | "https"; host: string; port: number | null; hostKey: string; path: string }
export type NetClass = "loopback" | "private" | "public" | "name";

export function parseEndpoint(url: string): Endpoint | null {
  const m = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?((?:\/[A-Za-z0-9._~-]+)*)\/?$/.exec(url.trim());
  if (!m) return null;
  const host = m[2]!.toLowerCase();
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (/^(?:[0-9.]+|0x[0-9a-f.x]*)$/i.test(host) && !strictV4(host)) return null; // decimal/octal/hex IP tricks
  if (/(?:^|\.)0x/i.test(host)) return null;
  const scheme = m[1]!.toLowerCase() as "http" | "https";
  const defPort = scheme === "https" ? 443 : 80;
  const hostKey = port !== null && port !== defPort ? `${host}:${port}` : host;
  return { scheme, host, port, hostKey, path: m[4] ?? "" };
}
function strictV4(h: string): number[] | null {
  const p = h.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^(?:0|[1-9]\d{0,2})$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}
export function classifyHost(hostIn: string): NetClass {
  const host = hostIn.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = strictV4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return "loopback";
    if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
    if (a >= 224) return "private"; // multicast/reserved: never a legitimate cloud endpoint
    return "public";
  }
  if (host.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return classifyHost(mapped[1]!);
    if (host === "::1" || host === "::") return "loopback";
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return "private";
    return "public";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (/\.(?:local|lan|internal|home\.arpa|intranet|corp)$/.test(host) || !host.includes(".")) return "private";
  return "name";
}

/** Throws AssistantError when scheme/host/preset do not agree. */
export function assertEndpointPolicy(ep: Endpoint, preset: Preset, allowedHosts: readonly string[]): void {
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(ep.hostKey)) throw new AssistantError("host_not_allowlisted");
  const cls = classifyHost(ep.host);
  if (preset === "cloud") {
    if (cls === "loopback" || cls === "private") throw new AssistantError("private_range_for_cloud");
    if (ep.scheme !== "https") throw new AssistantError("https_required");
  } else if (preset === "loopback") {
    if (cls !== "loopback") throw new AssistantError("not_loopback");
  } else {
    // explicit LAN opt-in: loopback or private addresses only; http allowed here (and only here)
    if (cls !== "loopback" && cls !== "private") throw new AssistantError("not_lan_address");
  }
  if (ep.scheme === "http" && preset === "cloud") throw new AssistantError("https_required");
}

// ----- kill switch ------------------------------------------------------------------------------
export function isKilled(db: DbAdapter): boolean { return getAssistantState(db, "kill_switch") === "1"; }
export function killEpoch(db: DbAdapter): number { return Number(getAssistantState(db, "kill_epoch") ?? "0"); }
/** Engage/release the global kill switch. Engaging wipes retained payload text and invalidates earlier consents. */
export function setKillSwitch(db: DbAdapter, on: boolean, now = Date.now()): void {
  setAssistantState(db, "kill_switch", on ? "1" : "0", now);
  setAssistantState(db, "kill_epoch", String(killEpoch(db) + 1), now);
  if (on) db.run(`UPDATE assistant_audit SET payload_text = NULL`);
}

// ----- audit / usage ------------------------------------------------------------------------------
export interface AuditRow {
  id: number; at: number; host: string; model: string | null; mode: string; purpose: string; sessionId: string | null;
  payloadHash: string; bytesOut: number; bytesIn: number; fieldList: string[]; status: string; detail: string | null;
  validation: string | null; tokens: number; payloadText: string | null;
}
export function listAudit(db: DbAdapter, limit = 100): AuditRow[] {
  const rows = db.all(
    `SELECT id, at, host, model, mode, purpose, session_id AS sessionId, payload_hash AS payloadHash, bytes_out AS bytesOut, bytes_in AS bytesIn,
            field_list AS fieldList, status, detail, validation, tokens, payload_text AS payloadText
       FROM assistant_audit ORDER BY id DESC LIMIT ?`, [limit],
  ) as Array<Omit<AuditRow, "fieldList"> & { fieldList: string }>;
  return rows.map((r) => ({ ...r, fieldList: JSON.parse(r.fieldList) as string[] }));
}
/** User-initiated export of the audit (I-11). */
export function exportAudit(db: DbAdapter): string { return JSON.stringify(listAudit(db, 100_000), null, 2); }
export function deleteAudit(db: DbAdapter): void { db.run(`DELETE FROM assistant_audit`); }

const dayStart = (now: number): number => Math.floor((now + EAT_MS) / DAY_MS) * DAY_MS - EAT_MS;
export interface Usage { calls: number; tokens: number; callsCap: number; tokensCap: number }
export function usageToday(db: DbAdapter, now: number, caps: { callsPerDay?: number; tokensPerDay?: number } = {}): Usage {
  const r = db.get(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens FROM assistant_audit WHERE at >= ? AND status IN ('pending','ok','error')`,
    [dayStart(now)],
  ) as { calls: number; tokens: number };
  return { calls: Number(r.calls), tokens: Number(r.tokens), callsCap: caps.callsPerDay ?? DEFAULTS.callsPerDay, tokensCap: caps.tokensPerDay ?? DEFAULTS.tokensPerDay };
}

// ----- untrusted output handling ---------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Model text -> inert plain text: no markup, links, images or control characters. */
export function toPlainText(input: string): string {
  let s = String(input).slice(0, MAX_TEXT_CHARS * 2);
  s = s.replace(CTRL_KEEP_NL, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");               // markdown images
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");            // markdown links -> label only
  s = s.replace(/<\/?[a-zA-Z!][^>]*>/g, "");                // html
  s = s.replace(/\b(?:https?|ftp|file|data|javascript|vbscript|blob):[^\s<>\]]*/gi, "[link removed]");
  s = s.replace(/\bwww\.[^\s)>\]]*/gi, "[link removed]");
  return s.slice(0, MAX_TEXT_CHARS).trim();
}

export function validateArgs(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}:not_object`];
    const o = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${path}.${r}:required`);
    for (const k of Object.keys(o)) {
      if (!(k in props)) { if (schema.additionalProperties !== true) errs.push(`${path}.${k}:unknown_property`); continue; }
      errs.push(...validateArgs(props[k]!, o[k], `${path}.${k}`));
    }
  } else if (t === "string") {
    if (typeof value !== "string") return [`${path}:not_string`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}:too_long`);
    if (schema.maxLength === undefined && value.length > 256) errs.push(`${path}:too_long`);
  } else if (t === "number" || t === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) return [`${path}:not_${t}`];
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}:below_min`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}:above_max`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return [`${path}:not_boolean`];
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path}:not_array`];
    if (value.length > (schema.maxItems ?? 20)) errs.push(`${path}:too_many`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateArgs(schema.items!, v, `${path}[${i}]`)));
  } else errs.push(`${path}:schema_type_missing`);
  if (schema.enum && !schema.enum.includes(value as string | number)) errs.push(`${path}:not_in_enum`);
  return errs;
}

export interface ValidToolCall { id: string | null; name: string; args: Record<string, unknown> }
export interface AssistantResult {
  text: string;
  toolCalls: ValidToolCall[];
  droppedToolCalls: number;
  totalTokens: number;
  auditId: number;
}
export interface AssistantCall {
  mode: Mode;
  /** Short human-readable reason recorded in the audit, e.g. "ask:spending-summary". */
  purpose: string;
  sessionId: string;
  payload: Z2Payload;
  /** The user's own typed question/instructions (shown in the preview). Bounded to 500 chars. */
  userText?: string;
  tools?: ToolDef[];
}
export interface AssistantPreview { url: string; host: string; body: string; hash: string; bytes: number; fieldList: string[] }

const SYSTEM_PROMPTS: Record<Mode, string> = {
  ask: "You are a careful assistant for a personal finance app. You receive coarse, banded aggregates about one user. You never receive names, messages or transaction-level data. Answer briefly in plain text. Do not claim exact figures: only bands are provided. This is informational, not financial advice. You may only call the tools you are given.",
  personalize: "You help personalise a personal finance app. You receive coarse, banded aggregates and the user's own typed answers. Reply with ONE JSON object only, schema \"yako-pack/1\": keys schema, title, summary, categories, vocabulary, budgets, alerts, widgets, thresholds, questions, savings, obligations. Plain Latin text only. No URLs. You cannot change permissions, connections, safety alerts, fees or tariffs; such keys will be rejected.",
};

export function createAssistantClient(config: AssistantConfig, deps: AssistantDeps) {
  const ep = parseEndpoint(config.baseUrl);
  if (!ep) throw new AssistantError("bad_base_url");
  assertEndpointPolicy(ep, config.preset, config.allowedHosts);
  const cfg = {
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    callsPerDay: config.caps?.callsPerDay ?? DEFAULTS.callsPerDay,
    tokensPerDay: config.caps?.tokensPerDay ?? DEFAULTS.tokensPerDay,
    callsPerSession: config.caps?.callsPerSession ?? DEFAULTS.callsPerSession,
    maxToolViolations: config.maxToolViolations ?? DEFAULTS.maxToolViolations,
    consentTtlMs: config.consentTtlMs ?? DEFAULTS.consentTtlMs,
    retain: config.retainPayload ?? true,
  };
  const toolAllow = new Set(config.allowedTools ?? []);
  const now = deps.now ?? (() => Date.now());
  const url = `${ep.scheme}://${ep.host.includes(":") ? `[${ep.host.replace(/^\[|\]$/g, "")}]` : ep.host}${ep.port !== null ? `:${ep.port}` : ""}${ep.path}/chat/completions`;

  const consents = new Map<string, { hashes: Set<string>; expiresAt: number; epoch: number }>();
  const sessionCalls = new Map<string, number>();
  const sessionViolations = new Map<string, number>();
  let failures = 0;
  let backoffUntil = 0;

  const log = (e: LogEvent) => { try { deps.logger?.(e); } catch { /* logger must never break egress */ } };

  function buildBody(call: AssistantCall): string {
    const userText = (call.userText ?? "").normalize("NFKC").slice(0, 500);
    // eslint-disable-next-line no-control-regex
    const cleanUser = userText.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
    const tools = (call.tools ?? []).filter((t) => toolAllow.has(t.name));
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[call.mode] },
        { role: "user", content: canonicalJson({ summary: JSON.parse(serialiseZ2Payload(call.payload)), question: cleanUser || undefined }) },
      ],
      max_tokens: cfg.maxOutputTokens,
      temperature: 0,
      stream: false,
    };
    if (call.mode === "personalize") body.response_format = { type: "json_object" };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    return JSON.stringify(body);
  }

  /** The exact bytes that would be sent, for the "what leaves this phone" preview (I-11, I-12). */
  function preview(call: AssistantCall): AssistantPreview {
    if (!isIssuedPayload(call.payload)) throw new AssistantError("payload_not_issued");
    const body = buildBody(call);
    return { url, host: ep!.hostKey, body, hash: sha256Hex(body), bytes: utf8Length(body), fieldList: z2FieldList(call.payload) };
  }

  function grantConsent(sessionId: string, payloadHash: string): void {
    const c = consents.get(sessionId) ?? { hashes: new Set<string>(), expiresAt: 0, epoch: killEpoch(deps.db) };
    c.hashes.add(payloadHash);
    c.expiresAt = now() + cfg.consentTtlMs;
    c.epoch = killEpoch(deps.db);
    consents.set(sessionId, c);
  }
  function revokeConsent(sessionId?: string): void { if (sessionId === undefined) consents.clear(); else consents.delete(sessionId); }

  function audit(call: AssistantCall, hash: string, bytesOut: number, text: string | null, status: string, detail: string | null, tokens = 0): number {
    const res = deps.db.run(
      `INSERT INTO assistant_audit (at, host, model, mode, purpose, session_id, payload_hash, bytes_out, field_list, status, detail, tokens, payload_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now(), ep!.hostKey, config.model, call.mode, String(call.purpose).slice(0, 80), String(call.sessionId).slice(0, 64), hash, bytesOut,
        JSON.stringify(isIssuedPayload(call.payload) ? z2FieldList(call.payload) : []), status, detail, tokens, cfg.retain ? text : null],
    ) as { lastInsertRowid?: number | bigint } | undefined;
    return Number(res?.lastInsertRowid ?? (deps.db.get(`SELECT MAX(id) AS id FROM assistant_audit`) as { id: number }).id);
  }
  function finish(id: number, status: string, bytesIn: number, tokens: number, validation: string | null, detail: string | null): void {
    deps.db.run(`UPDATE assistant_audit SET status = ?, bytes_in = ?, tokens = ?, validation = ?, detail = ? WHERE id = ?`, [status, bytesIn, tokens, validation, detail, id]);
  }
  function blocked(call: AssistantCall, code: string, hash = "", bytesOut = 0): never {
    const id = audit(call, hash, bytesOut, null, "blocked", code);
    log({ event: "assistant_blocked", host: ep!.hostKey, status: "blocked", purpose: call.purpose, bytesOut, bytesIn: 0, auditId: id, code });
    throw new AssistantError(code);
  }

  async function dnsCheck(): Promise<void> {
    if (!deps.resolveHost || classifyHost(ep!.host) !== "name") return;
    let addrs: string[];
    try { addrs = await deps.resolveHost(ep!.host); } catch { throw new AssistantError("dns_failed"); }
    if (!addrs.length) throw new AssistantError("dns_failed");
    for (const a of addrs) {
      const c = classifyHost(a);
      if (config.preset === "cloud" && c !== "public") throw new AssistantError("dns_private_range");
      if (config.preset !== "cloud" && c === "public") throw new AssistantError("dns_public_for_lan");
    }
  }

  async function send(call: AssistantCall): Promise<AssistantResult> {
    if (!isIssuedPayload(call?.payload)) blocked(call ?? ({ mode: "ask", purpose: "invalid", sessionId: "" } as AssistantCall), "payload_not_issued");
    const prev = preview(call);
    const t0 = now();
    if (isKilled(deps.db)) blocked(call, "kill_switch", prev.hash, prev.bytes);
    if ((sessionViolations.get(call.sessionId) ?? 0) >= cfg.maxToolViolations) blocked(call, "session_aborted", prev.hash, prev.bytes);
    const consent = consents.get(call.sessionId);
    if (!consent || !consent.hashes.has(prev.hash) || consent.expiresAt < t0 || consent.epoch !== killEpoch(deps.db)) blocked(call, "consent_required", prev.hash, prev.bytes);
    if (t0 < backoffUntil) blocked(call, "backoff", prev.hash, prev.bytes);
    const usage = usageToday(deps.db, t0, cfg);
    if (usage.calls >= cfg.callsPerDay) blocked(call, "daily_call_cap", prev.hash, prev.bytes);
    const reserve = Math.ceil(prev.bytes / 3) + cfg.maxOutputTokens;
    if (usage.tokens + reserve > cfg.tokensPerDay) blocked(call, "daily_token_cap", prev.hash, prev.bytes);
    if ((sessionCalls.get(call.sessionId) ?? 0) >= cfg.callsPerSession) blocked(call, "session_call_cap", prev.hash, prev.bytes);
    try { await dnsCheck(); } catch (e) { blocked(call, e instanceof AssistantError ? e.code : "dns_failed", prev.hash, prev.bytes); }

    let key: string | undefined;
    try { key = await config.getApiKey?.(); } catch { blocked(call, "key_unavailable", prev.hash, prev.bytes); }

    sessionCalls.set(call.sessionId, (sessionCalls.get(call.sessionId) ?? 0) + 1);
    const id = audit(call, prev.hash, prev.bytes, prev.body, "pending", null, reserve);
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false; // set BEFORE abort so a fetch rejected by our own abort is reported as the timeout it is
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { timedOut = true; ctl.abort(); rej(new AssistantError("timeout")); }, cfg.timeoutMs); });
    // The audit row is settled exactly once: a late result after a timeout can never overwrite it.
    let settled = false;
    const fail = (codeIn: string, bytesIn = 0): never => {
      const code = timedOut ? "timeout" : codeIn;
      if (!settled) {
        settled = true;
        failures++;
        backoffUntil = now() + Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
        finish(id, "error", bytesIn, reserve, null, code);
        log({ event: "assistant_error", host: ep!.hostKey, status: "error", purpose: call.purpose, bytesOut: prev.bytes, bytesIn, auditId: id, code });
      }
      throw new AssistantError(code);
    };

    try {
      const work = (async (): Promise<AssistantResult> => {
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
        if (key) headers.authorization = `Bearer ${key}`;
        let res: Response;
        try {
          res = await deps.fetch(url, { method: "POST", headers, body: prev.body, redirect: "manual", signal: ctl.signal, credentials: "omit", cache: "no-store" } as RequestInit);
        } catch (e) {
          if (e instanceof AssistantError) throw e;
          return fail("network_error");
        }
        const type = (res as { type?: string }).type;
        if (res.status === 0 || (res.status >= 300 && res.status < 400) || type === "opaqueredirect" || (res as { redirected?: boolean }).redirected === true) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          return fail("redirect_blocked");
        }
        if (res.url) {
          const got = parseEndpoint(res.url.replace(/[?#].*$/, ""));
          if (!got || got.hostKey !== ep!.hostKey) { try { await res.body?.cancel(); } catch { /* ignore */ } return fail("response_host_mismatch"); }
        }
        if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return fail(`http_${res.status}`); }
        const ctype = res.headers.get("content-type") ?? "";
        if (!/\bjson\b/i.test(ctype)) { try { await res.body?.cancel(); } catch { /* ignore */ } return fail("bad_content_type"); }
        const declared = Number(res.headers.get("content-length") ?? "NaN");
        if (Number.isFinite(declared) && declared > cfg.maxResponseBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } return fail("response_too_large"); }

        const raw = await readCapped(res, cfg.maxResponseBytes);
        if (raw === null) return fail("response_too_large");
        const bytesIn = utf8Length(raw);
        let json: unknown;
        try { json = strictParseJson(raw, { maxBytes: cfg.maxResponseBytes, maxDepth: 12, maxNodes: 20_000 }); }
        catch (e) { return fail(`bad_json:${e instanceof StrictJsonError ? e.code : "parse"}`, bytesIn); }

        if (settled) throw new AssistantError("timeout"); // result arrived after the call was already settled
        const out = extractOutput(json, call, toolAllow, call.tools ?? []);
        settled = true;
        failures = 0;
        backoffUntil = 0;
        if (out.violations > 0) sessionViolations.set(call.sessionId, (sessionViolations.get(call.sessionId) ?? 0) + out.violations);
        const tokens = out.totalTokens > 0 ? out.totalTokens : Math.ceil((prev.bytes + bytesIn) / 4);
        finish(id, "ok", bytesIn, tokens, out.violations ? `rejected:tool_violations=${out.violations}` : "accepted", null);
        log({ event: "assistant_ok", host: ep!.hostKey, status: "ok", purpose: call.purpose, bytesOut: prev.bytes, bytesIn, auditId: id });
        return { text: out.text, toolCalls: out.calls, droppedToolCalls: out.violations, totalTokens: tokens, auditId: id };
      })();
      work.catch(() => undefined); // a late rejection after timeout must not become unhandled
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof AssistantError) {
        if (!settled) {
          settled = true;
          failures++;
          backoffUntil = now() + Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
          finish(id, "error", 0, reserve, null, e.code);
          log({ event: "assistant_error", host: ep!.hostKey, status: "error", purpose: call.purpose, bytesOut: prev.bytes, bytesIn: 0, auditId: id, code: e.code });
        }
        throw e;
      }
      if (!settled) { settled = true; finish(id, "error", 0, reserve, null, "internal_error"); }
      throw new AssistantError("internal_error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Personalize: one call, then the reply is parsed as an UNTRUSTED pack proposal. Nothing is applied here (I-13). */
  async function personalize(call: Omit<AssistantCall, "mode" | "tools">, ctx: ValidateContext = {}): Promise<{ result: AssistantResult; pack: PackVerdict }> {
    const result = await send({ ...call, mode: "personalize" });
    const json = extractJsonObject(result.text);
    const pack: PackVerdict = json ? parsePack(json, ctx) : { accepted: false, reasons: ["no_json_object_in_reply"] };
    deps.db.run(`UPDATE assistant_audit SET validation = ? WHERE id = ?`, [pack.accepted ? "accepted" : `rejected:${pack.reasons.slice(0, 3).join("|")}`.slice(0, 200), result.auditId]);
    return { result, pack };
  }

  return { send, personalize, preview, grantConsent, revokeConsent, url, host: ep.hostKey };
}

async function readCapped(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    return utf8Length(t) > cap ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

function extractOutput(json: unknown, _call: AssistantCall, allow: Set<string>, defs: ToolDef[]): { text: string; calls: ValidToolCall[]; violations: number; totalTokens: number } {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined;
  const msg = (choice?.message && typeof choice.message === "object" ? choice.message : {}) as Record<string, unknown>;
  const text = typeof msg.content === "string" ? toPlainText(msg.content) : "";
  const usage = (o.usage && typeof o.usage === "object" ? o.usage : {}) as Record<string, unknown>;
  const totalTokens = typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0 ? Math.floor(usage.total_tokens) : 0;
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const calls: ValidToolCall[] = [];
  let violations = Math.max(0, rawCalls.length - 8); // beyond 8 calls: all extras are violations
  const schemas = new Map(defs.map((d) => [d.name, d.parameters] as const));
  for (const tc of rawCalls.slice(0, 8)) {
    const t = (tc && typeof tc === "object" ? tc : {}) as Record<string, unknown>;
    const fn = (t.function && typeof t.function === "object" ? t.function : {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    const schema = schemas.get(name);
    if (!allow.has(name) || !schema) { violations++; continue; }
    if (typeof fn.arguments !== "string" || utf8Length(fn.arguments) > 2048) { violations++; continue; }
    let args: unknown;
    try { args = strictParseJson(fn.arguments, { maxBytes: 2048, maxDepth: 4, maxNodes: 100 }); } catch { violations++; continue; }
    if (validateArgs(schema, args).length) { violations++; continue; }
    calls.push({ id: typeof t.id === "string" ? t.id.slice(0, 64) : null, name, args: args as Record<string, unknown> });
  }
  return { text, calls, violations, totalTokens };
}
