/**
 * App-lock state machine (C2). Pure and deterministic: the app feeds it AppState transitions and auth results with
 * timestamps and renders from the returned state. No timers here; "should I lock now?" is computed on foreground.
 *
 * Rules:
 *  - Disabled lock never locks and never blanks.
 *  - Lock on resume when the app was away for >= timeoutMs (0 = lock whenever it leaves the foreground).
 *  - Time away is measured on the wall clock; a clock moved backwards counts as "away long enough" (fail closed).
 *  - System dialogs the app itself launches (biometric prompt, permission dialogs, camera, pickers) background the
 *    app. They are bracketed with `external-begin`/`external-end` and never start the away clock.
 *  - Content is blanked as soon as the app leaves the foreground (so the recents thumbnail is empty) even if the
 *    timeout has not elapsed, and stays blank until the foreground check decides locked / unlocked.
 *  - Cold start with the lock enabled starts locked.
 */
export type LockTimeout = 0 | 30_000 | 60_000 | 300_000;
export const LOCK_TIMEOUTS: Array<{ ms: LockTimeout; label: string }> = [
  { ms: 0, label: "Immediately" },
  { ms: 30_000, label: "30 seconds" },
  { ms: 60_000, label: "1 minute" },
  { ms: 300_000, label: "5 minutes" },
];
export const DEFAULT_LOCK_TIMEOUT: LockTimeout = 30_000;

export interface LockConfig { enabled: boolean; timeoutMs: number; strict: boolean }
export const DEFAULT_LOCK_CONFIG: LockConfig = { enabled: false, timeoutMs: DEFAULT_LOCK_TIMEOUT, strict: false };

export interface LockState {
  locked: boolean;
  /** true while the app is not in the foreground (drives the blank cover) */
  away: boolean;
  /** wall-clock ms when the app left the foreground, null while foreground */
  awayAt: number | null;
  /** count of in-flight app-initiated system activities (prompts, pickers) */
  external: number;
  /** consecutive failed/cancelled unlock attempts since the last success */
  failures: number;
}

export type LockEvent =
  | { type: "background"; at: number }
  | { type: "foreground"; at: number }
  | { type: "external-begin" }
  | { type: "external-end" }
  | { type: "unlock-ok" }
  | { type: "unlock-fail" }
  | { type: "lock-now" }
  | { type: "config"; enabled: boolean };

export function initialLockState(cfg: LockConfig): LockState {
  return { locked: cfg.enabled, away: false, awayAt: null, external: 0, failures: 0 };
}

export function lockReduce(s: LockState, e: LockEvent, cfg: LockConfig): LockState {
  switch (e.type) {
    case "external-begin": return { ...s, external: s.external + 1 };
    case "external-end": return { ...s, external: Math.max(0, s.external - 1) };
    case "background":
      if (s.external > 0 || s.away) return s; // our own prompt/picker, or already away
      return { ...s, away: true, awayAt: e.at };
    case "foreground": {
      if (!s.away) return s;
      const base = { ...s, away: false, awayAt: null };
      if (!cfg.enabled || s.locked) return base;
      const gone = s.awayAt == null ? Infinity : e.at - s.awayAt;
      const expired = gone < 0 || gone >= cfg.timeoutMs;
      return expired ? { ...base, locked: true } : base;
    }
    case "unlock-ok": return { ...s, locked: false, failures: 0 };
    case "unlock-fail": return { ...s, failures: s.failures + 1 };
    case "lock-now": return cfg.enabled ? { ...s, locked: true } : s;
    case "config": return e.enabled ? s : { ...s, locked: false, failures: 0 };
  }
}

/** True when the UI must cover everything: locked, or backgrounded with the lock on. */
export function shouldBlank(s: LockState, cfg: LockConfig): boolean {
  return cfg.enabled && (s.locked || (s.away && s.external === 0));
}

/** Strict vault defers ingestion *UI* (counts, feed refresh, notifications text) while locked. Capture still persists natively. */
export function deferIngestionUi(s: LockState, cfg: LockConfig): boolean {
  return cfg.enabled && cfg.strict && s.locked;
}

export function clampTimeout(ms: number): LockTimeout {
  const allowed = LOCK_TIMEOUTS.map((t) => t.ms);
  return (allowed.includes(ms as LockTimeout) ? ms : DEFAULT_LOCK_TIMEOUT) as LockTimeout;
}
