import * as SecureStore from "expo-secure-store";
import { DEFAULT_KDF, calibrateKdf, timeKdf, type KdfParams, type Rng } from "@yako/core";
import { randomHex } from "../../modules/yako-sms";

/** Native CSPRNG (Android SecureRandom). Hermes has no crypto global; Math.random is never used. */
export const rng: Rng = (n) => {
  const hex = randomHex(n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const KDF_KEY = "yako.backup.kdf";

function parse(s: string | null): KdfParams | null {
  if (!s) return null;
  try {
    const k = JSON.parse(s) as KdfParams;
    if (k.m >= 8192 && k.m <= 19456 && k.t >= 2 && k.t <= 3 && k.p === 1) return k;
  } catch { /* recalibrate */ }
  return null;
}

let inflight: Promise<KdfParams> | null = null;

/** Chosen Argon2id params for this device (cached). First call runs a one-time benchmark (a few seconds). */
export function getBackupKdf(): Promise<KdfParams> {
  inflight ??= (async () => {
    const cached = parse(await SecureStore.getItemAsync(KDF_KEY).catch(() => null));
    if (cached) return cached;
    try {
      const { kdf } = await calibrateKdf((k) => timeKdf(k));
      await SecureStore.setItemAsync(KDF_KEY, JSON.stringify(kdf)).catch(() => undefined);
      return kdf;
    } catch { return DEFAULT_KDF; }
  })();
  return inflight;
}
