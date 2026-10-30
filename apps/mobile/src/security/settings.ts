import * as SecureStore from "expo-secure-store";
import type { SQLiteDatabase } from "expo-sqlite";
import { randomHex } from "../../modules/yako-sms";
import { PIN_ITERATIONS, lockoutMs, pinHash, randomSaltHex, validPinShape, verifyPin } from "@yako/core";

const K_SALT = "yako_pin_salt";
const K_HASH = "yako_pin_hash";
const K_ITER = "yako_pin_iter";
const K_FAILS = "yako_lock_fails";
const K_UNTIL = "yako_lock_until";
const M_ENABLED = "lock_enabled";
const M_TIMEOUT = "lock_timeout_ms";
const M_STRICT = "strict_vault";

export interface LockConfig { enabled: boolean; timeoutMs: number; strictVault: boolean; hasPin: boolean }
export const DEFAULT_TIMEOUT_MS = 30_000;

const metaGet = (db: SQLiteDatabase, k: string) => {
  try { return db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [k])?.value ?? null; } catch { return null; }
};
const metaSet = (db: SQLiteDatabase, k: string, v: string) => {
  try { db.runSync(`INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, v]); } catch { /* optional */ }
};

export async function getLockConfig(db: SQLiteDatabase): Promise<LockConfig> {
  const hasPin = !!(await SecureStore.getItemAsync(K_HASH));
  return {
    enabled: metaGet(db, M_ENABLED) === "1",
    timeoutMs: Number(metaGet(db, M_TIMEOUT) ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    strictVault: metaGet(db, M_STRICT) === "1",
    hasPin,
  };
}

export async function setPin(pin: string): Promise<void> {
  if (!validPinShape(pin)) throw new Error("Use 4-12 digits, not all the same, not 0123…");
  const salt = randomSaltHex((n) => Uint8Array.from(randomHex(n).match(/.{2}/g)!.map((h) => parseInt(h, 16))));
  const hash = pinHash(pin, salt, PIN_ITERATIONS);
  await SecureStore.setItemAsync(K_SALT, salt);
  await SecureStore.setItemAsync(K_HASH, hash);
  await SecureStore.setItemAsync(K_ITER, String(PIN_ITERATIONS));
}

export async function clearPin(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(K_SALT), SecureStore.deleteItemAsync(K_HASH), SecureStore.deleteItemAsync(K_ITER), SecureStore.deleteItemAsync(K_FAILS), SecureStore.deleteItemAsync(K_UNTIL)]);
}

export async function setLockConfig(db: SQLiteDatabase, patch: Partial<Omit<LockConfig, "hasPin">>): Promise<void> {
  if (patch.enabled != null) metaSet(db, M_ENABLED, patch.enabled ? "1" : "0");
  if (patch.timeoutMs != null) metaSet(db, M_TIMEOUT, String(Math.max(0, Math.floor(patch.timeoutMs))));
  if (patch.strictVault != null) metaSet(db, M_STRICT, patch.strictVault ? "1" : "0");
}

export async function lockedUntil(): Promise<number> {
  return Number((await SecureStore.getItemAsync(K_UNTIL)) ?? 0) || 0;
}

export async function attemptPin(pin: string): Promise<{ ok: boolean; waitMs: number; remaining: number }> {
  const until = await lockedUntil();
  if (until > Date.now()) return { ok: false, waitMs: until - Date.now(), remaining: 0 };
  const [salt, hash, iter] = await Promise.all([SecureStore.getItemAsync(K_SALT), SecureStore.getItemAsync(K_HASH), SecureStore.getItemAsync(K_ITER)]);
  if (!salt || !hash) return { ok: false, waitMs: 0, remaining: 5 };
  const ok = verifyPin(pin, salt, hash, Number(iter ?? PIN_ITERATIONS));
  const fails = Number((await SecureStore.getItemAsync(K_FAILS)) ?? 0);
  if (ok) {
    await Promise.all([SecureStore.deleteItemAsync(K_FAILS), SecureStore.deleteItemAsync(K_UNTIL)]);
    return { ok: true, waitMs: 0, remaining: 5 };
  }
  const next = fails + 1;
  const wait = lockoutMs(next);
  await SecureStore.setItemAsync(K_FAILS, String(next));
  if (wait > 0) await SecureStore.setItemAsync(K_UNTIL, String(Date.now() + wait));
  return { ok: false, waitMs: wait, remaining: Math.max(0, 5 - next) };
}
