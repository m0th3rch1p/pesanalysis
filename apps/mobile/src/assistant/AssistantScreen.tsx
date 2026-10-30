import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  applyPersonalizationPack, diffPack, dryRun, listHistory, loadReplayRows, loadState, renderDiff, rollbackLast,
  serialiseZ2Payload, setKillSwitch, isKilled, type PackVerdict,
} from "@yako/core";
import { Btn, C, Card, Pill, Screen, SectionTitle, text } from "../ui";
import { asDbAdapter } from "../db/open";
import { PRESETS, presetById, checkSettings, type AssistantSettings } from "./presets";
import { loadSettings, saveSettings, saveApiKey, hasApiKey, forgetConnection } from "./store";
import { buildPersonalizeCall, buildTestCall, makeClient, newSessionId } from "./session";

/**
 * Assistant connection (D92, docs/plan/09). Off by default. Nothing is sent without showing the exact
 * bytes and recording consent bound to their hash. Model output is validated, diffed and dry-run
 * before a personalization pack can be applied; rollback is one tap.
 */
export function AssistantScreen({ db, onClose }: { db: SQLiteDatabase; onClose: () => void }) {
  const a = asDbAdapter(db);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [presetId, setPresetId] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [session] = useState(newSessionId);
  const [goals, setGoals] = useState("Keep a buffer of one week's spending; stop using Fuliza for small amounts");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{ url: string; bytes: number; fields: string[]; body: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pack, setPack] = useState<PackVerdict | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ id: number; at: number; status: string }>>([]);
  const [killed, setKilled] = useState(false);

  const refresh = async () => {
    const s = await loadSettings();
    setSettings(s);
    if (s) { setPresetId(s.presetId); setBaseUrl(s.baseUrl); setModel(s.model); }
    setKeySet(await hasApiKey());
    setHistory(listHistory(a) as never);
    setKilled(isKilled(a));
  };
  useEffect(() => { void refresh(); }, []);

  const choosePreset = (id: string) => {
    const p = presetById(id);
    if (!p) return;
    setPresetId(id); setBaseUrl(p.baseUrl);
  };

  const save = async () => {
    const s: AssistantSettings = { presetId, baseUrl, model, callsPerDay: settings?.callsPerDay ?? 20, tokensPerDay: settings?.tokensPerDay ?? 100_000 };
    const c = checkSettings(s);
    if (!c.ok) { Alert.alert("Check the settings", c.reason); return; }
    try {
      await saveSettings(s);
      if (key.trim()) await saveApiKey(key);
      setKey("");
      await refresh();
      Alert.alert("Saved on this phone", "The API key is in the phone's secure storage. It is never included in backups or logs.");
    } catch (e) { Alert.alert("Could not save", String(e).slice(0, 160)); }
  };

  const makeCall = () => {
    if (!settings) throw new Error("Save the connection first.");
    return makeClient(settings, db);
  };

  const doPreview = async (kind: "test" | "personalize") => {
    try {
      const client = makeCall();
      const call = kind === "test" ? buildTestCall(session) : buildPersonalizeCall(db, session, goals.split(";").map((g) => g.trim()).filter(Boolean), note);
      const p = client.preview(call);
      setPreview({ url: p.url, bytes: p.bytes, fields: p.fieldList, body: p.body });
      setPack(null); setDiff(null); setResult(null);
    } catch (e) { Alert.alert("Preview failed", String(e).slice(0, 200)); }
  };

  const doSend = async (kind: "test" | "personalize") => {
    if (!preview) return;
    if (!consent) { Alert.alert("Consent needed", "Tick the box after reading what would leave the phone."); return; }
    setBusy(true);
    try {
      const client = makeCall();
      const call = kind === "test" ? buildTestCall(session) : buildPersonalizeCall(db, session, goals.split(";").map((g) => g.trim()).filter(Boolean), note);
      const p = client.preview(call);
      if (p.hash !== undefined) client.grantConsent(session, p.hash);
      if (kind === "test") {
        const r = await client.send(call);
        setResult(r.text.slice(0, 2000));
      } else {
        const r = await client.personalize(call);
        setPack(r.pack);
        if (r.pack.accepted && r.pack.pack) {
          const before = loadState(a);
          const d = diffPack(before, r.pack.pack);
          setDiff(renderDiff(d));
          const dr = dryRun(before, r.pack.pack, { rows: loadReplayRows(a, Date.now()) });
          setResult(`Validation passed.\nDry run: ${JSON.stringify(dr.effects ?? dr, null, 1).slice(0, 1600)}`);
        } else {
          setResult(`The suggestion was rejected by the validator:\n${r.pack.reasons.join(", ")}`);
        }
      }
    } catch (e) {
      setResult(`Blocked or failed: ${String(e).slice(0, 220)}`);
    } finally { setBusy(false); setConsent(false); }
  };

  const apply = () => {
    if (!pack?.accepted || !pack.pack || !diff) return;
    try {
      const before = loadState(a);
      const d = diffPack(before, pack.pack);
      const r = applyPersonalizationPack(a, pack.pack, { confirmed: true, origin: "user_ui", diffHash: d.hash });
      setResult(`Applied. Version ${JSON.stringify(r).slice(0, 120)}. You can roll back below.`);
      void refresh();
    } catch (e) { Alert.alert("Not applied", String(e).slice(0, 200)); }
  };

  const p = presetById(presetId);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 26, paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={text(26, C.text, "700")} accessibilityRole="header">Assistant connection</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={onClose} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button"><Text style={text(12, C.blue, "600")}>Close</Text></TouchableOpacity>
        </View>
        <Text style={[text(12, C.muted), { marginTop: 6, lineHeight: 18 }]}>
          Optional and off by default. It sends only coarse summaries (bands, counts at least 5, no names, no phone numbers, no message text) and your own typed goals. The app works fully without it, and it is never used in the offline demo.
        </Text>

        <SectionTitle>PROVIDER</SectionTitle>
        <Card>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PRESETS.map((pr) => (
              <TouchableOpacity key={pr.id} onPress={() => choosePreset(pr.id)} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityState={{ selected: presetId === pr.id }}>
                <Pill label={pr.label.length > 28 ? `${pr.label.slice(0, 27)}…` : pr.label} tone={presetId === pr.id ? "blue" : "dim"} />
              </TouchableOpacity>
            ))}
          </View>
          {p && <Text style={[text(11, C.muted), { marginTop: 8, lineHeight: 16 }]}>{p.recipient} {p.termsNote}</Text>}
          {p?.warning && <Text style={[text(11, C.amber), { marginTop: 6, lineHeight: 16 }]}>{p.warning}</Text>}
          <TextInput value={baseUrl} onChangeText={setBaseUrl} placeholder="https://host/v1" autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim}
            style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 11, marginTop: 10 }]} accessibilityLabel="Endpoint URL" />
          <TextInput value={model} onChangeText={setModel} placeholder="Model name (e.g. gpt-4o-mini)" autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim}
            style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 11, marginTop: 8 }]} accessibilityLabel="Model name" />
          {p?.needsKey && (
            <TextInput value={key} onChangeText={setKey} placeholder={keySet ? "API key saved — type to replace" : "API key"} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim}
              style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 11, marginTop: 8 }]} accessibilityLabel="API key" />
          )}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <Btn label="Save on phone" kind="primary" onPress={() => void save()} style={{ flex: 1, minHeight: 48 }} />
            <Btn label="Forget" kind="ghost" onPress={() => Alert.alert("Forget connection?", "Removes the endpoint, model and API key from this phone.", [
              { text: "Cancel", style: "cancel" },
              { text: "Forget", style: "destructive", onPress: async () => { await forgetConnection(); setSettings(null); await refresh(); } },
            ])} style={{ flex: 1, minHeight: 48 }} />
          </View>
        </Card>

        <SectionTitle>WHAT LEAVES THIS PHONE</SectionTitle>
        <Card>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn label="Preview a test" kind="soft" onPress={() => void doPreview("test")} style={{ flex: 1, minHeight: 48 }} />
            <Btn label="Preview personalization" kind="soft" onPress={() => void doPreview("personalize")} style={{ flex: 1, minHeight: 48 }} />
          </View>
          {preview && (
            <View style={{ marginTop: 10 }}>
              <Text style={text(11, C.muted)}>Sends {preview.bytes} bytes to {preview.url}</Text>
              <Text style={[text(10, C.dim), { marginTop: 4, lineHeight: 15 }]}>Fields: {preview.fields.join(", ") || "none"}</Text>
              <View style={{ backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 8 }}>
                <Text style={[text(9, C.muted), { fontFamily: "monospace" }]} numberOfLines={12}>{preview.body}</Text>
              </View>
              <TouchableOpacity onPress={() => setConsent(!consent)} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, minHeight: 48 }} accessibilityRole="checkbox" accessibilityState={{ checked: consent }}>
                <View style={{ width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: consent ? C.green : C.muted, alignItems: "center", justifyContent: "center" }}><Text style={text(12, C.green, "700")}>{consent ? "✓" : ""}</Text></View>
                <Text style={[text(12, C.text), { flex: 1, lineHeight: 17 }]}>I have read this and agree to send exactly these bytes for this session.</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                <Btn label={busy ? "Sending…" : "Test connection"} kind="soft" disabled={busy} onPress={() => void doSend("test")} style={{ flex: 1, minHeight: 48 }} />
                <Btn label={busy ? "Sending…" : "Ask for a setup"} kind="primary" disabled={busy} onPress={() => void doSend("personalize")} style={{ flex: 1, minHeight: 48 }} />
              </View>
            </View>
          )}
          {result && <View style={{ backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 10 }}><Text style={[text(11, C.text), { lineHeight: 17 }]}>{result}</Text></View>}
        </Card>

        <SectionTitle>PERSONALIZATION PACK</SectionTitle>
        <Card>
          <Text style={[text(11, C.muted), { lineHeight: 16 }]}>Your goals (separated by ;). They are sent verbatim, so keep them non-personal.</Text>
          <TextInput value={goals} onChangeText={setGoals} multiline placeholderTextColor={C.dim}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 8, minHeight: 64 }]} accessibilityLabel="Goals" />
          <TextInput value={note} onChangeText={setNote} placeholder="Anything else the assistant should know (optional)" placeholderTextColor={C.dim}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 8 }]} accessibilityLabel="Note" />
          {diff && (
            <View style={{ marginTop: 10 }}>
              <Text style={text(11, C.muted, "700")}>DIFF</Text>
              <Text style={[text(11, C.text), { marginTop: 4, lineHeight: 17 }]}>{diff}</Text>
              <Btn label="Apply this pack" kind="primary" onPress={apply} style={{ marginTop: 10, minHeight: 48 }} />
            </View>
          )}
          <Text style={[text(10, C.dim), { marginTop: 10, lineHeight: 15 }]}>Packs cannot change zones, permissions, connectors, safety alerts or tariffs. Every applied pack is versioned and can be rolled back.</Text>
        </Card>

        <SectionTitle>SAFETY & HISTORY</SectionTitle>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
            <View style={{ flex: 1 }}>
              <Text style={text(12, C.text, "600")}>Kill switch</Text>
              <Text style={[text(10, C.dim), { marginTop: 2 }]}>Blocks every future call and wipes retained payload text.</Text>
            </View>
            <TouchableOpacity onPress={() => { setKillSwitch(a, !killed); setKilled(!killed); }} style={{ minHeight: 48, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }} accessibilityRole="switch" accessibilityState={{ checked: killed }} accessibilityLabel="Kill switch">
              <Pill label={killed ? "engaged" : "off"} tone={killed ? "red" : "dim"} />
            </TouchableOpacity>
          </View>
          {history.slice(0, 6).map((h) => (
            <View key={h.id} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <Text style={text(10, C.dim)}>v{h.id} · {new Date(h.at).toLocaleString("en-GB")}</Text>
              <Text style={text(10, C.muted)}>{h.status}</Text>
            </View>
          ))}
          <Btn label="Roll back the last pack" kind="ghost" onPress={() => { try { const r = rollbackLast(a); Alert.alert("Rolled back", JSON.stringify(r).slice(0, 160)); void refresh(); } catch (e) { Alert.alert("Nothing to roll back", String(e).slice(0, 140)); } }} style={{ marginTop: 10, minHeight: 48 }} />
        </Card>

        <Text style={[text(10, C.dim), { marginTop: 16, lineHeight: 15 }]}>
          Network feature. Declared separately for the submission; the offline demo does not use it.
        </Text>
      </ScrollView>
    </Screen>
  );
}
