/**
 * Reminder ladder and the 2-day rule (F-REVIEWLOOP). Pure.
 * full:   first prompt, +2h, next morning (08:00 EAT), stale escalation at 48h.
 * single: first prompt, next morning, stale at 48h.
 * batch:  no interruptions (one daily digest elsewhere); stale at 48h like everything else.
 * Nothing is ever dropped: an unresolved item at 48h is stale and sits in the Needs-you queue until resolved.
 */
import { DAY_MS } from "../expect/eat.js";
import { HOUR_MS, MIN_MS, atMinuteOfDay, endOfDayEat, inQuietHours, nextQuietEnd, DEFAULT_QUIET, type QuietHours } from "../alerts/quiet.js";
import type { CaptureTier } from "./materiality.js";

export const STALE_AFTER_MS = 48 * HOUR_MS;
export const MORNING_MINUTE = 8 * 60;

export type LadderKind = "first" | "followup" | "morning" | "stale";
export interface LadderStep { index: number; kind: LadderKind; atMs: number }

function rawSteps(createdAt: number, tier: CaptureTier): Array<{ kind: LadderKind; atMs: number }> {
  const morning = atMinuteOfDay(endOfDayEat(createdAt), MORNING_MINUTE);
  const stale = createdAt + STALE_AFTER_MS;
  switch (tier) {
    case "full": return [{ kind: "first", atMs: createdAt }, { kind: "followup", atMs: createdAt + 2 * HOUR_MS }, { kind: "morning", atMs: morning }, { kind: "stale", atMs: stale }];
    case "single": return [{ kind: "first", atMs: createdAt }, { kind: "morning", atMs: morning }, { kind: "stale", atMs: stale }];
    case "batch": return [{ kind: "stale", atMs: stale }];
    case "none": return [];
  }
}

/** Ladder with every step moved out of quiet hours; steps that collapse onto the next one are dropped (never the stale step). */
export function buildLadder(createdAt: number, tier: CaptureTier, quiet: QuietHours = DEFAULT_QUIET): LadderStep[] {
  const adj = rawSteps(createdAt, tier).map((s) => ({ ...s, atMs: nextQuietEnd(s.atMs, quiet) }));
  const kept: Array<{ kind: LadderKind; atMs: number }> = [];
  for (let i = 0; i < adj.length; i++) {
    const nxt = adj[i + 1];
    if (nxt && adj[i]!.kind !== "stale" && adj[i]!.atMs >= nxt.atMs) continue;
    kept.push(adj[i]!);
  }
  return kept.map((s, index) => ({ index, ...s }));
}

export interface CaptureItem {
  txId: number;
  tier: CaptureTier;
  materiality: number;
  counterpartyKey: string | null;
  amountCents: number;
  createdAt: number;
  /** ladder steps already sent (including skipped ones) */
  stepsSent: number;
  resolvedAt: number | null;
  snoozeUntil: number | null;
  /** last time any prompt or digest mentioned this item */
  lastPromptAt: number | null;
  staleEscalatedAt: number | null;
}

export type NextStep =
  | { action: "done" }
  | { action: "wait"; untilMs: number | null }
  | { action: "prompt"; step: LadderStep; skipped: number }
  | { action: "stale_escalate"; step: LadderStep; skipped: number };

export const isStale = (it: Pick<CaptureItem, "createdAt" | "resolvedAt" | "tier">, nowMs: number): boolean =>
  it.resolvedAt == null && it.tier !== "none" && nowMs - it.createdAt >= STALE_AFTER_MS;

/**
 * What to do for one item at `nowMs`. If the device was off and several steps are overdue, only the latest due step
 * fires (earlier ones are reported in `skipped`), so catching up never sends a burst.
 */
export function nextCaptureStep(it: CaptureItem, nowMs: number, quiet: QuietHours = DEFAULT_QUIET): NextStep {
  if (it.resolvedAt != null || it.tier === "none") return { action: "done" };
  const ladder = buildLadder(it.createdAt, it.tier, quiet);
  if (it.stepsSent >= ladder.length) return { action: "wait", untilMs: null };
  if (it.snoozeUntil != null && it.snoozeUntil > nowMs) return { action: "wait", untilMs: it.snoozeUntil };
  let due = -1;
  for (let i = it.stepsSent; i < ladder.length; i++) if (ladder[i]!.atMs <= nowMs) due = i;
  if (due < 0) return { action: "wait", untilMs: ladder[it.stepsSent]!.atMs };
  if (inQuietHours(nowMs, quiet)) return { action: "wait", untilMs: nextQuietEnd(nowMs, quiet) };
  const step = ladder[due]!;
  if (step.kind === "stale" && it.staleEscalatedAt != null) return { action: "wait", untilMs: null };
  const skipped = due - it.stepsSent;
  return step.kind === "stale" ? { action: "stale_escalate", step, skipped } : { action: "prompt", step, skipped };
}

export interface NeedsYouEntry { item: CaptureItem; stale: boolean; ageMs: number }

/** The Needs-you queue: every unresolved item, stale first, then by materiality (desc), then oldest first. Nothing is hidden. */
export function buildNeedsYouQueue(items: CaptureItem[], nowMs: number): NeedsYouEntry[] {
  return items
    .filter((i) => i.resolvedAt == null && i.tier !== "none")
    .map((item) => ({ item, stale: isStale(item, nowMs), ageMs: nowMs - item.createdAt }))
    .sort((a, b) => +b.stale - +a.stale || b.item.materiality - a.item.materiality || a.item.createdAt - b.item.createdAt || a.item.txId - b.item.txId);
}

export interface CaptureGroup { counterpartyKey: string | null; count: number; totalCents: number; txIds: number[]; copy: string }

function groupBy(items: CaptureItem[], copy: (g: { count: number }) => string): CaptureGroup[] {
  const m = new Map<string, CaptureGroup>();
  for (const it of items) {
    const k = it.counterpartyKey ?? "";
    let g = m.get(k);
    if (!g) { g = { counterpartyKey: it.counterpartyKey, count: 0, totalCents: 0, txIds: [], copy: "" }; m.set(k, g); }
    g.count++; g.totalCents += it.amountCents; g.txIds.push(it.txId);
  }
  const out = [...m.values()].sort((a, b) => b.count - a.count || b.totalCents - a.totalCents || String(a.counterpartyKey).localeCompare(String(b.counterpartyKey)));
  for (const g of out) { g.txIds.sort((a, b) => a - b); g.copy = copy(g); }
  return out;
}

/** Items that just crossed 48h and have not been escalated, grouped by counterparty. Escalates once. */
export function staleEscalations(items: CaptureItem[], nowMs: number): CaptureGroup[] {
  const due = items.filter((i) => isStale(i, nowMs) && i.staleEscalatedAt == null);
  return groupBy(due, (g) => `${g.count} payment${g.count === 1 ? "" : "s"} still need details: add detail or mark done.`);
}

/** Daily batched confirmation for small auto-filed items, grouped by counterparty. */
export function batchDigest(items: CaptureItem[]): CaptureGroup[] {
  const open = items.filter((i) => i.tier === "batch" && i.resolvedAt == null && i.lastPromptAt == null);
  return groupBy(open, (g) => `${g.count} small payment${g.count === 1 ? "" : "s"} filed automatically. Tap to confirm.`);
}

export { DAY_MS, MIN_MS };
