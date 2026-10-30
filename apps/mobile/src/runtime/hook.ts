import { useEffect } from "react";
import { AppState } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { runForegroundCycle } from "./cycle";
import { processModelCandidates } from "../ai/sms-worker";
import { attachNotificationResponses } from "./response";

export const TICK_MS = 60_000;

/**
 * The single hook App.tsx calls. While the app is foregrounded: one cycle now, one on every resume, one per 60 s tick,
 * plus notification-response handling (cold start + live). `db` null = ledger not ready yet (does nothing).
 */
export function useRuntime(db: SQLiteDatabase | null): void {
  useEffect(() => {
    if (!db) return;
    let alive = true;
    const run = (force = false) => {
      if (!alive) return;
      void runForegroundCycle(db, { force })
        // F2: two candidates per tick, foreground only, serialised inside the worker.
        .then(() => (force ? processModelCandidates(db, 3) : processModelCandidates(db, 2)))
        .catch(() => undefined);
    };
    run(true);
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => run(), TICK_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") { run(); if (!timer) timer = setInterval(() => run(), TICK_MS); }
      else if (timer) { clearInterval(timer); timer = null; } // no ticking in the background; scheduled notifications cover that
    });
    const detach = attachNotificationResponses(() => db);
    return () => { alive = false; if (timer) clearInterval(timer); sub.remove(); detach(); };
  }, [db]);
}
