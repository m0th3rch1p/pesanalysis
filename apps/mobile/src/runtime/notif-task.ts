import * as Notifications from "expo-notifications";
import { getLedger } from "../db/ledger";
import { handleNotificationResponse, isResponse } from "./response";
import { getTaskManager } from "./taskmanager";

export const NOTIFICATION_TASK = "YAKO_NOTIFICATION_RESPONSE";

/**
 * Module-scope registration (imported from headless.ts, which index.ts loads first). With expo-task-manager present,
 * pressing a background action ("Note" inline reply, Snooze, Not useful) while the app is closed or backgrounded
 * runs this task and writes to the ledger without opening the UI. Without it this is a no-op and those actions
 * open the app instead (they are registered with opensAppToForeground=true in that case).
 */
export function registerNotificationTask(): boolean {
  const tm = getTaskManager();
  if (!tm) return false;
  try {
    tm.defineTask(NOTIFICATION_TASK, async ({ data, error }) => {
      if (error || !isResponse(data)) return;
      try { await handleNotificationResponse(getLedger().db, data, "task"); } catch (e) { console.error(`[yako] notification task FAILED: ${String(e)}`); }
    });
    void Notifications.registerTaskAsync(NOTIFICATION_TASK).catch(() => undefined);
    return true;
  } catch { return false; }
}

registerNotificationTask();
