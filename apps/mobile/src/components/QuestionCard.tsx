import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import * as Haptics from "expo-haptics";
import { answerQuestion, dismissQuestion, type Question } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { C, Pill, text } from "../ui";

export function QuestionCard({ db, q, onAnswered }: { db: SQLiteDatabase; q: Question; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const answer = (a: string) => {
    if (busy) return;
    setBusy(true);
    try {
      void Haptics.selectionAsync();
      answerQuestion(asDbAdapter(db), q.id, a);
      setCustom("");
      onAnswered();
    } catch { /* leave the card in place */ }
    setBusy(false);
  };
  const dismiss = () => {
    try { dismissQuestion(asDbAdapter(db), q.id); onAnswered(); } catch { /* ignore */ }
  };
  return (
    <View style={{ backgroundColor: C.card, borderRadius: 18, padding: 15, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pill label={q.kind.replace(/_/g, " ")} tone="amber" />
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={dismiss}><Text style={text(11, C.dim)}>Not now</Text></TouchableOpacity>
      </View>
      <Text style={[text(15, C.text, "600"), { marginTop: 8, lineHeight: 21 }]}>{q.prompt}</Text>
      <Text style={[text(11, C.muted), { marginTop: 4, lineHeight: 16 }]}>{q.why}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 }}>
        {(q.options ?? []).slice(0, 10).map((o) => (
          <TouchableOpacity key={o} onPress={() => answer(o)} disabled={busy} activeOpacity={0.7}
            style={{ backgroundColor: C.card2, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={text(12, C.text, "600")}>{o}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {(q.kind === "unknown_role" || q.kind === "income_type") && (
        <View style={{ flexDirection: "row", gap: 7, marginTop: 9 }}>
          <TextInput
            value={custom} onChangeText={setCustom}
            placeholder="Or type your own role / tag"
            placeholderTextColor={C.dim}
            returnKeyType="done"
            onSubmitEditing={() => { if (custom.trim()) answer(custom.trim()); }}
            style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }]}
          />
          <TouchableOpacity onPress={() => { if (custom.trim()) answer(custom.trim()); }} disabled={!custom.trim() || busy}>
            <Text style={text(12, C.blue, "600")}>Use</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
