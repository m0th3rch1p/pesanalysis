/** App-lock PIN hashing (C2). PBKDF2-SHA256 with a per-device salt; the hash is stored in SecureStore. */
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;
export const PIN_ITERATIONS = 60_000;

const te = new TextEncoder();
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomSaltHex = (rng: (n: number) => Uint8Array): string => hex(rng(16));

export function pinHash(pin: string, saltHex: string, iterations = PIN_ITERATIONS): string {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
  return hex(pbkdf2(sha256, te.encode(pin), salt, { c: iterations, dkLen: 32 }));
}

export function validPinShape(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin) && !/^(\d)\1+$/.test(pin) && !"0123456789".includes(pin);
}

/** Constant-time-ish comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function verifyPin(pin: string, saltHex: string, expectedHash: string, iterations = PIN_ITERATIONS): boolean {
  return sameHash(pinHash(pin, saltHex, iterations), expectedHash);
}

/** Progressive lockout: attempts 1-4 free, then 30 s, doubling to a 15 min cap. */
export function lockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (failedAttempts - 5));
}
