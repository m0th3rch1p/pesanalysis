import { Linking } from "react-native";
import { parseDeepLink, type DeepLink } from "@yako/core";

/**
 * Deep-link router for yako://tx/<id>[?capture=photo|voice|detail] and yako://plan/<id> | plan/<section>[/<id>] (+ screens).
 * App.tsx supplies one `LinkTargets` implementation; everything else (notifications, widgets, system VIEW intents)
 * calls `routeUrl`. Links that arrive before the UI is mounted (cold start, headless) are held and flushed on register.
 */
export interface LinkTargets {
  /** Open the transaction detail; `capture` asks the sheet to start the photo/voice flow bound to that transaction. */
  openTx(txId: number, capture: "detail" | "photo" | "voice" | "media" | null): void;
  /** `section`: due | budgets | fuliza | savings | decisions | "" ; `id` = occurrence/budget/etc. id from the alert rule. */
  openPlan(section: string, id: number | null): void;
  openScreen(screen: string, rest: string[]): void;
  openAlert(alertId: number): void;
}

let targets: LinkTargets | null = null;
let pending: DeepLink | null = null;

function dispatch(l: DeepLink): boolean {
  if (!targets) { pending = l; return false; }
  switch (l.kind) {
    case "tx": targets.openTx(l.txId, l.capture); return true;
    case "plan": targets.openPlan(l.section, l.id); return true;
    case "alert": targets.openAlert(l.alertId); return true;
    case "screen": targets.openScreen(l.screen, l.rest); return true;
    default: return false;
  }
}

/** True when handled now; false when unknown or held until a target registers. Never throws. */
export function routeUrl(url: string | null | undefined): boolean {
  try { return dispatch(parseDeepLink(url)); } catch { return false; }
}

/**
 * Register the UI targets, flush a held link, and subscribe to system VIEW intents (cold start + warm).
 * Returns the unsubscribe. Call once from App.tsx after navigation is ready.
 */
export function registerLinkRouter(t: LinkTargets): () => void {
  targets = t;
  if (pending) { const p = pending; pending = null; dispatch(p); }
  Linking.getInitialURL().then((u) => { if (u) routeUrl(u); }).catch(() => undefined);
  const sub = Linking.addEventListener("url", (e) => { routeUrl(e.url); });
  return () => { if (targets === t) targets = null; sub.remove(); };
}
