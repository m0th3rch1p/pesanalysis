import { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  LANGUAGES, PACKS, TONES, applyPack, getProfile, inferIdentity, recordFact, setProfile,
  type IdentityHypothesis,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Card, Pill, text } from "../ui";

export function IdentityWizard({ visible, db, onClose, onSaved }: {
  visible: boolean; db: SQLiteDatabase; onClose: () => void; onSaved: () => void;
}) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [tone, setTone] = useState("plain");
  const [language, setLanguage] = useState("en");
  const [hy, setHy] = useState<IdentityHypothesis[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setStep(0);
    const a = asDbAdapter(db);
    const p = getProfile(a);
    setName(p.name ?? ""); setTone(p.tone); setLanguage(p.language);
    setCustom(p.identityCustom ?? "");
    setPicked(new Set(p.verticals));
    try { setHy(inferIdentity(a)); } catch { setHy([]); }
  }, [visible, db]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = () => {
    if (busy) return;
    setBusy(true);
    try {
      const a = asDbAdapter(db);
      for (const id of picked) {
        try { applyPack(a, id); } catch { /* pack unknown: skip, never lose the rest */ }
      }
      setProfile(a, {
        verticals: [...picked], tone, language,
        name: name.trim() || undefined,
        identityCustom: custom.trim() || undefined,
      });
      if (custom.trim()) recordFact(a, "user", "occupation", custom.trim(), { confidence: 0.9, source: "user" });
      recordFact(a, "user", "identity_confirmed", "yes", { confidence: 1, source: "user" });
      onSaved();
      onClose();
    } catch (e) {
      Alert.alert("Could not save", String(e).slice(0, 180));
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 18, paddingTop: 36 }}>
          <Text style={text(18, C.text, "700")}>A quick setup</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={onClose}><Text style={text(13, C.muted)}>Close</Text></TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {step === 0 ? (
            <>
              <Text style={text(26, C.text, "700")}>How do you mostly make money?</Text>
              <Text style={[text(13, C.muted), { marginTop: 6, lineHeight: 20 }]}>
                I can guess from your messages, but you decide. Pick one or more. You can change this later.
              </Text>

              {hy.length > 0 && (
                <Card style={{ marginTop: 16, borderColor: C.blue }}>
                  <Text style={text(10, C.blue, "700")}>FROM YOUR MESSAGES</Text>
                  {hy.map((h) => (
                    <TouchableOpacity key={h.packId} onPress={() => toggle(h.packId)} activeOpacity={0.8}
                      style={{ marginTop: 10, borderRadius: 12, padding: 10, backgroundColor: picked.has(h.packId) ? "#0A84FF20" : C.card2, borderWidth: 1, borderColor: picked.has(h.packId) ? C.blue : C.line }}>
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <Text style={text(13, C.text, "700")}>{h.name}</Text>
                        <View style={{ flex: 1 }} />
                        <Pill label={`${Math.round(h.confidence * 100)}% match`} tone={h.confidence >= 0.6 ? "blue" : "dim"} />
                      </View>
                      {h.why.map((w) => <Text key={w} style={[text(11, C.muted), { marginTop: 3 }]}>· {w}</Text>)}
                    </TouchableOpacity>
                  ))}
                </Card>
              )}

              <Text style={[text(11, C.muted, "700"), { marginTop: 20 }]}>OTHER WORK</Text>
              <View style={{ gap: 8, marginTop: 8 }}>
                {PACKS.filter((p) => !hy.some((h) => h.packId === p.id)).map((p) => (
                  <TouchableOpacity key={p.id} onPress={() => toggle(p.id)} activeOpacity={0.8}
                    style={{ borderRadius: 12, padding: 12, backgroundColor: picked.has(p.id) ? "#0A84FF20" : C.card2, borderWidth: 1, borderColor: picked.has(p.id) ? C.blue : C.line }}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Text style={text(13, C.text, "600")}>{p.name}</Text>
                      <View style={{ flex: 1 }} />
                      {picked.has(p.id) && <Pill label="on" tone="blue" />}
                    </View>
                    <Text style={[text(11, C.muted), { marginTop: 3 }]}>{p.blurb}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>NONE OF THESE FIT?</Text>
              <TextInput value={custom} onChangeText={setCustom} placeholder="Describe it in your own words, e.g. fish trader"
                placeholderTextColor={C.dim}
                style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8, borderWidth: 1, borderColor: custom.trim() ? C.blue : C.line }]} />
              <Text style={[text(10, C.dim), { marginTop: 5 }]}>This is saved as your own description. It is not uploaded.</Text>

              <Btn label="Next" onPress={() => setStep(1)} disabled={picked.size === 0 && !custom.trim()} style={{ marginTop: 20 }} />
            </>
          ) : (
            <>
              <Text style={text(26, C.text, "700")}>Last few things</Text>
              <Text style={[text(13, C.muted), { marginTop: 6 }]}>All optional. This only changes how Pesanalysis talks to you.</Text>

              <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>WHAT SHOULD I CALL YOU?</Text>
              <TextInput value={name} onChangeText={setName} placeholder="e.g. Wanjiku" placeholderTextColor={C.dim}
                style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 }]} />

              <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>HOW SHOULD I TALK?</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
                {TONES.map((t) => (
                  <TouchableOpacity key={t.id} onPress={() => setTone(t.id)}><Pill label={t.name} tone={tone === t.id ? "blue" : "dim"} /></TouchableOpacity>
                ))}
              </View>

              <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>WORDS FOR MONEY</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
                {LANGUAGES.map((l) => (
                  <TouchableOpacity key={l.id} onPress={() => setLanguage(l.id)}><Pill label={l.name} tone={language === l.id ? "blue" : "dim"} /></TouchableOpacity>
                ))}
              </View>

              <Card style={{ marginTop: 20 }}>
                <Text style={text(11, C.muted, "700")}>YOU PICKED</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {[...picked].map((id) => <Pill key={id} label={PACKS.find((p) => p.id === id)?.name ?? id} tone="blue" />)}
                  {custom.trim() ? <Pill label={custom.trim()} tone="amber" /> : null}
                  {picked.size === 0 && !custom.trim() ? <Text style={text(12, C.muted)}>Nothing yet</Text> : null}
                </View>
              </Card>

              <Btn label={busy ? "Saving…" : "Finish setup"} onPress={save} disabled={busy || (picked.size === 0 && !custom.trim())} style={{ marginTop: 18 }} />
              <TouchableOpacity onPress={() => setStep(0)} style={{ marginTop: 12, alignSelf: "center" }}>
                <Text style={text(12, C.blue, "600")}>Back</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
