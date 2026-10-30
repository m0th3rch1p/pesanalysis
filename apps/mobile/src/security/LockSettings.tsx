import { useEffect, useState } from "react";
import { Alert, Modal, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { C, Btn, Card, Pill, SectionTitle, text } from "../ui";
import { getLockConfig, setLockConfig, setPin, clearPin, type LockConfig, DEFAULT_TIMEOUT_MS } from "./settings";
import { isSecureScreen, setSecureScreen } from "../../modules/yako-sms";
import { checkChannels } from "../runtime/notifications";
import { modelHelpEnabled, setModelHelp } from "../ai/sms-worker";

/**
 * Privacy & lock (C2/C6): PIN + biometric app lock, auto-lock timeout, strict vault, screenshot privacy,
 * on-device model help toggle, and notification-channel health. Nothing here is enabled by default
 * except screenshot privacy.
 */
export function LockSettings({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const [cfg, setCfg] = useState<LockConfig | null>(null);
  const [pinModal, setPinModal] = useState(false);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [secure, setSecure] = useState(true);
  const [ai, setAi] = useState(true);
  const [channels, setChannels] = useState<{ guidance: string[] } | null>(null);
  const [pending, setPending] = useState<{ pending: number; proposed: number; rejected: number }>({ pending: 0, proposed: 0, rejected: 0 });

  const load = async () => {
    setCfg(await getLockConfig(db));
    setSecure(isSecureScreen());
    setAi(modelHelpEnabled(db));
    try {
      setChannels(await checkChannels());
      setPending({
        pending: db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM model_candidates WHERE status='pending'`)?.n ?? 0,
        proposed: db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM model_candidates WHERE status='proposed'`)?.n ?? 0,
        rejected: db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM model_candidates WHERE status='rejected'`)?.n ?? 0,
      });
    } catch { /* optional */ }
  };
  useEffect(() => { void load(); }, []);

  const savePin = async () => {
    if (pin1 !== pin2) { Alert.alert("PINs do not match", "Type the same PIN twice."); return; }
    setBusy(true);
    try {
      await setPin(pin1);
      await setLockConfig(db, { enabled: true });
      setPinModal(false); setPin1(""); setPin2("");
      await load(); onChanged();
      Alert.alert("App lock is on", "Pesanalysis will lock when you leave it. Your backup recovery code is the only way back in if you forget the PIN and the device credential.");
    } catch (e) { Alert.alert("Could not set PIN", String(e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async () => {
    if (!cfg) return;
    if (cfg.enabled) { await setLockConfig(db, { enabled: false }); await load(); onChanged(); return; }
    if (!cfg.hasPin) { setPinModal(true); return; }
    await setLockConfig(db, { enabled: true }); await load(); onChanged();
  };

  const timeout = cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (
    <>
      <SectionTitle>PRIVACY & LOCK</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
          <View style={{ flex: 1 }}>
            <Text style={text(13, C.text, "600")}>App lock</Text>
            <Text style={[text(11, C.muted), { marginTop: 2 }]}>Fingerprint, face or a PIN when you come back.</Text>
          </View>
          <TouchableOpacity onPress={() => void toggleEnabled()} style={{ minHeight: 48, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }} accessibilityRole="switch" accessibilityState={{ checked: !!cfg?.enabled }} accessibilityLabel="App lock">
            <Pill label={cfg?.enabled ? "on" : "off"} tone={cfg?.enabled ? "green" : "dim"} />
          </TouchableOpacity>
        </View>
        {cfg?.enabled && (
          <>
            <Text style={[text(11, C.muted), { marginTop: 8 }]}>Lock after</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 }}>
              {[[0, "immediately"], [30_000, "30 s"], [60_000, "1 min"], [300_000, "5 min"]].map(([ms, label]) => (
                <TouchableOpacity key={String(ms)} onPress={async () => { await setLockConfig(db, { timeoutMs: Number(ms) }); await load(); }} activeOpacity={0.7} accessibilityRole="button" accessibilityState={{ selected: timeout === ms }} style={{ minHeight: 48, justifyContent: "center" }}>
                  <Pill label={String(label)} tone={timeout === Number(ms) ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10, minHeight: 48 }}>
              <View style={{ flex: 1 }}>
                <Text style={text(12, C.text, "600")}>Strict vault</Text>
                <Text style={[text(10, C.dim), { marginTop: 2 }]}>Hold new messages on this phone until you unlock. Slower, more private.</Text>
              </View>
              <TouchableOpacity onPress={async () => { await setLockConfig(db, { strictVault: !cfg.strictVault }); await load(); }} style={{ minHeight: 48, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }} accessibilityRole="switch" accessibilityState={{ checked: cfg.strictVault }} accessibilityLabel="Strict vault">
                <Pill label={cfg.strictVault ? "on" : "off"} tone={cfg.strictVault ? "green" : "dim"} />
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Btn label="Change PIN" kind="soft" onPress={() => { setPin1(""); setPin2(""); setPinModal(true); }} style={{ flex: 1, paddingVertical: 10 }} />
              <Btn label="Remove PIN" kind="ghost" onPress={() => Alert.alert("Remove PIN?", "The app lock will be turned off.", [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: async () => { await clearPin(); await setLockConfig(db, { enabled: false }); await load(); onChanged(); } },
              ])} style={{ flex: 1, paddingVertical: 10 }} />
            </View>
          </>
        )}

        <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
          <View style={{ flex: 1 }}>
            <Text style={text(12, C.text, "600")}>Hide from screenshots and recents</Text>
            <Text style={[text(10, C.dim), { marginTop: 2 }]}>Turn off only to record a demo or take a screenshot.</Text>
          </View>
          <TouchableOpacity onPress={() => { const next = !secure; setSecureScreen(next); setSecure(next); }} style={{ minHeight: 48, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }} accessibilityRole="switch" accessibilityState={{ checked: secure }} accessibilityLabel="Screenshot privacy">
            <Pill label={secure ? "on" : "off"} tone={secure ? "green" : "amber"} />
          </TouchableOpacity>
        </View>

        <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
          <View style={{ flex: 1 }}>
            <Text style={text(12, C.text, "600")}>On-device help for unknown messages</Text>
            <Text style={[text(10, C.dim), { marginTop: 2 }]}>Lets the local model propose details for messages our templates cannot read. Suggestions wait for your confirmation. {pending.pending} waiting · {pending.proposed} proposed · {pending.rejected} declined.</Text>
          </View>
          <TouchableOpacity onPress={() => { const next = !ai; setModelHelp(db, next); setAi(next); }} style={{ minHeight: 48, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }} accessibilityRole="switch" accessibilityState={{ checked: ai }} accessibilityLabel="On-device model help">
            <Pill label={ai ? "on" : "off"} tone={ai ? "green" : "dim"} />
          </TouchableOpacity>
        </View>
        {!!channels?.guidance.length && (
          <View style={{ marginTop: 8 }}>
            {channels.guidance.map((g, i) => <Text key={i} style={[text(10, C.amber), { lineHeight: 15, marginTop: 3 }]}>{g}</Text>)}
          </View>
        )}
      </Card>

      <Modal visible={pinModal} transparent animationType="fade" onRequestClose={() => setPinModal(false)}>
        <View style={{ flex: 1, backgroundColor: "#000000AA", justifyContent: "center", padding: 22 }}>
          <Card>
            <Text style={text(17, C.text, "700")}>{cfg?.hasPin ? "Change PIN" : "Set a PIN"}</Text>
            <Text style={[text(11, C.muted), { marginTop: 4, lineHeight: 16 }]}>4–12 digits. Not all the same and not 0123… A forgotten PIN cannot be recovered: only your encrypted backup plus passphrase/recovery code restores the ledger.</Text>
            <TextInput value={pin1} onChangeText={setPin1} secureTextEntry keyboardType="number-pad" maxLength={12} placeholder="New PIN" placeholderTextColor={C.dim}
              style={[text(16, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 12, marginTop: 12 }]} accessibilityLabel="New PIN" />
            <TextInput value={pin2} onChangeText={setPin2} secureTextEntry keyboardType="number-pad" maxLength={12} placeholder="Repeat PIN" placeholderTextColor={C.dim}
              style={[text(16, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 12, marginTop: 8 }]} accessibilityLabel="Repeat PIN" />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <Btn label="Cancel" kind="ghost" onPress={() => setPinModal(false)} style={{ flex: 1, minHeight: 48 }} />
              <Btn label={busy ? "Saving…" : "Save PIN"} kind="primary" disabled={busy || pin1.length < 4} onPress={() => void savePin()} style={{ flex: 1, minHeight: 48 }} />
            </View>
          </Card>
        </View>
      </Modal>
    </>
  );
}
