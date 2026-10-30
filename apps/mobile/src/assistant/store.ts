/**
 * Assistant connection storage. Everything lives in expo-secure-store (Android Keystore-backed):
 *  - the API key (own item, never read back into UI state, never logged);
 *  - the non-secret settings JSON (endpoint, model, caps) so it stays out of SQLite and backups.
 * Nothing here touches the network, and nothing runs at import time: a never-configured app reads
 * no key and builds no client (docs/plan/09 I-10).
 */
import * as SecureStore from "expo-secure-store";
import { CAP_LIMITS, checkSettings, clampCap, type AssistantSettings } from "./presets";

const SETTINGS_KEY = "yako.assistant.settings";
const API_KEY = "yako.assistant.key";

export async function loadSettings(): Promise<AssistantSettings | null> {
  const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<AssistantSettings>;
    const s: AssistantSettings = {
      presetId: String(o.presetId ?? ""), baseUrl: String(o.baseUrl ?? ""), model: String(o.model ?? ""),
      callsPerDay: clampCap("callsPerDay", Number(o.callsPerDay ?? CAP_LIMITS.callsPerDay.def)),
      tokensPerDay: clampCap("tokensPerDay", Number(o.tokensPerDay ?? CAP_LIMITS.tokensPerDay.def)),
    };
    return checkSettings(s).ok ? s : null; // a tampered/corrupt record counts as "not configured"
  } catch { return null; }
}

export async function saveSettings(s: AssistantSettings): Promise<void> {
  const c = checkSettings(s);
  if (!c.ok) throw new Error(c.reason);
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify({
    ...s, baseUrl: s.baseUrl.trim(), model: s.model.trim(),
    callsPerDay: clampCap("callsPerDay", s.callsPerDay), tokensPerDay: clampCap("tokensPerDay", s.tokensPerDay),
  }));
}

export async function saveApiKey(key: string): Promise<void> {
  const k = key.trim();
  if (!k) return;
  if (k.length > 512 || /[\s\u0000-\u001f]/.test(k)) throw new Error("That does not look like an API key (no spaces or line breaks).");
  await SecureStore.setItemAsync(API_KEY, k);
}
export async function hasApiKey(): Promise<boolean> { return (await SecureStore.getItemAsync(API_KEY)) != null; }
/** Only the egress client's `getApiKey` callback reads this. */
export async function readApiKey(): Promise<string | undefined> { return (await SecureStore.getItemAsync(API_KEY)) ?? undefined; }

/** Removes the connection entirely (key + settings). Audit rows are handled separately. */
export async function forgetConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(API_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(SETTINGS_KEY).catch(() => undefined);
}
