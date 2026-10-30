import { useEffect, useState } from "react";
import { AppState, Linking, PermissionsAndroid, Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import * as Location from "expo-location";
import { setPrimaryMode, type GoalMode } from "@yako/core";
import { Btn, C, Card, Pill, text } from "../ui";
import { asDbAdapter } from "../db/open";
import { catchUpInbox } from "../ingest-inbox";
import { ensureNotificationPermission, notificationState } from "../notify";
import { Models } from "./Models";
import { syncWeeklyReview } from "../runtime/weekly";
import { syncHabitNudges } from "../runtime/nudges";

/**
 * First run. Order matters: context before permissions, import before optional extras,
 * model setup before notifications, and location explained as one fix per money message.
 * The flow is resumable because ingest is idempotent; onboarding only completes on Done.
 */
type Step = "welcome" | "sms" | "import" | "goal" | "models" | "notify" | "location" | "done";

const brand = () => String((Platform.constants as { Brand?: string; Manufacturer?: string }).Brand ?? (Platform.constants as { Manufacturer?: string }).Manufacturer ?? "").toLowerCase();

function oemSteps(): { title: string; steps: string[] } | null {
  const b = brand();
  if (/tecno|infinix|itel|transsion/.test(b)) return { title: "Transsion phones (itel, Tecno, Infinix)",
    steps: ["Settings → Apps → Pesanalysis → Battery → choose Unrestricted.", "In Phone Master / Power Marathon, allow Pesanalysis to auto-start.", "Lock the app in recents (padlock icon) if your ROM offers it.", "Allow Pesanalysis to be exempt from hibernation (the itel setting that pauses unused apps)."] };
  if (/xiaomi|redmi|poco/.test(b)) return { title: "Xiaomi / Redmi",
    steps: ["Settings → Apps → Manage apps → Pesanalysis → Autostart: on.", "Battery saver → No restrictions.", "Lock the app in recents."] };
  if (/oppo|realme|oneplus/.test(b)) return { title: "Oppo / Realme / OnePlus",
    steps: ["Settings → Battery → App battery management → Pesanalysis → Allow background activity.", "Allow auto-launch in startup manager."] };
  if (/vivo|iqoo/.test(b)) return { title: "Vivo",
    steps: ["Settings → Battery → Background power consumption management → Pesanalysis → Allow.", "Enable auto-start."] };
  if (/samsung/.test(b)) return { title: "Samsung",
    steps: ["Settings → Battery → Background usage limits → remove Pesanalysis from Sleeping apps."] };
  return null;
}

const MODES: Array<{ key: GoalMode; title: string; line: string }> = [
  { key: "steady", title: "Steady", line: "Get ahead of the month and rely less on Fuliza." },
  { key: "grow", title: "Grow", line: "Save for something and build a pot." },
  { key: "business", title: "Business", line: "Track a venture or a shop." },
  { key: "clarity", title: "Clarity", line: "Just see where the money goes." },
];

export function Onboarding({ db, onDone }: { db: SQLiteDatabase; onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [smsState, setSmsState] = useState<"unknown" | "granted" | "denied">("unknown");
  const [notifyState, setNotifyState] = useState<"unknown" | "granted" | "denied">("unknown");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{ read: number; events: number; needs: number; error?: string } | null>(null);
  const [mode, setMode] = useState<GoalMode>("clarity");
  const [fg, setFg] = useState<boolean | null>(null);
  const [bg, setBg] = useState<boolean | null>(null);
  const oem = oemSteps();

  useEffect(() => {
    if (step !== "notify") return;
    void notificationState().then((n) => setNotifyState(n.granted ? "granted" : "denied"));
  }, [step]);

  useEffect(() => {
    if (step !== "location") return;
    const check = async () => {
      const f = await Location.getForegroundPermissionsAsync().catch(() => null);
      const b = await Location.getBackgroundPermissionsAsync().catch(() => null);
      setFg(!!f?.granted); setBg(!!b?.granted);
    };
    void check();
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") void check(); });
    return () => sub.remove();
  }, [step]);

  const askSms = async () => {
    try {
      const r = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_SMS,
        PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
      ]);
      const ok = Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
      setSmsState(ok ? "granted" : "denied");
      if (ok) setStep("import");
    } catch {
      setSmsState("denied");
    }
  };

  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const count = () => Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events`)?.n ?? 0);
      const before = count();
      // One ingest path, honouring the native reset floor and running the same post-ingest
      // passes as every other import. The foreground watcher is disabled during onboarding.
      const stats = await catchUpInbox(db, 20_000);
      const after = count();
      const needs = Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events WHERE status = 'pending'`)?.n ?? 0);
      setImported({ read: stats.read, events: Math.max(0, after - before), needs });
      setStep("goal");
    } catch (e) {
      // Numbers come from the ledger, not from a counter that can silently return 0.
      const count = () => Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events`)?.n ?? 0);
      setImported({ read: 0, events: count(), needs: Number(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events WHERE status = 'pending'`)?.n ?? 0), error: "Could not read messages. Check SMS permission and try again." });
      setStep("goal");
    } finally { setBusy(false); }
  };

  const chooseMode = (m: GoalMode) => {
    setMode(m);
    try { setPrimaryMode(asDbAdapter(db), m); } catch { /* plans can be created later */ }
  };

  const askNotify = async () => {
    const n = await ensureNotificationPermission(true);
    setNotifyState(n.granted ? "granted" : "denied");
    if (n.granted) { void syncWeeklyReview(db); void syncHabitNudges(db); }
  };

  const askForeground = async () => {
    const r = await Location.requestForegroundPermissionsAsync().catch(() => null);
    setFg(!!r?.granted);
  };

  const askBackground = async () => {
    const r = await Location.requestBackgroundPermissionsAsync().catch(() => null);
    setBg(!!r?.granted);
    if (!r?.granted) {
      // Android 11+ often sends the user to Settings; ask them to return and check again.
      await Linking.openSettings().catch(() => undefined);
    }
  };

  const finish = () => {
    try { db.runSync(`INSERT INTO meta (key,value) VALUES ('onboarded','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value`); } catch { /* optional */ }
    onDone();
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <View style={{ position: "absolute", inset: 0, backgroundColor: C.bg, zIndex: 90 }}>
      <ScrollView contentContainerStyle={{ padding: 22, paddingTop: 48, paddingBottom: 40 }}>{children}</ScrollView>
    </View>
  );

  if (step === "models") {
    return (
      <View style={{ position: "absolute", inset: 0, backgroundColor: C.bg, zIndex: 90, paddingHorizontal: 22, paddingTop: 48 }}>
        <Models db={db} onDone={() => setStep("notify")} onSkip={() => setStep("notify")} />
      </View>
    );
  }

  if (step === "welcome") return (
    <Shell>
      <Text style={text(30, C.text, "700")} maxFontSizeMultiplier={1.4} accessibilityRole="header">Pesanalysis</Text>
      <Text style={[text(15, C.muted), { marginTop: 8, lineHeight: 22 }]}>Your money, read from your own messages, on your own phone. No bank login. No cloud. No ads.</Text>
      <Card style={{ marginTop: 22 }}>
        <Text style={text(13, C.text, "700")}>What we will ask for, and when</Text>
        {[
          ["SMS", "Now. To read M-PESA, Airtel Money and bank messages. Required for the ledger."],
          ["Notifications", "After import. To ask about a payment while it is fresh. Recommended."],
          ["Location", "After import. One reading when a money message arrives, never continuous tracking."],
          ["Contacts, camera, microphone, calendar", "Only when you first use that feature."],
          ["Battery", "One extra setting on Transsion phones so SMS is not paused when the app is closed."],
        ].map(([t, d]) => (
          <View key={t} style={{ marginTop: 10 }}>
            <Text style={text(13, C.text, "600")}>{t}</Text>
            <Text style={[text(12, C.muted), { marginTop: 2, lineHeight: 17 }]}>{d}</Text>
          </View>
        ))}
      </Card>
      <View style={{ marginTop: 20 }}><Btn label="Get started" kind="primary" onPress={() => setStep("sms")} style={{ minHeight: 52 }} /></View>
    </Shell>
  );

  if (step === "sms") return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">Allow SMS access</Text>
      <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>Android will ask to allow Pesanalysis to read and receive your messages. We only keep money messages; personal messages and one-time codes are discarded before they reach the ledger.</Text>
      <View style={{ marginTop: 20 }}><Btn label={smsState === "denied" ? "Ask again" : "Allow SMS"} kind="primary" onPress={() => void askSms()} style={{ minHeight: 52 }} /></View>
      {smsState === "denied" && (<Card style={{ marginTop: 16, borderColor: C.amber }}>
        <Text style={text(13, C.text, "700")}>If Android does not show the prompt</Text>
        <Text style={[text(12, C.muted), { marginTop: 6, lineHeight: 18 }]}>Apps installed outside the Play Store are sometimes blocked. Open Settings → Apps → Pesanalysis → three-dot menu → “Allow restricted settings”, then try again.</Text>
        <TouchableOpacity onPress={() => void Linking.openSettings()} style={{ marginTop: 12, minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Open app settings">
          <Text style={text(13, C.blue, "600")}>Open settings ›</Text>
        </TouchableOpacity>
      </Card>)}
      <TouchableOpacity onPress={() => setStep("import")} style={{ marginTop: 14, minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
        <Text style={text(12, C.dim)}>Continue without SMS (the app will have no transactions)</Text>
      </TouchableOpacity>
    </Shell>
  );

  if (step === "import") return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">Read your recent messages</Text>
      <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>We start with the last 60 days (newest first), then fill in older messages. You can stop and continue later; nothing is lost.</Text>
      <View style={{ marginTop: 20 }}><Btn label={busy ? "Reading…" : smsState === "granted" ? "Start import" : "Read anyway"} kind="primary" disabled={busy} onPress={() => void runImport()} style={{ minHeight: 52 }} /></View>
      <TouchableOpacity onPress={() => setStep("goal")} style={{ marginTop: 14, minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
        <Text style={text(12, C.dim)}>Skip for now</Text>
      </TouchableOpacity>
    </Shell>
  );

  if (step === "goal") return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">What do you want from Pesanalysis?</Text>
      <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>Pick one to start. You can add the others later; nothing is locked.</Text>
      {MODES.map((m) => (
        <TouchableOpacity key={m.key} onPress={() => chooseMode(m.key)} accessibilityRole="radio" accessibilityState={{ selected: mode === m.key }} style={{ marginTop: 10 }}>
          <Card style={{ borderColor: mode === m.key ? C.blue : C.line, minHeight: 64 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Text style={text(14, C.text, "700")}>{m.title}</Text>
                <Text style={[text(12, C.muted), { marginTop: 3 }]}>{m.line}</Text>
              </View>
              {mode === m.key ? <Pill label="selected" tone="blue" /> : null}
            </View>
          </Card>
        </TouchableOpacity>
      ))}
      <View style={{ marginTop: 18 }}><Btn label="Continue" kind="primary" onPress={() => setStep("models")} style={{ minHeight: 52 }} /></View>
    </Shell>
  );

  if (step === "notify") return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">Notifications</Text>
      {notifyState === "granted" ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={text(14, C.text, "700")}>Notifications are on ✓</Text>
          <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 18 }]}>A payment arrives with the amount and place on your lock screen. You can hide details there in Settings.</Text>
        </Card>
      ) : (
        <>
          <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>We use them to ask “what was this payment?” while you still remember, and for due-date and safety alerts. The lock screen shows the amount and place by default; you can hide details later.</Text>
          <View style={{ marginTop: 20 }}><Btn label="Allow notifications" kind="primary" onPress={() => void askNotify()} style={{ minHeight: 52 }} /></View>
          {notifyState === "denied" && <Text style={[text(12, C.amber), { marginTop: 12 }]}>Notifications are off. You can turn them on later in More → Alerts.</Text>}
        </>
      )}
      <View style={{ marginTop: 18 }}><Btn label="Continue" kind="soft" onPress={() => setStep("location")} style={{ minHeight: 52 }} /></View>
    </Shell>
  );

  if (step === "location") return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">Place each payment</Text>
      <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>Pesanalysis takes one location reading when a money message arrives, so you can see where you spent. It never follows you.</Text>
      <Card style={{ marginTop: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ flex: 1 }}><Text style={text(13, C.text, "600")}>While using the app</Text><Text style={[text(11, C.muted), { marginTop: 2 }]}>{fg ? "allowed" : "not allowed"}</Text></View>
          {fg ? <Pill label="✓" tone="green" /> : <TouchableOpacity onPress={() => void askForeground()} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button"><Text style={text(12, C.blue, "600")}>Allow</Text></TouchableOpacity>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14 }}>
          <View style={{ flex: 1 }}><Text style={text(13, C.text, "600")}>All the time</Text><Text style={[text(11, C.muted), { marginTop: 2 }]}>one fix per money message</Text></View>
          {bg ? <Pill label="✓" tone="green" /> : <TouchableOpacity onPress={() => void askBackground()} disabled={!fg} style={{ minHeight: 48, justifyContent: "center", opacity: fg ? 1 : 0.45 }} accessibilityRole="button" accessibilityState={{ disabled: !fg }}><Text style={text(12, C.blue, "600")}>Open settings</Text></TouchableOpacity>}
        </View>
        {!bg && <TouchableOpacity onPress={() => void (async () => { const b = await Location.getBackgroundPermissionsAsync().catch(() => null); setBg(!!b?.granted); })()} style={{ marginTop: 10, minHeight: 44, justifyContent: "center" }}><Text style={text(11, C.dim)}>Already changed it? Check again</Text></TouchableOpacity>}
        {!bg && <Text style={[text(11, C.dim), { marginTop: 8, lineHeight: 16 }]}>Without it, new payments can only use the phone's last known place. Everything else still works.</Text>}
      </Card>
      {oem && (<Card style={{ marginTop: 14 }}>
        <Text style={text(13, C.text, "700")}>Keep capture working on {oem.title}</Text>
        {oem.steps.map((s, i) => <Text key={i} style={[text(12, C.muted), { marginTop: 5, lineHeight: 17 }]}>• {s}</Text>)}
        <TouchableOpacity onPress={() => void Linking.openSettings()} style={{ marginTop: 10, minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
          <Text style={text(12, C.blue, "600")}>Open settings ›</Text>
        </TouchableOpacity>
      </Card>)}
      <View style={{ marginTop: 18 }}><Btn label="Continue" kind="primary" onPress={() => setStep("done")} style={{ minHeight: 52 }} /></View>
    </Shell>
  );

  return (
    <Shell>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">{imported?.events ? "Your ledger is ready" : "Ready"}</Text>
      {imported ? (
        <>
          <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>
            Read {imported.read.toLocaleString()} messages. Found {imported.events.toLocaleString()} payments. {imported.needs.toLocaleString()} need a name; we will ask as they come up.
          </Text>
          {imported.error && <Text style={[text(11, C.amber), { marginTop: 8, lineHeight: 16 }]}>{imported.error}</Text>}
        </>
      ) : (
        <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>You can import messages any time from the import control in settings.</Text>
      )}
      <View style={{ marginTop: 18 }}><Btn label="Open Pesanalysis" kind="primary" onPress={finish} style={{ minHeight: 52 }} /></View>
    </Shell>
  );
}
