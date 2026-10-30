import { AppRegistry } from "react-native";
import { drainDurable } from "./capture-queue";
import { getLedger } from "./db/ledger";
import "./notify"; // installs the foreground notification handler
import "./runtime/notif-task"; // background notification-action task (needs expo-task-manager; no-op without it)

export const HEADLESS_TASK = "YakoSmsTask";

/**
 * Runs without the UI (Kotlin receiver -> HeadlessJsTaskService). Persist-first:
 * SmsReceiver already wrote the raw SMS to SharedPreferences, so a crash here
 * loses only the notification, never the transaction.
 */
async function task(_data: Record<string, unknown>): Promise<void> {
  try {
    const stats = await drainDurable(getLedger().db);
    // drainDurable already ran runAfterIngest (capture tiers, alerts, scheduling) before resolving
    if (!stats) return;
    console.log(`[yako] headless ingest read=${stats.read} stored=${stats.stored} skipped=${stats.skipped} ask=${stats.ask} auto=${stats.auto}`);
  } catch (e) {
    console.error(`[yako] headless FAILED: ${String(e)}`);
    throw e;
  }
}

AppRegistry.registerHeadlessTask(HEADLESS_TASK, () => task);
