import { openLedger, type Ledger } from "./open";

/**
 * One connection per JS runtime. The UI and the headless SMS task both call this,
 * so an SMS that arrives while the app is open reuses the same SQLite handle.
 */
let cached: Ledger | null = null;

export function getLedger(): Ledger {
  return (cached ??= openLedger());
}
