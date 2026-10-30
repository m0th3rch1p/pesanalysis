/**
 * Provider presets for the Assistant connection (docs/plan/09). Pure data + validation; no React,
 * no network, no storage. A preset only pre-fills the form and fixes the network class that the
 * core egress client enforces (cloud = https + public host; lan = declared LAN/private host;
 * loopback = this phone, e.g. through `adb reverse`).
 */
import { assertEndpointPolicy, AssistantError, parseEndpoint, type Preset } from "@yako/core";

export interface ProviderPreset {
  id: string;
  label: string;
  netClass: Preset;
  baseUrl: string;
  /** Placeholder only; the user must type the model name they actually have access to. */
  modelHint: string;
  needsKey: boolean;
  /** One plain sentence on who receives the data. Shown before anything is sent. */
  recipient: string;
  /** What the provider may do with it: terms vary, the user decides. Plain text, not a link we open. */
  termsNote: string;
  warning?: string;
}

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: "qvac-lan", label: "Local QVAC (qvac serve) on my network", netClass: "lan",
    baseUrl: "https://my-laptop.example.lan/v1", modelHint: "model name your server exposes", needsKey: false,
    recipient: "A computer on your own network that you control.",
    termsNote: "No third party, provided the machine is yours.",
    warning: "Declared LAN. Android blocks plain http to LAN addresses in this build (only localhost is cleartext-allowed), so use https, a VPN name with a valid certificate, or the 'This phone' preset with adb reverse.",
  },
  {
    id: "loopback", label: "This phone (localhost, e.g. adb reverse)", netClass: "loopback",
    baseUrl: "http://127.0.0.1:8080/v1", modelHint: "model name your server exposes", needsKey: false,
    recipient: "A server on this phone, or a computer tunnelled to it with adb reverse.",
    termsNote: "No third party. Also the route used for the device proxy test (docs/plan/assistant-proxy-test.md).",
  },
  {
    id: "openai", label: "OpenAI", netClass: "cloud",
    baseUrl: "https://api.openai.com/v1", modelHint: "e.g. gpt-4o-mini", needsKey: true,
    recipient: "OpenAI servers.",
    termsNote: "Retention and training rules depend on your account and OpenAI's current API terms. Read them on openai.com before sending.",
  },
  {
    id: "anthropic", label: "Anthropic (OpenAI-compatible endpoint) or a gateway", netClass: "cloud",
    baseUrl: "https://api.anthropic.com/v1", modelHint: "model id from your Anthropic account", needsKey: true,
    recipient: "Anthropic servers, or whichever gateway host you enter.",
    termsNote: "Retention and training rules depend on the provider's current terms. If you use a third-party gateway, the gateway operator also sees the data.",
    warning: "Compatibility endpoints can differ from the native API. Use Test connection first.",
  },
  {
    id: "openrouter", label: "OpenRouter", netClass: "cloud",
    baseUrl: "https://openrouter.ai/api/v1", modelHint: "e.g. vendor/model-name", needsKey: true,
    recipient: "OpenRouter, which forwards the request to the model vendor you pick.",
    termsNote: "Two parties see the data: OpenRouter and the underlying vendor. Each has its own retention rules.",
  },
  {
    id: "self-hosted", label: "Self-hosted over the internet (https)", netClass: "cloud",
    baseUrl: "https://llm.example.com/v1", modelHint: "model name your server exposes", needsKey: false,
    recipient: "The server at the address you enter.",
    termsNote: "You are responsible for who operates it and what it logs.",
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export interface AssistantSettings {
  presetId: string;
  baseUrl: string;
  model: string;
  /** User-lowered usage caps (the core client has its own ceilings). */
  callsPerDay: number;
  tokensPerDay: number;
}

export const CAP_LIMITS = { callsPerDay: { min: 1, max: 200, def: 20 }, tokensPerDay: { min: 1_000, max: 1_000_000, def: 100_000 } } as const;

export function clampCap(kind: keyof typeof CAP_LIMITS, v: number): number {
  const l = CAP_LIMITS[kind];
  return Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, Math.round(v))) : l.def;
}

export type SettingsCheck = { ok: true; hostKey: string; netClass: Preset } | { ok: false; reason: string };

const REASONS: Record<string, string> = {
  bad_base_url: "That is not a valid http(s) address. Use the form https://host/v1 with no query or credentials.",
  https_required: "Internet providers must use https.",
  private_range_for_cloud: "That address is on a private network. Pick a local preset to declare it, or use a public https address.",
  not_loopback: "This preset only accepts localhost / 127.0.0.1.",
  not_lan_address: "A local-network preset only accepts a private or loopback address or a .lan/.local/.internal name.",
  host_not_allowlisted: "Host is not allowlisted.",
};

/** Checks a form against the same egress policy the client enforces, before anything is stored. */
export function checkSettings(s: Pick<AssistantSettings, "presetId" | "baseUrl" | "model">): SettingsCheck {
  const preset = presetById(s.presetId);
  if (!preset) return { ok: false, reason: "Choose a provider preset." };
  if (!s.model.trim() || s.model.length > 120 || /[\u0000-\u001f]/.test(s.model)) return { ok: false, reason: "Enter the model name (up to 120 characters)." };
  const ep = parseEndpoint(s.baseUrl);
  if (!ep) return { ok: false, reason: REASONS.bad_base_url! };
  try { assertEndpointPolicy(ep, preset.netClass, [ep.hostKey]); }
  catch (e) { return { ok: false, reason: REASONS[e instanceof AssistantError ? e.code : ""] ?? "Address rejected by the network policy." }; }
  return { ok: true, hostKey: ep.hostKey, netClass: preset.netClass };
}
