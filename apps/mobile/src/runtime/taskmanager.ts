/**
 * expo-task-manager is the only way expo-notifications can run JS for a notification ACTION while the app is
 * closed (Android: NotificationsService -> FirebaseMessagingDelegate.runTaskManagerTasks). It is loaded
 * optionally so web/unit builds still work; release builds ship it (confirmed by the headless Confirm test).
 * When absent every action opens the app instead (see notif-task.ts, docs/plan/notifications-runtime.md).
 */
export interface TaskManagerLike {
  defineTask(name: string, executor: (body: { data: unknown; error: unknown; executionInfo?: unknown }) => unknown): void;
  isTaskDefined?(name: string): boolean;
}

let cached: TaskManagerLike | null | undefined;

export function getTaskManager(): TaskManagerLike | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("expo-task-manager") as TaskManagerLike | undefined;
    cached = m && typeof m.defineTask === "function" ? m : null;
  } catch { cached = null; }
  return cached;
}

export const taskManagerAvailable = (): boolean => getTaskManager() != null;
