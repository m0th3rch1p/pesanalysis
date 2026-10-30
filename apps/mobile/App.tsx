import { lazy, Suspense, useEffect, useRef, useState } from "react";
import * as Application from "expo-application";
import { AppState, StatusBar, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { drainDurable } from "./src/capture-queue";
import { runNightlyIfDue } from "./src/nightly";
import { ensureSearchIndex, getRetentionDays, markSearchIndexDirty, purgeSmsBodies } from "@yako/core";
import { pruneMissingAttachments } from "./src/media";
import { ensureNotificationPermission, ensureNotifyChannel, type NotificationState } from "./src/notify";
import { registerLinkRouter, useRuntime } from "./src/runtime";
import { catchUpInbox, ingestRows } from "./src/ingest-inbox";
import { getLedger } from "./src/db/ledger";
import { asDbAdapter } from "./src/db/open";
import { startup } from "./src/startup";
import { C, text } from "./src/ui";
import { Onboarding } from "./src/onboarding/Onboarding";
import { CaptureSheet } from "./src/capture/CaptureSheet";
import { AlertSheet } from "./src/security/AlertSheet";
import { repairHabitSelectors } from "@yako/core";
import { seedDemoLedger } from "./src/seed-demo";
import { AppLock } from "./src/security/AppLock";
import { getLockConfig, type LockConfig } from "./src/security/settings";
import { syncWeeklyReview } from "./src/runtime/weekly";
import { syncHabitNudges } from "./src/runtime/nudges";
import { Models } from "./src/onboarding/Models";
import { TabIcon, type TabIconName } from "./src/components/TabIcon";

type Tab = "today" | "feed" | "plan" | "analyse" | "review" | "more";

const FeedScreen = lazy(async () => ({ default: (await import("./src/screens/Feed")).FeedScreen }));
const TodayScreen = lazy(async () => ({ default: (await import("./src/screens/Today")).TodayScreen }));
const AnalyseScreen = lazy(async () => ({ default: (await import("./src/screens/Analyse")).AnalyseScreen }));
const ReviewScreen = lazy(async () => ({ default: (await import("./src/screens/Review")).ReviewScreen }));
const PlanScreen = lazy(async () => ({ default: (await import("./src/screens/plan/PlanScreen")).PlanScreen }));
const MoreScreen = lazy(async () => ({ default: (await import("./src/screens/More")).MoreScreen }));
const WeeklyReviewScreen = lazy(async () => ({ default: (await import("./src/screens/WeeklyReview")).WeeklyReviewScreen }));
// Developer-only Model lab: inlined build flag, absent (and tree-shaken) in normal builds.
const LabGate = process.env.EXPO_PUBLIC_YAKO_LAB === "1" ? lazy(() => import("./src/lab/LabGate")) : null;

function Root() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("today");
  const [focusTx, setFocusTx] = useState<number | null>(null);
  const [ledgerReady, setLedgerReady] = useState(false);
  const [lockChecked, setLockChecked] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockCfg, setLockCfg] = useState<LockConfig | null>(null);
  const lockedRef = useRef(false);
  const onboardedRef = useRef<boolean | null>(null);
  const lockRef = useRef<LockConfig | null>(null);
  const bgAt = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(0);
  const [notify, setNotifyState] = useState<NotificationState | null>(null);
  const [reviewLimit, setReviewLimit] = useState(1000);
  const [reviewOnboarding, setReviewOnboarding] = useState(false);
  const [capture, setCapture] = useState<{ id: number; mode: "detail" | "photo" | "voice" | "media" } | null>(null);
  const [alertId, setAlertId] = useState<number | null>(null);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const inboxBusy = useRef(false);
  const bump = () => setRefresh((n) => n + 1);
  onboardedRef.current = onboarded;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Never prompt before the user has seen context; onboarding owns the one request.
        const ns = await ensureNotificationPermission(false);
        setNotifyState(ns);
        if (ns.granted) await ensureNotifyChannel();
        const db = getLedger().db;

        // The demo APK seeds itself once, on first launch only. Require BOTH the build flag and the
        // demo package id: a stale inlined env var must never be able to wipe the live ledger.
        const isDemoPackage = Application.applicationId === "dev.yako.app.demo";
        const isDemoBuild = process.env.EXPO_PUBLIC_DEMO === "1" && isDemoPackage;
        if (isDemoBuild) {
          const seeded = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = 'demo_seeded_at'`)?.value;
          if (!seeded) {
            startup("seeding demo ledger");
            await seedDemoLedger(db);
          }
        }

        // Existing installs predate the onboarding flag. If the ledger already holds data, treat it
        // as onboarded instead of showing permission/import screens over the owner's real ledger.
        let row = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = 'onboarded'`);
        if (!row) {
          let existing = 0;
          try {
            existing = Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM sms_raw`)?.n ?? 0)
              + Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions`)?.n ?? 0);
          } catch { /* fresh schema */ }
          if (existing > 0) {
            db.runSync(`INSERT INTO meta (key,value) VALUES ('onboarded','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
            row = { value: "1" };
          }
        }
        const onboardedNow = row?.value === "1";
        if (alive) setOnboarded(onboardedNow);

        // Read the lock config before anything is rendered. A missing/disabled lock is a synchronous
        // meta check; an enabled lock awaits the Keystore, and the UI must stay gated until it returns.
        let cfg: LockConfig = { enabled: false, timeoutMs: 30_000, strictVault: false, hasPin: false };
        try {
          const enabled = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key = 'lock_enabled'`)?.value === "1";
          cfg = enabled ? await getLockConfig(db) : cfg;
        } catch { /* no lock available: continue with the default */ }
        lockRef.current = cfg;
        if (alive) { setLockCfg(cfg); setLockChecked(true); if (cfg.enabled) { lockedRef.current = true; setLocked(true); } }
        if (alive) setLedgerReady(true);

        if (ns.granted && onboardedNow) { void syncWeeklyReview(db); void syncHabitNudges(db); }
        startup("app db acquired");

        if (onboardedNow) {
          const drained = await drainDurable(db);
          if (drained) {
            markSearchIndexDirty(asDbAdapter(db));
            startup("queued sms ingested", drained.read);
          }

          // Catch messages whose SMS_RECEIVED broadcast never reached a stopped app.
          if (!inboxBusy.current) {
            inboxBusy.current = true;
            try {
              const caught = await catchUpInbox(db);
              if (caught.stored > 0) {
                markSearchIndexDirty(asDbAdapter(db));
                startup("inbox catch-up", caught.stored);
              }
            } catch { /* SMS permission or provider unavailable */ }
            finally { inboxBusy.current = false; }
          }
        }

        const adapter = asDbAdapter(db);
        try { repairHabitSelectors(adapter); } catch { /* additive repair */ }
        const days = getRetentionDays(adapter);
        if (days > 0) purgeSmsBodies(adapter, days);
        ensureSearchIndex(adapter);
        try { pruneMissingAttachments(db); } catch { /* media cleanup is best-effort */ }
        if (alive) bump();
        startup("first feed query scheduled");

        // Warm the non-Feed modules after the first frame so the first tab
        // switch is instant without paying their parse cost during launch.
        setTimeout(() => {
          if (!alive) return;
          void import("./src/screens/Today");
          void import("./src/screens/Analyse");
          void import("./src/screens/Review");
          void import("./src/screens/Today");
          void import("./src/screens/More");
        }, 1500);

        setTimeout(() => {
          if (!alive) return;
          let ran = false;
          try { ran = !!runNightlyIfDue(db); } catch { /* non-fatal */ }
          if (ran && alive) bump();
          startup(ran ? "nightly pass done" : "nightly skipped");
        }, 3500);
      } catch {
        startup("startup caught");
        if (alive) { setLockChecked(true); setLedgerReady(true); }
      }
    })();

    return () => { alive = false; };
  }, []);

  // Alerts, capture prompts, expected-flow matching and notification actions (runtime glue).
  useRuntime(ledgerReady && lockChecked && onboarded === true && !locked ? getLedger().db : null);

  // yako://tx/<id>, yako://plan/..., notification taps and actions.
  useEffect(() => registerLinkRouter({
    openTx: (id: number, captureMode) => {
      // A capture action (for example notification "Add media") owns the sheet. Do not also open
      // the transaction modal: native Modals stack by mount order and would hide the capture sheet.
      setAlertId(null); setWeeklyOpen(false); setModelsOpen(false);
      if (captureMode) { setFocusTx(null); setCapture({ id, mode: captureMode }); }
      else { setFocusTx(id); setCapture(null); }
      setTab("feed"); bump();
    },
    openPlan: () => { setAlertId(null); setWeeklyOpen(false); setModelsOpen(false); setCapture(null); setTab("plan"); bump(); },
    openScreen: (screen: string) => {
      setAlertId(null); setWeeklyOpen(false); setModelsOpen(false); setCapture(null);
      if (screen === "week") setWeeklyOpen(true); else setTab(screen === "needs-you" ? "review" : screen === "today/float" ? "plan" : "today");
      bump();
    },
    openAlert: (id: number) => { setWeeklyOpen(false); setModelsOpen(false); setCapture(null); setAlertId(id); bump(); },
  }), []);

  // Foreground backstop: catches a dropped SMS_RECEIVED broadcast while the app
  // is open, plus inbox changes after resume. The native receiver remains the
  // real-time path; this is the same inbox read the Diagnostics backfill uses.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      if (inboxBusy.current || lockedRef.current || onboardedRef.current !== true) return;
      inboxBusy.current = true;
      try {
        const db = getLedger().db;
        const stats = await catchUpInbox(db);
        if (stats.stored > 0 && alive) {
          const adapter = asDbAdapter(db);
          markSearchIndexDirty(adapter);
          ensureSearchIndex(adapter);
          bump();
          startup("inbox watcher", stats.stored);
        }
      } catch { /* permission or provider unavailable */ }
      finally { inboxBusy.current = false; }
    };
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") bgAt.current = Date.now();
      if (state === "active") {
        const cfg = lockRef.current;
        if (cfg?.enabled && bgAt.current && Date.now() - bgAt.current > cfg.timeoutMs) {
          lockedRef.current = true; setLocked(true);
        }
        void sync();
      }
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void sync();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  useEffect(() => {
    try {
      setPending(getLedger().db.getFirstSync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tx_events WHERE status = 'pending'`,
      )?.n ?? 0);
    } catch { setPending(0); }
  }, [refresh]);

  if (!ledgerReady || !lockChecked) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
        <StatusBar barStyle="light-content" />
        <Text style={text(12, C.dim)}>Opening ledger…</Text>
      </View>
    );
  }
  if (locked) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar barStyle="light-content" />
        <AppLock strict={!!lockCfg?.strictVault} onUnlock={() => { lockedRef.current = false; setLocked(false); bump(); }} />
      </View>
    );
  }
  if (onboarded === false) {
    return <Onboarding db={getLedger().db} onDone={() => {
      setOnboarded(true);
      onboardedRef.current = true;
      void ensureNotificationPermission(false).then((n) => {
        setNotifyState(n);
        if (n.granted) { void ensureNotifyChannel(); void syncWeeklyReview(getLedger().db); void syncHabitNudges(getLedger().db); }
      });
      bump();
    }} />;
  }

  const tabs: Array<[Tab, string, TabIconName]> = [
    ["today", "Home", "today"],
    ["feed", "Feed", "feed"],
    ["plan", "Plan", "plan"],
    ["analyse", "Analysis", "analyse"],
    ["more", "More", "more"],
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <StatusBar barStyle="light-content" />
      {LabGate && <Suspense fallback={null}><LabGate /></Suspense>}
      {notify && !notify.granted && (
        <TouchableOpacity
          onPress={() => { void ensureNotificationPermission(true).then((n) => { setNotifyState(n); if (n.granted) { void ensureNotifyChannel(); void syncWeeklyReview(getLedger().db); void syncHabitNudges(getLedger().db); } }); }}
          activeOpacity={0.8}
          style={{ backgroundColor: "#3A2E12", paddingHorizontal: 16, paddingVertical: 9 }}
        >
          <Text style={text(11, C.amber, "600")}>Notifications are off — tap to enable transaction alerts</Text>
        </TouchableOpacity>
      )}
      <View style={{ flex: 1 }}>
        <Suspense fallback={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={text(12, C.dim)}>Opening ledger…</Text></View>}>
          {tab === "today" && <TodayScreen refreshKey={refresh} onMore={() => setTab("more")} onPlan={() => setTab("plan")} onReview={() => { setReviewLimit(1000); setReviewOnboarding(false); setTab("review"); }} onQuickReview={() => { setReviewLimit(12); setReviewOnboarding(true); setTab("review"); }} onAlert={(id) => setAlertId(id)} onWeekly={() => setWeeklyOpen(true)} onSetupModels={() => setModelsOpen(true)} onOpenTx={(id) => { setFocusTx(id); setTab("feed"); bump(); }} />}
          {tab === "feed" && <FeedScreen refreshKey={refresh} focusTx={focusTx} onFocused={() => setFocusTx(null)} />}
          {tab === "analyse" && <AnalyseScreen refreshKey={refresh} onMore={() => setTab("more")} />}
          {tab === "review" && <ReviewScreen refreshKey={refresh} limit={reviewLimit} onboarding={reviewOnboarding} onDone={() => { setTab("today"); bump(); }} />}
          {tab === "plan" && <PlanScreen refreshKey={refresh} onSetupModels={() => setModelsOpen(true)} />}
          {tab === "more" && <MoreScreen refreshKey={refresh} onDataChanged={bump} onSetupModels={() => setModelsOpen(true)} />}
        </Suspense>
      </View>

      {alertId != null && (
        <AlertSheet
          db={getLedger().db}
          alertId={alertId}
          onClose={() => setAlertId(null)}
          onChanged={bump}
          onOpenTx={(id) => { setAlertId(null); setFocusTx(id); setTab("feed"); bump(); }}
        />
      )}

      {modelsOpen && (
        <View style={{ position: "absolute", inset: 0, backgroundColor: C.bg, zIndex: 80, paddingHorizontal: 22, paddingTop: insets.top + 28 }}>
          <Models db={getLedger().db} onDone={() => setModelsOpen(false)} onSkip={() => setModelsOpen(false)} />
        </View>
      )}

      {weeklyOpen && (
        <Suspense fallback={null}>
          <WeeklyReviewScreen
            db={getLedger().db}
            onClose={() => setWeeklyOpen(false)}
            onChanged={bump}
            onOpenTx={(id) => { setWeeklyOpen(false); setFocusTx(id); setTab("feed"); bump(); }}
            onSetupModels={() => { setWeeklyOpen(false); setModelsOpen(true); }}
          />
        </Suspense>
      )}

      {capture && <CaptureSheet db={getLedger().db} txId={capture.id} initialMode={capture.mode} onClose={() => setCapture(null)} onChanged={bump} />}

      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: C.line, backgroundColor: "#0F0F15", paddingTop: 8, paddingBottom: 10 }}>
        {tabs.map(([t, label, glyph]) => {
          const active = tab === t;
          return (
            <TouchableOpacity key={t} onPress={() => { setTab(t); bump(); }} style={{ flex: 1, alignItems: "center", justifyContent: "center", minHeight: 52, paddingVertical: 2 }} activeOpacity={0.7} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label + (t === "today" && pending > 0 ? `, ${pending} need a name` : "")}>
              <View>
                <TabIcon name={glyph} color={active ? C.blue : C.dim} />
                {t === "today" && pending > 0 && (
                  <View style={{ position: "absolute", right: -6, top: -1, width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber }} />
                )}
              </View>
              <Text maxFontSizeMultiplier={1.3} style={[text(10, active ? C.blue : C.dim, active ? "600" : "400"), { marginTop: 2 }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}
