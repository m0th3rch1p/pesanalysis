const t0 = Date.now();

/** Release-safe cold-start timing. Values only; never log ledger content. */
export function startup(label: string, detail?: string | number): void {
  try {
    const suffix = detail == null ? "" : ` ${detail}`;
    console.log(`[startup] +${Date.now() - t0}ms ${label}${suffix}`);
  } catch { /* logging must never break a launch */ }
}
