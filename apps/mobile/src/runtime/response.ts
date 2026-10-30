import * as Notifications from "expo-notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import { addTxItem, confirmTxItems, learnItemPricesForTx, markAlert, markAlertUseful, NOTE_SAVED, NOTE_SAVED_DONE, parseNote, reindexTx, snoozeAlert, txLink } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { clearCaptureNotifications, presentNow, ACTION } from "./notifications";
import { snoozeHabitNudge } from "./nudges";
import { confirmSuggestedLabel, syncCaptureState } from "./capture";
import { routeUrl } from "./links";
import { bump } from "./obs";
import { taskManagerAvailable } from "./taskmanager";

export interface ResponseLike {
  notification: { request: { identifier: string; content: { data?: unknown } } };
  actionIdentifier: string;
  userText?: string;
}

export const isResponse = (x: unknown): x is ResponseLike =>
  !!x && typeof x === "object" && typeof (x as ResponseLike).actionIdentifier === "string" && !!(x as ResponseLike).notification?.request;

const SEEN_KEY = "notif_resp_seen_v1";

/**
 * The listener and the background task can both see one response (app process alive but backgrounded), and Android
 * can replay the last response on a cold start. One response must act once: remember the last handled keys.
 */
function claim(db: SQLiteDatabase, key: string): boolean {
  try {
    const row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [SEEN_KEY]);
    const seen: string[] = row ? JSON.parse(row.value) : [];
    if (seen.includes(key)) return false;
    seen.push(key);
    db.runSync(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [SEEN_KEY, JSON.stringify(seen.slice(-30))]);
    return true;
  } catch { return true; }
}

/** Append to an existing text note (a reply never overwrites what the user already wrote). */
export function addInlineNote(db: SQLiteDatabase, txId: number, text: string, now = Date.now()): boolean {
  const t = text.trim().slice(0, 500);
  if (!t) return false;
  const exists = db.getFirstSync<{ id: number }>(`SELECT id FROM transactions WHERE id = ?`, [txId]);
  if (!exists) return false;
  const prev = db.getFirstSync<{ id: number; text: string | null }>(`SELECT id, text FROM tx_notes WHERE tx_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1`, [txId]);
  const combined = prev?.text ? `${prev.text}\n${t}` : t;
  if (prev) db.runSync(`UPDATE tx_notes SET text = ? WHERE id = ?`, [combined, prev.id]);
  else db.runSync(`INSERT INTO tx_notes (tx_id, kind, text, created_at) VALUES (?, 'note', ?, ?)`, [txId, t, now]);
  const tx = db.getFirstSync<{ amount: number; direction: string; kind: string; template: string; cpName: string | null }>(
    `SELECT t.amount, t.direction, t.kind, t.template,
            COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName
       FROM transactions t LEFT JOIN counterparties c ON c.id = t.counterparty_id WHERE t.id = ?`, [txId],
  );
  if (tx) {
    const parsed = parseNote(combined, {
      direction: tx.direction === "in" ? "in" : "out", txAmountCents: tx.amount,
      interpretCtx: { direction: tx.direction === "in" ? "in" : "out", kind: tx.kind, template: tx.template, counterpartyName: tx.cpName },
    });
    if (parsed.items.length) {
      // Reparse the whole accumulated note; keep separately inferred/user items untouched.
      db.runSync(`DELETE FROM tx_items WHERE tx_id = ? AND source = 'note'`, [txId]);
      for (const it of parsed.items) {
        addTxItem(asDbAdapter(db), txId, { item: it.name, qty: it.qty, unit: it.unit, amountCents: it.amountCents, source: "note", confirmed: true }, now);
      }
      learnItemPricesForTx(asDbAdapter(db), txId, now);
    }
  }
  reindexTx(asDbAdapter(db), txId);
  return true;
}

type Data = { kind?: string; txId?: number; logId?: number; habitId?: number; url?: string | null };

/**
 * One handler for every notification interaction. `origin` = "task" runs without UI (no navigation, nothing assumed
 * about React state), "listener" runs inside the live app and may navigate.
 */
export async function handleNotificationResponse(db: SQLiteDatabase, r: ResponseLike, origin: "listener" | "task", now = Date.now()): Promise<{ handled: boolean }> {
  const d = (r.notification.request.content.data ?? {}) as Data;
  if (!d.kind) return { handled: false }; // not ours
  if (!claim(db, `${r.notification.request.identifier}|${r.actionIdentifier}|${r.userText ?? ""}`)) return { handled: false };
  const go = (url: string | null | undefined) => { if (origin === "listener" && url) routeUrl(url); };
  const adapter = asDbAdapter(db);
  const act = r.actionIdentifier;
  const tap = act === Notifications.DEFAULT_ACTION_IDENTIFIER;

  if (d.kind === "capture" && d.txId != null) {
    const id = d.txId;
    if (act === ACTION.note) {
      const saved = addInlineNote(db, id, r.userText ?? "", now);
      bump(db, saved ? "note_inline_saved" : "note_inline_failed");
      bump(db, "prompt_acted");
      try { await Notifications.dismissNotificationAsync(r.notification.request.identifier); } catch { /* gone */ }
      if (saved) {
        const { resolved } = syncCaptureState(db, now);
        if (resolved.includes(id)) await clearCaptureNotifications([id]);
        // Acknowledge (Android keeps a RemoteInput notification in a "sending" state until it is replaced)
        await presentNow({ id: `note-ack:${id}`, channel: "capture", ...(resolved.includes(id) ? NOTE_SAVED_DONE : NOTE_SAVED), data: { v: 1, kind: "capture", txId: id, step: "ack", url: txLink(id) } });
      }
      // Without expo-task-manager this action opened the app (limitation): land on the transaction to finish it.
      if (!taskManagerAvailable()) go(txLink(id));
      return { handled: true };
    }
    bump(db, "prompt_acted");
    if (act === ACTION.confirm) {
      const confirmed = confirmSuggestedLabel(db, id, now);
      // The guess may be item-level with no category suggestion; confirm both instead of silently doing nothing.
      let items = 0;
      try { items = confirmTxItems(adapter, id, now); if (items) learnItemPricesForTx(adapter, id, now); } catch { /* optional */ }
      const { resolved } = syncCaptureState(db, now);
      try { await Notifications.dismissNotificationAsync(r.notification.request.identifier); } catch { /* gone */ }
      if (confirmed.ok || items > 0) {
        bump(db, "guess_confirmed_inline");
        const thing = confirmed.label ?? `${items} item${items === 1 ? "" : "s"}`;
        if (resolved.includes(id)) await clearCaptureNotifications([id]);
        await presentNow({
          id: `confirm-ack:${id}`, channel: "capture",
          title: "Saved", body: `${thing} · this payment is filed.`,
          data: { v: 1, kind: "capture", txId: id, step: "ack", url: txLink(id) },
        });
      }
    }
    else if (act === ACTION.media) go(txLink(id, "media"));
    else if (act === ACTION.photo) go(txLink(id, "photo"));
    else if (act === ACTION.voice) go(txLink(id, "voice"));
    else if (act === ACTION.detail) go(txLink(id, "detail"));
    else if (tap) go(txLink(id));
    return { handled: true };
  }

  if (d.kind === "habit_nudge" && d.habitId != null) {
    const habitId = d.habitId;
    if (tap) { bump(db, "prompt_acted"); go(d.url); return { handled: true }; }
    const habit = db.getFirstSync<{ name: string }>(`SELECT name FROM habits WHERE id = ?`, [habitId]);
    try {
      db.runSync(
        `INSERT INTO alerts_log (rule_id, alert_key, dedupe_key, severity, title, body, redacted_body, delivered_at, acted_at)
         VALUES ('habit_nudge', ?, ?, 'low', ?, ?, ?, ?, ?)`,
        [`habit:${habitId}`, `habit:${habitId}:${Math.floor(now / 60_000)}`, habit?.name ?? "Habit nudge",
          act === ACTION.habitSnooze ? "Reminded in 1 hour." : "Marked handled.",
          "Habit nudge", now, now],
      );
    } catch { /* logging is best effort */ }
    if (act === ACTION.habitSnooze) { try { await snoozeHabitNudge(db, habitId, now); } catch { /* no schedule */ } }
    try { await Notifications.dismissNotificationAsync(r.notification.request.identifier); } catch { /* gone */ }
    bump(db, "prompt_acted");
    return { handled: true };
  }

  if (d.kind === "alert" && d.logId != null) {
    if (tap) { markAlert(adapter, d.logId, "opened", now); bump(db, "alert_opened"); bump(db, "prompt_acted"); go(d.url); }
    else if (act === ACTION.snooze) { snoozeAlert(adapter, d.logId, now + 86_400_000); markAlert(adapter, d.logId, "opened", now); bump(db, "prompt_dismissed"); }
    else if (act === ACTION.notUseful) { markAlertUseful(adapter, d.logId, false); markAlert(adapter, d.logId, "dismissed", now); bump(db, "prompt_dismissed"); }
    else { markAlert(adapter, d.logId, "acted", now); bump(db, "prompt_acted"); go(d.url); }
    try { await Notifications.dismissNotificationAsync(r.notification.request.identifier); } catch { /* gone */ }
    return { handled: true };
  }

  if (tap) { bump(db, "prompt_acted"); go(d.url); return { handled: true }; }
  return { handled: false };
}

/**
 * Cold start + live responses in the UI process. Returns the unsubscribe. `getDb` is lazy so the ledger is not opened
 * before it is needed. The background task (notif-task.ts) covers actions pressed while the app is closed.
 */
export function attachNotificationResponses(getDb: () => SQLiteDatabase): () => void {
  const run = (r: Notifications.NotificationResponse) => { void handleNotificationResponse(getDb(), r, "listener").catch(() => undefined); };
  Notifications.getLastNotificationResponseAsync().then((r) => { if (r) run(r); }).catch(() => undefined);
  const sub = Notifications.addNotificationResponseReceivedListener(run);
  return () => sub.remove();
}
