import { useEffect, useState } from "react";
import { Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { displayEat, getProfile, weeklyReview, type WeeklyReview } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { createHabitExperiment } from "../experiments";
import { narrateOffline } from "../narrate";
import { C, Card, Pill, kes, text } from "../ui";
import { Btn } from "../ui";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function WeeklyReviewScreen({ db, onClose, onChanged, onOpenTx, onSetupModels }: {
  db: SQLiteDatabase; onClose: () => void; onChanged: () => void; onOpenTx?: (id: number) => void; onSetupModels?: () => void;
}) {
  const [data, setData] = useState<WeeklyReview | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(false);
  const [explain, setExplain] = useState<string | null>(null);
  const [explainNote, setExplainNote] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => {
    try { setData(weeklyReview(asDbAdapter(db))); setError(false); } catch { setError(true); }
  }, [db]);

  const start = () => {
    if (!data?.experiment) return;
    try {
      createHabitExperiment(db, data.experiment.habitId, data.experiment.title);
      setStarted(true);
      onChanged();
    } catch { setError(true); }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "92%" }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 34 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={text(24, C.text, "700")} accessibilityRole="header">Your week</Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={onClose} style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }} accessibilityRole="button" accessibilityLabel="Close weekly review">
                <Text style={text(13, C.muted)}>Close</Text>
              </TouchableOpacity>
            </View>
            {error && <Text style={[text(13, C.amber), { marginTop: 12 }]}>Could not read the week. Nothing was changed.</Text>}
            {!data && !error && <Text style={[text(13, C.muted), { marginTop: 18 }]}>Reading the last seven days…</Text>}

            {data && (
              <>
                <Text style={[text(12, C.muted), { marginTop: 4 }]}>
                  {displayEat(data.from)} to {displayEat(data.to)} · all numbers from your own payments.
                </Text>
                <TouchableOpacity disabled={explaining} onPress={() => {
                  if (explaining) return;
                  setExplaining(true);
                  const finding = {
                    detector: "weekly", id: `weekly:${data.to}`, n: data.habits.length + data.findings.length,
                    title: `This week: ${data.habits.length} habits tracked, ${data.findings.length} new patterns, credit-funded share ${Math.round(data.credit.thisShare * 100)}%.`,
                    evidence: {},
                  };
                  void narrateOffline(finding, { language: getProfile(asDbAdapter(db)).language })
                    .then((r) => { setExplain(r.text); setExplainNote(r.note ?? null); })
                    .catch(() => { setExplainNote("model_missing"); setExplain("Explaining on your phone needs a model download."); })
                    .finally(() => setExplaining(false));
                }} style={{ minHeight: 44, justifyContent: "center" }} accessibilityRole="button">
                  <Text style={text(12, C.blue, "600")}>{explaining ? "Explaining on your phone…" : "Explain this week ›"}</Text>
                </TouchableOpacity>
                {explain && <Text style={[text(12, C.muted), { marginTop: 2, lineHeight: 18 }]}>{explain}</Text>}
                {explainNote === "model_missing" && onSetupModels && (
                  <TouchableOpacity onPress={onSetupModels} style={{ minHeight: 44, justifyContent: "center" }} accessibilityRole="button">
                    <Text style={text(12, C.blue, "600")}>Download explanations ›</Text>
                  </TouchableOpacity>
                )}

                <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>HABITS</Text>
                {data.habits.length === 0 && <Text style={[text(12, C.dim), { marginTop: 6 }]}>No habits tracked yet.</Text>}
                {data.habits.map((h) => (
                  <Card key={h.id} style={{ marginTop: 8 }}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Text style={[text(14, C.text, "600"), { flex: 1 }]}>{h.name}</Text>
                      <Pill label={`${h.currentCount}${h.targetCount != null ? ` / ${h.targetCount}` : ""}`} tone={h.targetCount != null && h.currentCount <= h.targetCount ? "green" : "amber"} />
                    </View>
                    <Text style={[text(11, C.muted), { marginTop: 4 }]}>{h.heldOfLastM ?? "Building a baseline"}{h.followThrough != null ? ` · ${pct(h.followThrough)} of completed weeks held` : ""}</Text>
                  </Card>
                ))}

                <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>NEW PATTERNS</Text>
                {data.findings.length === 0 && <Text style={[text(12, C.dim), { marginTop: 6 }]}>No new gated patterns this week.</Text>}
                {data.findings.map((f) => (
                  <Card key={f.id} style={{ marginTop: 8 }}>
                    <Text style={[text(13, C.text, "600")]}>{f.title}</Text>
                    <Text style={[text(10, C.dim), { marginTop: 3 }]}>{f.detector.replace(/_/g, " ")} · seen {displayEat(f.lastSeen)}</Text>
                  </Card>
                ))}

                <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>SPEND EPISODES</Text>
                {data.episodes.length === 0 && <Text style={[text(12, C.dim), { marginTop: 6 }]}>No spend episodes this week.</Text>}
                {data.episodes.map((e) => (
                  <TouchableOpacity key={e.id} onPress={() => { if (e.txIds[0] != null) { onOpenTx?.(e.txIds[0]); onClose(); } }}
                    disabled={e.txIds.length === 0} accessibilityRole={e.txIds.length ? "button" : undefined}
                    accessibilityLabel={e.txIds.length ? `${e.title}. Open the first payment` : e.title}>
                    <Card style={{ marginTop: 8 }}>
                      <Text style={[text(13, C.text, "600")]}>{e.title}</Text>
                      <Text style={[text(11, C.muted), { marginTop: 4 }]}>
                        {kes(e.totalCents)} · {pct(e.creditShare)} on credit{e.txIds.length ? " · tap for the payments" : ""}
                      </Text>
                    </Card>
                  </TouchableOpacity>
                ))}

                <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>CREDIT-FUNDED SPENDING</Text>
                <Card style={{ marginTop: 8 }}>
                  <Text style={[text(20, C.text, "700")]}>{pct(data.credit.thisShare)}</Text>
                  <Text style={[text(12, C.muted), { marginTop: 2 }]}>
                    {kes(data.credit.thisCents)} of {kes(data.credit.thisOutflowCents)} spending was funded by Fuliza or another loan this week.
                  </Text>
                  <Text style={[text(11, data.credit.deltaPts > 0 ? C.amber : C.green), { marginTop: 6 }]}>
                    {data.credit.deltaPts === 0 ? "Same share as last week." : `${Math.abs(data.credit.deltaPts).toFixed(0)} points ${data.credit.deltaPts > 0 ? "higher" : "lower"} than last week (${pct(data.credit.previousShare)}).`}
                  </Text>
                </Card>

                <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>ONE THING TO TRY</Text>
                {!data.experiment && <Text style={[text(12, C.dim), { marginTop: 6 }]}>No habit to test yet. Create one in Plan → Goals &amp; habits.</Text>}
                {data.experiment && (
                  <Card style={{ marginTop: 8 }}>
                    <Text style={[text(13, C.text, "600")]}>{data.experiment.title} · {data.experiment.habitName}</Text>
                    <Text style={[text(11, C.muted), { marginTop: 4, lineHeight: 16 }]}>{data.experiment.why}</Text>
                    {started ? <Text style={[text(12, C.green, "600"), { marginTop: 8 }]}>Experiment started. Find it on the habit.</Text> : <Btn label="Start experiment" onPress={start} />}
                  </Card>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
