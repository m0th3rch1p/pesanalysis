import { useEffect, useState } from "react";
import {
  Alert, Modal, ScrollView, Share, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  POLICY_MANIFEST, PACKS, TONES, LANGUAGES, acceptProposal, airlockPreview, applyPack,
  buildAirlock, createVenture, deleteFact, factsFor, ftsAvailable, getAirlockManifest,
  getProfile, getRetentionDays, listTags, setProfile as saveProfile,
  setRetentionDays, suggestTags, venturePnlAll, buildZ1Snapshot, pairHost, listHosts, revokeHost,
  handleMcpRequest, type ExtendedProfile, type ProposedTag, type TagRow, type HostRecord,
} from "@yako/core";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { connectCalendar, connectContacts, connectLocation, connectorStatus, type ConnectorStatus } from "../connectors";
import { locationProbe } from "../context";
import { notificationState, sendTestNotification, type NotificationState } from "../notify";
import { setWeeklyReviewEnabled, syncWeeklyReview, weeklyReviewEnabled } from "../runtime/weekly";
import { createExperiment, listExperiments, runExperiment, type ExperimentRow } from "../experiments";
import { BackupSection } from "../backup/BackupSection";
import { LockSettings } from "../security/LockSettings";
import { LedgerAudit } from "../security/LedgerAudit";
import { CaptureControls } from "../components/CaptureControls";
import { sendCigarettePayment } from "../demo-payment";
import { AssistantScreen } from "../assistant/AssistantScreen";
import { callZ1, getZ1Config, pushZ1, saveZ1Config, testZ1 } from "../z1";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { DiagnosticsScreen } from "./Diagnostics";
import { IdentityWizard } from "../components/IdentityWizard";
import { TaxonomyEditor } from "../components/TaxonomyEditor";
import { DebtManager } from "../components/DebtManager";
import { ThingsScreen } from "./Things";
import { Btn, C, Card, Pill, Screen, SectionTitle, kes, text } from "../ui";
import { MODELS, localPath, type ModelSpec } from "../qvac";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 }}>
      <Text style={text(12, C.muted)}>{label}</Text>
      <Text style={[text(12, C.text), { flexShrink: 1, textAlign: "right", marginLeft: 12 }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export function MoreScreen({ refreshKey, onDataChanged, onSetupModels }: { refreshKey: number; onDataChanged: () => void; onSetupModels?: () => void }) {
  const db = getLedger().db;
  const a = asDbAdapter(db);
  const [local, setLocal] = useState(0);
  const [profile, setProfile] = useState<ExtendedProfile | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<TagRow[]>([]);
  const [ventures, setVentures] = useState<ReturnType<typeof venturePnlAll>>([]);
  const [props, setProps] = useState<ProposedTag[]>([]);
  const [newVenture, setNewVenture] = useState("");
  const [facts, setFacts] = useState<ReturnType<typeof factsFor>>([]);
  const [retention, setRetention] = useState(0);
  const [diag, setDiag] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [airlock, setAirlock] = useState<ReturnType<typeof getAirlockManifest>>(null);
  const [preview, setPreview] = useState<ReturnType<typeof airlockPreview>>([]);
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRow[]>([]);
  const [devTaps, setDevTaps] = useState(0);
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [conn, setConn] = useState<ConnectorStatus | null>(null);
  const [expName, setExpName] = useState("");
  const [expLabel, setExpLabel] = useState("");
  const [wizard, setWizard] = useState(false);
  const [things, setThings] = useState(false);
  const [z1Url, setZ1Url] = useState("");
  const [z1Token, setZ1Token] = useState("");
  const [z1Msg, setZ1Msg] = useState("");
  const [notifyInfo, setNotifyInfo] = useState<NotificationState | null>(null);
  const [notifyMsg, setNotifyMsg] = useState("");
  const [weekly, setWeekly] = useState(true);

  useEffect(() => {
    try {
      const p = getProfile(a);
      setProfile(p); setName(p.name ?? "");
      setTags(listTags(a));
      setVentures(venturePnlAll(a));
      setProps(suggestTags(a, Date.now(), 3, 4));
      setFacts(factsFor(a));
      setRetention(getRetentionDays(a));
      setAirlock(getAirlockManifest(a));
      setPreview(airlockPreview(a));
      setHosts(listHosts(a));
      setExperiments(listExperiments(db));
      void connectorStatus(db).then(setConn).catch(() => setConn(null));
      void notificationState().then(setNotifyInfo).catch(() => setNotifyInfo(null));
      setWeekly(weeklyReviewEnabled(db));
      void getZ1Config().then((c) => { setZ1Url(c.url); setZ1Token(c.token); }).catch(() => { /* no host */ });
    } catch { /* fresh DB */ }
  }, [refreshKey, local]);

  const bump = () => { setLocal((n) => n + 1); onDataChanged(); };

  const togglePack = (id: string) => {
    const current = new Set(profile?.verticals ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    try {
      if (!profile?.verticals.includes(id) && current.has(id)) applyPack(a, id);
      setProfile(saveProfile(a, { verticals: [...current] }));
      bump();
    } catch (e) { Alert.alert("Could not apply pack", String(e).slice(0, 160)); }
  };

  const saveName = () => { try { saveProfile(a, { name: name.trim() || undefined }); bump(); } catch { /* ignore */ } };

  const addVenture = () => {
    const n = newVenture.trim();
    if (!n) return;
    try { createVenture(a, n, "business"); setNewVenture(""); bump(); } catch (e) { Alert.alert("Could not add", String(e).slice(0, 160)); }
  };

  const build = () => {
    try {
      const manifest = buildAirlock(a, { k: 5, timeGranularity: "month", amountMode: "band" });
      setAirlock(manifest); setPreview(airlockPreview(a));
      Alert.alert("Airlock rebuilt", `${manifest.tables.reduce((s, t) => s + t.rows, 0)} aggregate rows. ${manifest.suppressedCells} small cells suppressed or folded into Other.`);
    } catch (e) { Alert.alert("Airlock failed", String(e).slice(0, 160)); }
  };

  const exportAirlock = async () => {
    try {
      buildAirlock(a, { k: 5, timeGranularity: "month", amountMode: "band" });
      const rows = a.all(`SELECT month, direction, label, amount_band AS band, tx_count AS n, total_cents AS total FROM airlock_monthly ORDER BY month, direction, label`);
      await Share.share({ title: "Pesanalysis airlock aggregates", message: JSON.stringify({ manifest: getAirlockManifest(a), rows }, null, 2) });
    } catch (e) { Alert.alert("Export failed", String(e).slice(0, 160)); }
  };

  const calendarConnector = async () => {
    try {
      const r = await connectCalendar(db);
      setConn(await connectorStatus(db));
      Alert.alert("Calendar", r.permission === "granted"
        ? `${r.calendars} calendars · ${r.events} events in the last 120 days · ${r.updated + r.created} payments linked.${r.error ? `\nAPI note: ${r.error}` : "\nTitles stay on this phone."}`
        : `Permission ${r.permission}. Nothing was read.${r.error ? `\n${r.error}` : ""}`);
      bump();
    } catch (e) { Alert.alert("Calendar", String(e).slice(0, 180)); }
  };

  const contactsConnector = async () => {
    try {
      const r = await connectContacts(db);
      setConn(await connectorStatus(db));
      Alert.alert("Contacts", r.permission === "granted" ? `${r.contacts} contacts read · ${r.linked} masked payers linked.` : `Permission ${r.permission}. Nothing was read.`);
      bump();
    } catch (e) { Alert.alert("Contacts", String(e).slice(0, 180)); }
  };

  const locationConnector = async () => {
    try {
      const p = await connectLocation(db);
      const probe = await locationProbe();
      setConn(await connectorStatus(db));
      Alert.alert("Location context", p === "granted"
        ? `Granted. Future SMS will carry a passive last-known coarse location; no continuous tracking.\n${probe.lastKnown ? `Test fix available: ±${Math.round(probe.lastKnown.accuracy ?? 0)}m, ${Math.round(probe.lastKnown.ageMs / 60_000)} min old.` : probe.current ? `Test fix obtained now (±${Math.round(probe.current.accuracy ?? 0)}m).` : "No OS fix available right now; this is normal indoors."}${probe.error ? `\n${probe.error}` : ""}`
        : `Permission ${p}. Context will stay empty.`);
    } catch (e) { Alert.alert("Location context", String(e).slice(0, 180)); }
  };

  const testNotification = async () => {
    try {
      const s = await sendTestNotification();
      setNotifyInfo(s);
      setNotifyMsg(s.granted ? "Sent. Check the notification shade." : `Permission ${s.permission}. Open Android settings → Apps → Pesanalysis → Notifications.`);
    } catch (e) { setNotifyMsg(String(e).slice(0, 180)); }
  };

  const startExperiment = () => {
    try {
      const e = createExperiment(db, {
        name: expName.trim() || "Habit experiment",
        targetLabel: expLabel.trim() || null,
        startedAt: Date.now() - 30 * 86_400_000,
        hypothesis: "Does spending on this category change after the intervention?",
      });
      setExpName(""); setExpLabel("");
      setExperiments(listExperiments(db));
      void connectorStatus(db).then(setConn).catch(() => setConn(null));
      void getZ1Config().then((c) => { setZ1Url(c.url); setZ1Token(c.token); }).catch(() => { /* no host */ });
      const r = runExperiment(db, e.id);
      setExperiments(listExperiments(db));
      void connectorStatus(db).then(setConn).catch(() => setConn(null));
      void getZ1Config().then((c) => { setZ1Url(c.url); setZ1Token(c.token); }).catch(() => { /* no host */ });
      Alert.alert("Experiment result", `Cumulative effect ${kes(Math.round(r.cumulativeEffect))} (95% CI ${kes(Math.round(r.lo95))} to ${kes(Math.round(r.hi95))}), P(negative)=${(r.pNegative * 100).toFixed(0)}%.`);
    } catch (e) { Alert.alert("Experiment failed", String(e).slice(0, 180)); }
  };

  const pairLocalHost = () => {
    try {
      pairHost(a, { id: `host-${Date.now()}`, name: "Personal host (Z1)", keyFingerprint: "local-snapshot" });
      setHosts(listHosts(a));
      setExperiments(listExperiments(db));
      void connectorStatus(db).then(setConn).catch(() => setConn(null));
      void getZ1Config().then((c) => { setZ1Url(c.url); setZ1Token(c.token); }).catch(() => { /* no host */ });
      Alert.alert("Host paired", "Your own host is now listed. Test the live channel, send the allowlisted snapshot, or export it to your machine. No SMS bodies, notes, locations or media are sent.");
    } catch (e) { Alert.alert("Pairing failed", String(e).slice(0, 160)); }
  };

  const exportZ1 = async () => {
    try {
      const h = hosts.find((x) => !x.revokedAt) ?? null;
      const snap = buildZ1Snapshot(a, h?.id ?? null);
      const file = new File(Paths.document, `pesanalysis-z1-${Date.now()}.json`);
      file.writeSync(JSON.stringify(snap));
      if (!(await Sharing.isAvailableAsync())) throw new Error("sharing unavailable");
      await Sharing.shareAsync(file.uri, { mimeType: "application/json", dialogTitle: "Pesanalysis Z1 snapshot" });
    } catch (e) { Alert.alert("Export failed", String(e).slice(0, 160)); }
  };

  const saveLiveHost = async () => {
    try {
      if (!z1Url.trim() || !z1Token.trim()) throw new Error("Enter the host address and token first");
      await saveZ1Config(z1Url, z1Token);
      pairHost(a, { id: "z1-live", name: "Live personal host", keyFingerprint: "bearer" });
      setHosts(listHosts(a));
      setZ1Msg("Host saved on this phone. Token is in Android Keystore.");
    } catch (e) { setZ1Msg(String(e).slice(0, 180)); }
  };

  const testLiveHost = async () => {
    try {
      setZ1Msg("Testing host…");
      await saveZ1Config(z1Url, z1Token);
      const r = await testZ1(z1Url, z1Token);
      pairHost(a, { id: "z1-live", name: "Live personal host", keyFingerprint: "bearer" });
      setHosts(listHosts(a));
      setZ1Msg(`Live: ${r.server} · ${r.tools.length} MCP tools.`);
    } catch (e) { setZ1Msg(`Live test failed: ${String(e).slice(0, 160)}`); }
  };

  const pushLive = async () => {
    try {
      setZ1Msg("Sending allowlisted snapshot…");
      const r = await pushZ1(db, z1Url, z1Token);
      setHosts(listHosts(a));
      setZ1Msg(`Snapshot sent: ${r.rows} transaction rows accepted (${r.snapshotRows} allowlisted rows total). No SMS bodies, notes, locations or media.`);
    } catch (e) { setZ1Msg(`Snapshot failed: ${String(e).slice(0, 160)}`); }
  };

  const callLive = async () => {
    try {
      setZ1Msg("Calling MCP tool…");
      const text = await callZ1(z1Url, z1Token, "summary");
      setZ1Msg(`MCP summary: ${text.slice(0, 500)}`);
    } catch (e) { setZ1Msg(`MCP call failed: ${String(e).slice(0, 160)}`); }
  };

  const showMcp = () => {
    try {
      const r = handleMcpRequest(a, "Z1", { id: 1, method: "tools/list" });
      const tools = ((r.result as { tools: Array<{ name: string; description: string }> }).tools);
      Alert.alert("MCP tools (Z1)", tools.map((t) => `• ${t.name} — ${t.description}`).join("\n"));
    } catch (e) { Alert.alert("MCP", String(e).slice(0, 160)); }
  };

  const chain = getLedger().cipherVersion;
  const fts = (() => { try { return ftsAvailable(a); } catch { return false; } })();

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 24, paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
        <Text style={text(30, C.text, "700")}>More</Text>
        <Text style={[text(12, C.muted), { marginTop: 2 }]}>Settings, identity, privacy, diagnostics</Text>

        <SectionTitle>IDENTITY</SectionTitle>
        <Card>
          <Text style={text(11, C.muted, "700")}>YOUR NAME (OPTIONAL)</Text>
          <TextInput
            value={name} onChangeText={setName} onEndEditing={saveName} placeholder="e.g. Wanjiku"
            placeholderTextColor={C.dim}
            style={[text(14, C.text), { backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 }]}
          />
          <Btn label="Open setup interview" kind="soft" onPress={() => setWizard(true)} style={{ marginTop: 12, paddingVertical: 9 }} />
          {profile?.identityCustom ? <Text style={[text(11, C.muted), { marginTop: 6 }]}>Your words: {profile.identityCustom}</Text> : null}
          <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>WHAT YOU DO (PICK ANY)</Text>
          <View style={{ gap: 8, marginTop: 8 }}>
            {PACKS.map((p) => {
              const active = !!profile?.verticals.includes(p.id);
              return (
                <TouchableOpacity key={p.id} onPress={() => togglePack(p.id)} activeOpacity={0.75}
                  style={{ borderRadius: 12, borderWidth: 1, borderColor: active ? C.blue : C.line, backgroundColor: active ? "#0A84FF14" : C.card2, padding: 12 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Text style={text(13, C.text, "600")}>{p.name}</Text>
                    <View style={{ flex: 1 }} />
                    {active && <Pill label="on" tone="blue" />}
                  </View>
                  <Text style={[text(11, C.muted), { marginTop: 3 }]}>{p.blurb}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>TONE</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
            {TONES.map((t) => (
              <TouchableOpacity key={t.id} onPress={() => { saveProfile(a, { tone: t.id }); bump(); }} activeOpacity={0.7}>
                <Pill label={t.name} tone={profile?.tone === t.id ? "blue" : "dim"} />
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>LANGUAGE</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
            {LANGUAGES.map((l) => (
              <TouchableOpacity key={l.id} onPress={() => { saveProfile(a, { language: l.id }); bump(); }} activeOpacity={0.7}>
                <Pill label={l.name} tone={profile?.language === l.id ? "blue" : "dim"} />
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        <SectionTitle>LABELS & ROLES</SectionTitle>
        <Card><TaxonomyEditor db={db} onChanged={bump} /></Card>

        <SectionTitle>DEBTS & REPAYMENTS</SectionTitle>
        <Card><DebtManager db={db} onChanged={bump} /></Card>

        <SectionTitle>VENTURES & TAGS</SectionTitle>
        <Card>
          {ventures.length === 0 && <Text style={text(12, C.muted)}>No ventures yet. Add one, or accept a suggestion below.</Text>}
          {ventures.map((v) => (
            <View key={v.tagId} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}>
              <View style={{ flex: 1 }}>
                <Text style={text(13, C.text, "600")}>{v.name}</Text>
                <Text style={text(10, C.dim)}>{v.txCount} payments · in {kes(v.incomeCents)} · out {kes(v.expenseCents + v.feeCents)}</Text>
              </View>
              <Text style={text(13, v.netCents >= 0 ? C.green : C.red, "700")}>{kes(v.netCents)}</Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <TextInput value={newVenture} onChangeText={setNewVenture} placeholder="New venture or project" placeholderTextColor={C.dim}
              style={[text(13, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 }]} />
            <Btn label="Add" kind="soft" onPress={addVenture} style={{ paddingVertical: 8, paddingHorizontal: 14 }} />
          </View>
          <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>TAGS</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {tags.filter((t) => !t.ventureKind).map((t) => <Pill key={t.id} label={`${t.name} · ${t.txCount}`} />)}
            {tags.filter((t) => !t.ventureKind).length === 0 && <Text style={text(11, C.dim)}>Tags you add to payments appear here.</Text>}
          </View>
        </Card>

        {props.length > 0 && (
          <>
            <SectionTitle>SUGGESTED</SectionTitle>
            <Card>
              {props.map((p) => (
                <View key={p.tag} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={text(13, C.text, "600")}>{p.tag}</Text>
                    <Text style={text(10, C.dim)}>{p.why}</Text>
                  </View>
                  <TouchableOpacity onPress={() => { acceptProposal(a, p); bump(); }} style={{ backgroundColor: C.blue, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 }}>
                    <Text style={text(11, "#fff", "700")}>Track</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </Card>
          </>
        )}

        <SectionTitle>WHAT PESANALYSIS KNOWS</SectionTitle>
        <Card>
          {facts.length === 0 && <Text style={text(12, C.muted)}>No facts yet. Answer a question or set your identity.</Text>}
          {facts.slice(0, 12).map((f) => (
            <View key={f.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}>
              <Text style={[text(12, C.muted), { flex: 1 }]}>{f.subject} · {f.predicate} = <Text style={text(12, C.text, "600")}>{f.object}</Text></Text>
              <TouchableOpacity onPress={() => { deleteFact(a, f.id); bump(); }}><Text style={text(10, C.dim)}>forget</Text></TouchableOpacity>
            </View>
          ))}
        </Card>

{devUnlocked && (<>
                <SectionTitle>TRUST ZONES</SectionTitle>
        <Card>
          <Row label="Device ledger (Z0)" value={chain ? `encrypted · SQLCipher ${chain}` : "NOT ENCRYPTED"} />
          <Row label="Full-text index" value={fts ? "FTS5 available" : "LIKE fallback (FTS5 unavailable)"} />
          <Row label="Paired personal hosts (Z1)" value={hosts.length ? `${hosts.filter((h) => !h.revokedAt).length} active` : "none yet"} />
          {hosts.map((h) => (
            <View key={h.id} style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
              <Text style={[text(10, C.muted), { flex: 1 }]} numberOfLines={1}>{h.name}{h.revokedAt ? " · revoked" : ""}</Text>
              {!h.revokedAt && <TouchableOpacity onPress={() => { revokeHost(a, h.id); setHosts(listHosts(a)); }}><Text style={text(10, C.red)}>revoke</Text></TouchableOpacity>}
            </View>
          ))}
          <Text style={[text(11, C.muted, "700"), { marginTop: 14 }]}>LIVE Z1 HOST (YOUR MACHINE)</Text>
          <TextInput value={z1Url} onChangeText={setZ1Url} placeholder="https://your-host.example" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, marginTop: 7 }]} />
          <TextInput value={z1Token} onChangeText={setZ1Token} placeholder="Host token" placeholderTextColor={C.dim} secureTextEntry autoCapitalize="none" autoCorrect={false}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6 }]} />
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            <Btn label="Save" kind="soft" onPress={() => void saveLiveHost()} style={{ flex: 1, paddingVertical: 8 }} />
            <Btn label="Test live" kind="soft" onPress={() => void testLiveHost()} style={{ flex: 1, paddingVertical: 8 }} />
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
            <Btn label="Send snapshot" kind="soft" onPress={() => void pushLive()} style={{ flex: 1.4, paddingVertical: 8 }} />
            <Btn label="Call summary" kind="soft" onPress={() => void callLive()} style={{ flex: 1, paddingVertical: 8 }} />
          </View>
          {z1Msg ? <Text style={[text(10, z1Msg.includes("failed") || z1Msg.includes("Error") ? C.amber : C.green), { marginTop: 8, lineHeight: 15 }]}>{z1Msg}</Text> : null}
          <Text style={[text(10, C.dim), { marginTop: 6, lineHeight: 15 }]}>The phone sends only the allowlisted Z1 snapshot. Use an HTTPS host address; plain HTTP is allowed only for localhost/127.0.0.1. For local USB testing, run `adb reverse tcp:8787 tcp:8787` and use http://127.0.0.1:8787.</Text>

          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <Btn label="Export Z1" kind="soft" onPress={exportZ1} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Local MCP tools" kind="soft" onPress={showMcp} style={{ flex: 1, paddingVertical: 9 }} />
          </View>
          <Row label="External aggregates (Z2)" value="airlock only · k ≥ 5 · no names or notes" />
          <Row label="Model" value="deterministic live build" />
          <Text style={[text(11, C.muted), { marginTop: 10, lineHeight: 16 }]}>
            Z1 is a model or tool server you run yourself. The live channel above sends the allowlisted snapshot and MCP requests only. Z2 can only receive the aggregate airlock you export yourself.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <Btn label="Build airlock" kind="soft" onPress={build} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Share aggregates" kind="soft" onPress={exportAirlock} style={{ flex: 1, paddingVertical: 9 }} />
          </View>
          {airlock && (
            <View style={{ marginTop: 10 }}>
              <Text style={text(11, C.muted)}>{airlock.tables.reduce((s, t) => s + t.rows, 0)} rows · {airlock.suppressedCells} suppressed · built {new Date(airlock.builtAt).toLocaleString("en-GB")}</Text>
              {preview.slice(0, 4).map((p) => (
                <Text key={`${p.month}-${p.label}`} style={[text(10, C.dim), { marginTop: 2 }]}>{p.month} · {p.label} · {kes(p.totalCents)} · {p.txCount} tx</Text>
              ))}
            </View>
          )}
        </Card>
        </>)}

        {devUnlocked && (<>
                <SectionTitle>EXPERIMENTS</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 16 }]}>Backtest a habit change with 30 days after the intervention. Uses daily spend, local trend and day-of-week seasonality; it never claims certainty.</Text>
          <TextInput value={expName} onChangeText={setExpName} placeholder="Experiment name (e.g. no Fuliza)" placeholderTextColor={C.dim}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 8 }]} />
          <TextInput value={expLabel} onChangeText={setExpLabel} placeholder="Category (optional, e.g. Debt repayment)" placeholderTextColor={C.dim}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6 }]} />
          <Btn label="Run 30-day backtest" kind="soft" onPress={startExperiment} style={{ marginTop: 8, paddingVertical: 9 }} />
          {experiments.slice(0, 2).map((e) => {
            let r: { cumulativeEffect?: number; lo95?: number; hi95?: number; pNegative?: number } = {};
            try { r = e.resultJson ? JSON.parse(e.resultJson) as typeof r : {}; } catch { r = {}; }
            return (
              <View key={e.id} style={{ marginTop: 8 }}>
                <Text style={text(11, C.text, "600")}>{e.name} {e.status === "completed" ? `· ${kes(Math.round(r.cumulativeEffect ?? 0))}` : "· running"}</Text>
                {e.resultJson && <Text style={text(9, C.dim)}>95% CI {kes(Math.round(r.lo95 ?? 0))} to {kes(Math.round(r.hi95 ?? 0))} · P(neg) {Math.round((r.pNegative ?? 0) * 100)}%</Text>}
              </View>
            );
          })}
        </Card>
        </>)}

                <SectionTitle>NOTIFICATIONS</SectionTitle>
        <Card>
          <Row label="Permission" value={notifyInfo ? notifyInfo.permission : "checking…"} />
          <Row label="Channel" value={notifyInfo?.channel ? "Payment questions · high" : "not created yet"} />
          <Text style={[text(11, C.muted), { marginTop: 6, lineHeight: 16 }]}>
            Every new cash movement gets one tappable alert. Airtime credits, Okoa notices and standalone fee lines are deliberately silent because they are not cash movements.
          </Text>
          <TouchableOpacity onPress={() => { const next = !weekly; setWeekly(next); setWeeklyReviewEnabled(db, next); void syncWeeklyReview(db); }}
            accessibilityRole="switch" accessibilityState={{ checked: weekly }} accessibilityLabel="Weekly review, Sunday 6 pm"
            style={{ flexDirection: "row", alignItems: "center", minHeight: 48, borderTopWidth: 1, borderTopColor: C.line, marginTop: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={text(12, C.text, "600")}>Weekly review</Text>
              <Text style={text(10, C.dim)}>Sunday 6 pm · habits, patterns and credit use</Text>
            </View>
            <Pill label={weekly ? "on" : "off"} tone={weekly ? "green" : "dim"} />
          </TouchableOpacity>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Btn label="Send a test" kind="soft" onPress={() => void testNotification()} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Refresh status" kind="soft" onPress={() => { void notificationState().then(setNotifyInfo); }} style={{ flex: 1, paddingVertical: 9 }} />
          </View>
          {notifyMsg ? <Text style={[text(10, notifyMsg.startsWith("Sent") ? C.green : C.amber), { marginTop: 7 }]}>{notifyMsg}</Text> : null}
        </Card>

        <SectionTitle>CAPTURE CONTROLS</SectionTitle>
        <CaptureControls db={db} onChanged={bump} />

        <SectionTitle>LIVE CONNECTORS</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 16 }]}>On-device only. Calendar events are matched to transaction times; contacts only unmask masked payers; location is a passive last-known snapshot at SMS arrival. No continuous tracking, no upload.</Text>
          <Row label="Calendar" value={conn ? `${conn.calendar.enabled ? "on" : "off"} · ${conn.calendar.events} events · ${conn.calendar.updated} tx` : "…"} />
          <Row label="Contacts" value={conn ? `${conn.contacts.contacts} read · ${conn.contacts.linked} linked` : "…"} />
          <Row label="Location" value={conn ? `${conn.location.permission}${conn.location.enabled ? " · on" : ""}` : "…"} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Btn label="Calendar" kind="soft" onPress={calendarConnector} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Contacts" kind="soft" onPress={contactsConnector} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Location" kind="soft" onPress={locationConnector} style={{ flex: 1, paddingVertical: 9 }} />
          </View>
        </Card>

        <SectionTitle>THINGS & WARRANTIES</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 17 }]}>Track a product from a payment photo. Warranty dates, brand lifespans and local similar-photo matching stay on this phone.</Text>
          <Btn label="Open things & warranties" kind="soft" onPress={() => setThings(true)} style={{ marginTop: 10, paddingVertical: 9 }} />
        </Card>

        <LockSettings db={db} onChanged={bump} />

        <SectionTitle>ASSISTANT (OPTIONAL, NETWORK)</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 16 }]}>Connect a cloud or local model to suggest a setup from coarse summaries and your typed goals. Off by default; the app is complete without it.</Text>
          <Btn label="Open assistant connection" kind="soft" onPress={() => setAssistant(true)} style={{ marginTop: 10, paddingVertical: 9 }} />
        </Card>

        <SectionTitle>RETENTION</SectionTitle>
        <Card>
          <Text style={text(12, C.muted)}>Delete raw SMS bodies after:</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
            {[0, 30, 90, 365].map((d) => (
              <TouchableOpacity key={d} onPress={() => { setRetentionDays(a, d); setRetention(d); bump(); }} activeOpacity={0.7}>
                <Pill label={d === 0 ? "never" : `${d} days`} tone={retention === d ? "blue" : "dim"} />
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[text(10, C.dim), { marginTop: 8, lineHeight: 15 }]}>
            Transaction rows and your labels stay; only the raw message text is purged. 0 (never) is the default.
          </Text>
        </Card>

        <SectionTitle>ON-DEVICE INTELLIGENCE</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 16 }]}>Download explanations, Kiswahili translation or receipt reading once; after that they work with the network off.</Text>
          {([
            ["Explanations", [MODELS.qwen3_06b!]],
            ["Kiswahili", [MODELS.afri_08b_q4!]],
            ["Receipt reading", [MODELS.ocr_latin!, MODELS.ocr_craft!]],
          ] as Array<[string, ModelSpec[]]>).map(([name, specs]) => {
            const installed = specs.every((s) => !!localPath(s));
            return (
              <View key={name} style={{ flexDirection: "row", alignItems: "center", marginTop: 9 }}>
                <Text style={[text(12, C.text), { flex: 1 }]}>{name}</Text>
                <Pill label={installed ? "installed" : "not installed"} tone={installed ? "green" : "dim"} />
              </View>
            );
          })}
          <Btn label="Open model setup" kind="soft" onPress={() => onSetupModels?.()} style={{ marginTop: 10, paddingVertical: 9 }} />
        </Card>

{devUnlocked && (<>
                <SectionTitle>MODEL POLICY (DEFAULT-DENY)</SectionTitle>
        <Card>
          {POLICY_MANIFEST.entries.map((e) => (
            <View key={e.id} style={{ paddingVertical: 5 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={[text(11, C.text, "600"), { flex: 1 }]} numberOfLines={1}>{e.id}</Text>
                <Pill label={e.uses.inference} tone={e.uses.inference === "allowed" ? "green" : e.uses.inference === "forbidden" ? "red" : "amber"} />
              </View>
              <Text style={text(9, C.dim)}>{e.provider} · {e.zones.join("/")} · {e.verifiedAt ? `read ${e.verifiedAt}` : "terms unverified"}</Text>
            </View>
          ))}
          <Text style={[text(10, C.dim), { marginTop: 8, lineHeight: 15 }]}>
            A model not listed is denied. Unverified terms are denied except the shipped local base model. Training gates call this policy before touching data.
          </Text>
        </Card>
        </>)}

                <SectionTitle>LEDGER AUDIT</SectionTitle>
        <Card><LedgerAudit db={db} onChanged={bump} /></Card>

        <SectionTitle>DATA</SectionTitle>
        <Card>
          <Row label="Transactions" value={`${(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_events`)?.n ?? 0)}`} />
          <Row label="Raw SMS rows" value={`${(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM sms_raw`)?.n ?? 0)}`} />
          <Row label="Messages" value={`${(db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`)?.n ?? 0)}`} />
          <BackupSection db={db} onChanged={bump} />
          {process.env.EXPO_PUBLIC_DEMO === "1" && (
            <Btn label="Demo: a Ksh30 cigarette payment arrives" kind="soft" onPress={() => { void sendCigarettePayment(db).then((id) => { if (id) Alert.alert("Demo payment captured", "Lock the phone now: the capture notification is waiting."); else Alert.alert("Demo payment", "The ledger has no balance yet; seed the demo first."); }); }} style={{ marginTop: 8 }} />
          )}
          {devUnlocked && <Btn label="Developer diagnostics" kind="ghost" onPress={() => setDiag(true)} style={{ marginTop: 8 }} />}
        </Card>

        <View style={{ alignItems: "center", marginTop: 24 }}>
          <Text style={text(10, C.dim)} onPress={() => { setDevTaps((prev) => { const n = prev + 1; if (n >= 7) setDevUnlocked(true); return n; }); }}>Pesanalysis · dev.yako.app · local-first</Text>
          <Text style={[text(10, C.dim), { marginTop: 3 }]}>No bank connection. No cloud model in the core path.</Text>
        </View>
      </ScrollView>

      <IdentityWizard visible={wizard} db={db} onClose={() => setWizard(false)} onSaved={() => { const p = getProfile(a); setProfile(p); setName(p.name ?? ""); bump(); }} />

      <Modal visible={things} animationType="slide" onRequestClose={() => setThings(false)}>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={{ flexDirection: "row", padding: 16, paddingTop: 34 }}>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setThings(false)}><Text style={text(13, C.blue, "600")}>Close</Text></TouchableOpacity>
          </View>
          <ThingsScreen db={db} onChanged={bump} />
        </View>
      </Modal>

      <Modal visible={diag} animationType="slide" onRequestClose={() => setDiag(false)}>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={{ flexDirection: "row", padding: 16, paddingTop: 34 }}>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setDiag(false)}><Text style={text(13, C.blue, "600")}>Close</Text></TouchableOpacity>
          </View>
          {assistant && <View style={{ position: "absolute", inset: 0, backgroundColor: C.bg, zIndex: 80 }}><AssistantScreen db={db} onClose={() => setAssistant(false)} /></View>}
      <DiagnosticsScreen onDataChanged={() => { bump(); }} />
        </View>
      </Modal>
    </Screen>
  );
}
