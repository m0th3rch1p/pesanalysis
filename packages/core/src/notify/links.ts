/** Deep links (yako://...). Pure parser; the app maps the result onto navigation. */
export type DeepLink =
  | { kind: "tx"; txId: number; capture: "detail" | "photo" | "voice" | "media" | null }
  | { kind: "plan"; section: string; id: number | null }
  | { kind: "alert"; alertId: number }
  | { kind: "screen"; screen: string; rest: string[] }
  | { kind: "unknown"; raw: string };

export const LINK_SCHEME = "yako";

export function alertLink(alertId: number): string {
  return `${LINK_SCHEME}://alert/${alertId}`;
}

export function txLink(txId: number, capture?: "detail" | "photo" | "voice" | "media"): string {
  return `${LINK_SCHEME}://tx/${txId}${capture ? `?capture=${capture}` : ""}`;
}

const SCREENS = new Set(["today", "feed", "plan", "analysis", "more", "security", "send", "needs-you", "week"]);

/** Never throws. Accepts `yako://tx/12?capture=photo`, `yako://plan/due/7`, `yako://plan/7`, `yako://today/float`. */
export function parseDeepLink(url: string | null | undefined): DeepLink {
  const raw = String(url ?? "");
  const m = /^yako:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(raw.trim());
  if (!m) return { kind: "unknown", raw };
  const segs = m[1]!.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = new Map<string, string>();
  for (const kv of (m[2] ?? "").split("&")) { if (!kv) continue; const [k, v = ""] = kv.split("="); query.set(k!, v); }
  const head = segs[0]?.toLowerCase();
  const isId = (s: string | undefined): s is string => !!s && /^\d+$/.test(s);
  if (head === "tx") {
    if (!isId(segs[1])) return { kind: "unknown", raw };
    const c = query.get("capture");
    return { kind: "tx", txId: Number(segs[1]), capture: c === "photo" || c === "voice" || c === "detail" || c === "media" ? c : null };
  }
  if (head === "alert") {
    if (isId(segs[1])) return { kind: "alert", alertId: Number(segs[1]) };
    return { kind: "unknown", raw };
  }
  if (head === "plan") {
    if (isId(segs[1])) return { kind: "plan", section: "due", id: Number(segs[1]) };
    return { kind: "plan", section: segs[1] ?? "", id: isId(segs[2]) ? Number(segs[2]) : null };
  }
  if (head && SCREENS.has(head)) return { kind: "screen", screen: head, rest: segs.slice(1) };
  return { kind: "unknown", raw };
}
