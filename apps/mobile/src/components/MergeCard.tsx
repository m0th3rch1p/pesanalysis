import { useEffect, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  dismissMergeCandidate, listMergeCandidates, mergeCounterparties, suggestCounterpartyMerges,
  type CounterpartyMergeCandidate,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Card, Pill, text } from "../ui";

function shortKey(key: string): string {
  if (key.startsWith("p:")) return `+${key.slice(2, 5)}…${key.slice(-3)}`;
  if (key.startsWith("m:")) return key.slice(2, 12).replace(/\*/g, "•");
  return key.slice(0, 18);
}

export function MergeCard({ db, onChanged, refreshKey = 0 }: { db: SQLiteDatabase; onChanged: () => void; refreshKey?: number }) {
  const [rows, setRows] = useState<CounterpartyMergeCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => {
    try { setRows(suggestCounterpartyMerges(asDbAdapter(db), Date.now(), 4)); } catch { setRows([]); }
  };
  useEffect(load, [db, refreshKey]);

  if (!rows.length) return null;
  const accept = (r: CounterpartyMergeCandidate) => {
    if (busy) return;
    setBusy(true);
    try {
      mergeCounterparties(asDbAdapter(db), r.leftId, r.rightId);
      load(); onChanged();
    } catch (e) { Alert.alert("Could not merge", String(e).slice(0, 180)); }
    finally { setBusy(false); }
  };
  const dismiss = (r: CounterpartyMergeCandidate) => {
    try { dismissMergeCandidate(asDbAdapter(db), r.id); setRows(listMergeCandidates(asDbAdapter(db), 4)); } catch { /* ignore */ }
  };

  return (
    <Card style={{ marginBottom: 10, borderColor: "#2A3550" }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={text(12, C.blue, "700")}>POSSIBLE SAME PERSON</Text>
        <View style={{ flex: 1 }} />
        <Text style={text(9, C.dim)}>you decide</Text>
      </View>
      {rows.map((r) => (
        <View key={r.id} style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ flex: 1 }}>
              <Text style={text(12, C.text, "600")} numberOfLines={1}>{r.leftName}</Text>
              <Text style={text(9, C.dim)}>{shortKey(r.leftKey)} · {r.leftCount} tx</Text>
            </View>
            <Pill label="same?" tone={r.score >= 0.9 ? "green" : "amber"} />
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              <Text style={text(12, C.text, "600")} numberOfLines={1}>{r.rightName}</Text>
              <Text style={text(9, C.dim)}>{shortKey(r.rightKey)} · {r.rightCount} tx</Text>
            </View>
          </View>
          <Text style={[text(10, C.muted), { marginTop: 5, lineHeight: 15 }]}>{r.reason} · {Math.round(r.score * 100)}% match</Text>
          <View style={{ flexDirection: "row", gap: 7, marginTop: 7 }}>
            <Btn label="Yes, one person" kind="soft" onPress={() => accept(r)} style={{ flex: 1, paddingVertical: 8 }} />
            <Btn label="Keep separate" kind="ghost" onPress={() => dismiss(r)} style={{ flex: 1, paddingVertical: 8 }} />
          </View>
        </View>
      ))}
    </Card>
  );
}
