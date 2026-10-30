import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { createHabitCategory, createLabel, displayEat, interpret, learnLexicon, parseNote, type Interpreted, type UserLexicon } from "@yako/core";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { confirmTx, loadLexicon, pendingTxs, type PendingTx } from "../review";
import { timeLabel } from "../queries";
import { Btn, C, Card, Empty, Pill, Screen, kes, text } from "../ui";

export function ReviewScreen({ refreshKey, onDone, limit = 1000, onboarding = false }: {
  refreshKey: number; onDone: () => void; limit?: number; onboarding?: boolean;
}) {
  const [queue, setQueue] = useState<PendingTx[]>([]);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState(0);
  const [detail, setDetail] = useState("");
  const [preview, setPreview] = useState<Interpreted | null>(null);
  const [lexicon, setLexicon] = useState<UserLexicon>({});
  const [newLabelOpen, setNewLabelOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [allLabels, setAllLabels] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [habitsAdded, setHabitsAdded] = useState<string[]>([]);

  useEffect(() => {
    try {
      setQueue(pendingTxs(getLedger().db, limit));
      setAllLabels(getLedger().db.getAllSync<{ name: string }>(`SELECT name FROM labels WHERE status = 'active' ORDER BY name`).map((r) => r.name));
      setI(0); setFiled(0);
    } catch { setQueue([]); setAllLabels([]); }
    setDetail("");
    setPreview(null);
    setSelectedLabel(null);
  }, [refreshKey, limit]);

  useEffect(() => {
    try { setLexicon(loadLexicon(getLedger().db)); } catch { setLexicon({}); }
  }, []);

  useEffect(() => { setDetail(""); setPreview(null); setSelectedLabel(null); setShowAll(false); setHabitsAdded([]); }, [i]);

  const tx = queue[i];

  if (!tx) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", padding: 20 }}>
          <Empty
            title={filed > 0 ? "All caught up" : queue.length === 0 ? "Nothing to review" : "All caught up"}
            body={filed > 0 ? `You named ${filed} payment${filed === 1 ? "" : "s"}. Pesanalysis is learning.` : "New payments will appear here as they arrive. Tap one notification to name it."}
          />
          <Btn label="Back to home" onPress={onDone} />
        </View>
      </Screen>
    );
  }

  const read = (s: string) => {
    setDetail(s);
    if (s.trim().length < 2) { setPreview(null); return; }
    setPreview(interpret(s, {
      direction: tx.direction,
      kind: tx.kind,
      template: tx.template,
      counterpartyName: tx.cpName,
    }, lexicon));
  };

  /** Selecting is not submitting. The user adds any detail they want, then taps Save. */
  const choose = (label: string) => {
    setSelectedLabel(label);
  };

  const submit = () => {
    if (!tx || busy || !selectedLabel) return;
    setBusy(true);
    try {
      const description = detail.trim();
      confirmTx(getLedger().db, tx.txId, selectedLabel, "user", description);
      if (description) setLexicon(learnLexicon(description, selectedLabel, lexicon));
      setFiled((n) => n + 1);
      setDetail("");
      setPreview(null);
      setSelectedLabel(null);
      setI((n) => n + 1);
    } catch { /* keep card */ }
    setBusy(false);
  };

  const usePreview = () => {
    if (!preview?.category) return;
    setSelectedLabel(preview.category);
    if (preview.detail && !detail.trim()) setDetail(preview.detail);
  };

  const saveNewLabel = () => {
    const name = newLabel.trim();
    if (!name) return;
    try {
      createLabel(asDbAdapter(getLedger().db), name, tx.direction === "out" ? "Expenses" : "Income");
      setSelectedLabel(name);
      setAllLabels((prev) => [...new Set([...prev, name])].sort());
      setNewLabel(""); setNewLabelOpen(false);
    } catch {
      setNewLabel("");
    }
  };

  const skip = () => {
    setDetail("");
    setPreview(null);
    setSelectedLabel(null);
    setI((n) => n + 1);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 28, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <Text style={text(28, C.text, "700")}>{onboarding ? "Quick start" : "Review"}</Text>
          <Text style={text(12, C.muted)}>{i + 1} of {queue.length}</Text>
        </View>
        <View style={{ height: 3, backgroundColor: C.line, borderRadius: 2, marginTop: 12, overflow: "hidden" }}>
          <View style={{ height: 3, width: `${((i + 1) / queue.length) * 100}%`, backgroundColor: C.blue }} />
        </View>
        <Text style={[text(10, C.dim), { marginTop: 7, lineHeight: 15 }]}>
          {onboarding
            ? "Recent and repeated counterparties first. Do a few now; the rest can be backfilled later."
            : "Pick a category, add context if you want, then save. Nothing submits until you tap Save."}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
          <Pill label={`priority ${tx.priority.toFixed(1)}`} tone="amber" />
          {tx.cpTxCount > 1 && <Pill label={`${tx.cpTxCount} payments to this account`} tone="blue" />}
          {tx.suggested && <Pill label={`likely ${tx.suggested}`} tone="dim" />}
        </View>

        <Card style={{ marginTop: 20 }}>
          <Text style={text(34, C.text, "700")}>{kes(tx.amount)}</Text>
          <Text style={[text(14, C.muted), { marginTop: 4 }]}>
            {tx.cpName ?? tx.kind.replace(/_/g, " ")}
          </Text>
          <Text style={[text(12, C.dim), { marginTop: 2 }]}>
            {timeLabel(tx.occurredAt)} · {displayEat(tx.occurredAt)} · {tx.kind.replace(/_/g, " ")}
          </Text>

          <Text style={[text(13, C.muted), { marginTop: 22 }]}>What was this for?</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {tx.choices.map((c) => {
              const suggested = c === tx.suggested;
              return (
                <TouchableOpacity
                  key={c}
                  onPress={() => choose(c)}
                  activeOpacity={0.75}
                  style={{
                    backgroundColor: selectedLabel === c ? C.blue : suggested ? "#20345C" : C.card2,
                    borderRadius: 24, paddingHorizontal: 14, minHeight: 48, justifyContent: "center",
                    borderWidth: selectedLabel === c ? 1 : 0, borderColor: C.blue,
                  }}
                >
                  <Text style={text(13, selectedLabel === c || suggested ? "#fff" : C.text, selectedLabel === c ? "700" : suggested ? "600" : "400")}>
                    {c}{suggested && tx.confidence != null ? ` · ${Math.round(tx.confidence * 100)}%` : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ flexDirection: "row", gap: 14, marginTop: 12 }}>
            <TouchableOpacity onPress={() => setShowAll((v) => !v)} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
              <Text style={text(12, C.blue, "600")}>{showAll ? "Hide all categories" : "Browse all categories"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setNewLabelOpen((v) => !v)} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
              <Text style={text(12, C.blue, "600")}>+ New category</Text>
            </TouchableOpacity>
          </View>
          {showAll && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {allLabels.map((l) => (
                <TouchableOpacity key={l} onPress={() => choose(l)} activeOpacity={0.7} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel={l}>
                  <Pill label={l} tone={selectedLabel === l ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {newLabelOpen && (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TextInput value={newLabel} onChangeText={setNewLabel} placeholder="Your own category name" placeholderTextColor={C.dim}
                style={[text(13, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 }]} />
              <Btn label="Save" kind="soft" onPress={saveNewLabel} style={{ paddingVertical: 8, paddingHorizontal: 13 }} />
            </View>
          )}

          <Text style={[text(13, C.muted), { marginTop: 20 }]}>More detail? (optional)</Text>
          <TextInput
            value={detail}
            onChangeText={read}
            placeholder="e.g. dog food · cigarettes 30 · chapo"
            placeholderTextColor={C.dim}
            returnKeyType="done"
            onSubmitEditing={usePreview}
            autoCapitalize="sentences"
            autoCorrect={false}
            style={[text(14, C.text), {
              backgroundColor: C.card2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11,
              marginTop: 8, borderWidth: 1, borderColor: preview?.category ? C.blue : C.line,
            }]}
          />

          {parseNote(detail).habitSuggestions.filter((h) => !habitsAdded.includes(h)).length > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {parseNote(detail).habitSuggestions.filter((h) => !habitsAdded.includes(h)).map((name) => (
                <TouchableOpacity key={name} onPress={() => {
                  try {
                    createHabitCategory(asDbAdapter(getLedger().db), name);
                    setHabitsAdded((prev) => [...prev, name]);
                  } catch { /* keep the note */ }
                }} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
                  <Pill label={`+ Track ${name} as a habit`} tone="dim" />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {preview && (
            <View style={{ marginTop: 10, backgroundColor: C.card2, borderRadius: 12, padding: 12 }}>
              <Text style={text(10, C.muted, "600")}>PESANALYSIS READS THIS AS</Text>
              <Text style={[text(15, C.text, "600"), { marginTop: 4 }]}>
                {preview.category}{preview.detail ? ` · ${preview.detail}` : ""}
              </Text>
              <Text style={[text(11, C.dim), { marginTop: 2 }]}>
                {Math.round(preview.confidence * 100)}% · on-device{preview.alternates.length ? ` · also ${preview.alternates.slice(0, 2).map((a) => a.category).join(", ")}` : ""}
              </Text>
              <Btn
                label={selectedLabel === preview.category ? "Category selected" : "Use this category"}
                onPress={usePreview}
                disabled={busy || selectedLabel === preview.category}
                style={{ marginTop: 10 }}
              />
            </View>
          )}

          {!preview && detail.trim().length >= 2 && (
            <Text style={[text(12, C.amber), { marginTop: 8, lineHeight: 17 }]}>
              I don't know that one yet. Pick a label above and I'll learn the words you used.
            </Text>
          )}

          <Btn
            label={busy ? "Saving…" : selectedLabel ? `Save “${selectedLabel}” & next` : "Choose a category first"}
            onPress={submit}
            disabled={busy || !selectedLabel}
            style={{ marginTop: 20 }}
          />
          <TouchableOpacity onPress={skip} style={{ marginTop: 14, alignSelf: "center", padding: 6, minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
            <Text style={text(13, C.muted)}>Skip for now</Text>
          </TouchableOpacity>
        </Card>

        <Text style={[text(11, C.dim), { textAlign: "center", marginTop: 18, lineHeight: 16 }]}>
          Your answer renames this transaction and teaches Pesanalysis. Nothing leaves the phone.
        </Text>
      </ScrollView>
    </Screen>
  );
}
