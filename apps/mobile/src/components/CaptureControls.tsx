import { useState } from "react";
import { Text, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  capturePausedUntil, getQuietCapturePolicy, listSuppressedCounterparties, pauseCaptureUntil,
  resumeCapture, setQuietCapturePolicy, unsuppressCounterparty,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Card, Pill, text } from "../ui";

const untilLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** D109 controls: pause, quiet-hours policy and the per-counterparty never-ask list. */
export function CaptureControls({ db, onChanged }: { db: SQLiteDatabase; onChanged?: () => void }) {
  const a = asDbAdapter(db);
  const [paused, setPaused] = useState(() => capturePausedUntil(a));
  const [policy, setPolicy] = useState(() => getQuietCapturePolicy(a));
  const [suppressed, setSuppressed] = useState(() => {
    try { return listSuppressedCounterparties(a); } catch { return []; }
  });
  const refresh = () => {
    setPaused(capturePausedUntil(a));
    setPolicy(getQuietCapturePolicy(a));
    try { setSuppressed(listSuppressedCounterparties(a)); } catch { setSuppressed([]); }
    onChanged?.();
  };
  const pause = (ms: number) => { pauseCaptureUntil(a, Date.now() + ms); refresh(); };
  const resume = () => { resumeCapture(a); refresh(); };
  const flipPolicy = () => {
    const next = policy === "hold" ? "ask_anyway" : "hold";
    setQuietCapturePolicy(a, next); refresh();
  };

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={text(12, C.text, "600")}>Payment questions</Text>
          <Text style={[text(10, C.dim), { marginTop: 2 }]}>
            {paused && paused > Date.now() ? `Paused until ${untilLabel(paused)}` : "On — every fresh payment can ask once"}
          </Text>
        </View>
        <Pill label={paused && paused > Date.now() ? "paused" : "on"} tone={paused && paused > Date.now() ? "amber" : "green"} />
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
        {paused && paused > Date.now()
          ? <Btn label="Resume now" kind="soft" onPress={resume} style={{ flex: 1, paddingVertical: 9 }} />
          : <>
            <Btn label="Pause 1 h" kind="soft" onPress={() => pause(60 * 60_000)} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Until tomorrow" kind="soft" onPress={() => pause(24 * 60 * 60_000)} style={{ flex: 1, paddingVertical: 9 }} />
            <Btn label="Pause 1 week" kind="soft" onPress={() => pause(7 * 24 * 60 * 60_000)} style={{ flex: 1, paddingVertical: 9 }} />
          </>}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: C.line, marginTop: 10, paddingTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={text(12, C.text, "600")}>During quiet hours</Text>
          <Text style={text(10, C.dim)}>{policy === "hold" ? "Hold questions until morning" : "Ask anyway — you are awake and transacting"}</Text>
        </View>
        <Text onPress={flipPolicy} accessibilityRole="switch" accessibilityState={{ checked: policy === "hold" }} accessibilityLabel="Hold payment questions during quiet hours" style={text(12, C.blue, "600")}>{policy === "hold" ? "hold" : "ask"}</Text>
      </View>
      {suppressed.length > 0 && (
        <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 10, paddingTop: 8 }}>
          <Text style={text(11, C.muted, "700")}>NEVER ASK</Text>
          {suppressed.map((s) => (
            <View key={s.id} style={{ flexDirection: "row", alignItems: "center", minHeight: 40 }}>
              <Text style={[text(12, C.text), { flex: 1 }]} numberOfLines={1}>{s.name}</Text>
              <Text onPress={() => { unsuppressCounterparty(a, s.id); refresh(); }} accessibilityRole="button" accessibilityLabel={`Ask about ${s.name} again`} style={text(12, C.blue, "600")}>ask again</Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}
