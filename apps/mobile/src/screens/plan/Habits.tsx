import { useEffect, useState } from "react";
import { Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  adjustNudgeMinute, antecedents, conditionalRates, createHabit, displayEat, displayEatTime, formatMinute, getProfile, habitProgress, listHabits, listLabelsFull,
  loadPersistedFindings, matchingTxs, nudgeResponseStats, parseHabitNudge, setHabitNudge, setHabitStatus, setHabitTarget, suggestHabits, suggestedNudgeMinute, suggestedNudgeWeekdays,
  type HabitRow, type HabitSuggestion,
} from "@yako/core";
import { asDbAdapter } from "../../db/open";
import { createHabitExperiment, listExperimentsForHabit, runHabitExperiment } from "../../experiments";
import { syncHabitNudges } from "../../runtime/nudges";
import { narrateOffline } from "../../narrate";
import { C, Card, Pill, kes, text } from "../../ui";
import { Button, Chip, Wrap } from "./parts";

const DAY = 86_400_000;
export function HabitsSection({ db, onChanged, onSetupModels }: { db: SQLiteDatabase; onChanged: () => void; onSetupModels?: () => void }) {
  const a = asDbAdapter(db);
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [suggestions, setSuggestions] = useState<HabitSuggestion[]>([]);
  const [labels, setLabels] = useState<Array<{ id: number; name: string }>>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [pick, setPick] = useState<number | null>(null);
  const [dir, setDir] = useState<"reduce" | "increase">("reduce");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    try {
      setHabits(listHabits(a, "all"));
      setLabels(listLabelsFull(a).map((l) => ({ id: l.id, name: l.name })));
      let findings: ReturnType<typeof loadPersistedFindings> = [];
      try { findings = loadPersistedFindings(a); } catch { findings = []; }
      setSuggestions(suggestHabits(a, findings));
    } catch { setHabits([]); setSuggestions([]); }
  }, [db, tick]);

  const addSuggestion = (s: HabitSuggestion) => {
    const id = createHabit(a, { name: s.name, selector: s.selector, direction: s.direction, target: s.target, baseline: { count: s.baselineCount, valueCents: s.baselineValueCents } });
    setOpen(id); reload(); onChanged();
  };
  const addManual = () => {
    if (!newName.trim() || pick == null) return;
    const id = createHabit(a, { name: newName, selector: { labels: [pick], direction: "out" }, direction: dir });
    const habit = listHabits(a).find((h) => h.id === id);
    if (habit) {
      const p = habitProgress(a, habit);
      setHabitTarget(a, id, { period: "week", count: Math.max(0, Math.round(p.baseline.meanCount * (dir === "reduce" ? 0.5 : 1.5))) });
    }
    setNewName(""); setPick(null); setOpen(id); reload(); onChanged();
  };

  return (
    <View>
      <Text style={[text(12, C.muted), { lineHeight: 18 }]}>
        Habits are things you want to watch, not a score. We show how often they happened and what came before, using your own payments.
      </Text>

      {suggestions.map((s) => (
        <Card key={s.key} style={{ marginTop: 10 }}>
          <Text style={text(14, C.text, "700")}>{s.name}</Text>
          <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 17 }]}>{s.why}</Text>
          <Text style={[text(11, C.dim), { marginTop: 4 }]}>About {s.baselineCount.toFixed(1)} per week · {kes(s.baselineValueCents)} in 8 weeks</Text>
          <Button label="Track this habit" onPress={() => addSuggestion(s)} />
        </Card>
      ))}

      {habits.length === 0 && suggestions.length === 0 && <Text style={[text(12, C.dim), { marginTop: 12 }]}>No habits yet. Create one below.</Text>}

      {habits.map((h) => {
        const p = habitProgress(a, h);
        const target = p.target?.count;
        return (
          <TouchableOpacity key={h.id} onPress={() => setOpen(h.id)} activeOpacity={0.8} style={{ marginTop: 10 }} accessibilityRole="button">
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={text(14, C.text, "700")}>{h.name}</Text>
                <View style={{ flex: 1 }} />
                <Pill label={h.status} tone={h.status === "active" ? "green" : "dim"} />
              </View>
              <Text style={[text(12, C.muted), { marginTop: 4 }]}>
                This week: {p.current?.count ?? 0}{target != null ? ` of ${target}` : ""} · {p.heldOfLastM ?? "building a baseline"}
              </Text>
              {h.status === "active" && <Text style={[text(11, C.blue, "600"), { marginTop: 6 }]}>Open habit ›</Text>}
            </Card>
          </TouchableOpacity>
        );
      })}

      <Card style={{ marginTop: 16 }}>
        <Text style={text(12, C.text, "700")}>New habit</Text>
        <TextInput value={newName} onChangeText={setNewName} placeholder="e.g. Late-night food" placeholderTextColor={C.dim}
          style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 8 }]} />
        <Text style={[text(10, C.muted, "700"), { marginTop: 10 }]}>WHAT TO WATCH</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {labels.slice(0, 24).map((l) => <Chip key={l.id} label={l.name} selected={pick === l.id} onPress={() => setPick(l.id)} />)}
          </View>
        </ScrollView>
        <Wrap style={{ marginTop: 8 }}>
          <Chip label="Reduce" selected={dir === "reduce"} onPress={() => setDir("reduce")} />
          <Chip label="Increase" selected={dir === "increase"} onPress={() => setDir("increase")} />
        </Wrap>
        <Button label="Create habit" onPress={addManual} />
      </Card>

      {open != null && <HabitDetail db={db} id={open} onClose={() => setOpen(null)} onChanged={() => { reload(); onChanged(); }} onSetupModels={onSetupModels} />}
    </View>
  );
}

function HabitDetail({ db, id, onClose, onChanged, onSetupModels }: { db: SQLiteDatabase; id: number; onClose: () => void; onChanged: () => void; onSetupModels?: () => void }) {
  const a = asDbAdapter(db);
  const [habit, setHabit] = useState<HabitRow | null>(null);
  const [tick, setTick] = useState(0);
  const [explain, setExplain] = useState<string | null>(null);
  const [explainNote, setExplainNote] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [expExplain, setExpExplain] = useState<Record<number, string>>({});
  const [expBusy, setExpBusy] = useState<number | null>(null);
  const [nudgeOn, setNudgeOn] = useState(false);
  const [nudgeMinute, setNudgeMinute] = useState(20 * 60);
  const [nudgeDays, setNudgeDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [nudgeTime, setNudgeTime] = useState("20:00");
  const [nudgeError, setNudgeError] = useState<string | null>(null);
  const reload = () => setTick((n) => n + 1);
  useEffect(() => { setHabit(listHabits(a, "all").find((h) => h.id === id) ?? null); }, [db, id, tick]);
  useEffect(() => {
    if (!habit) return;
    const n = parseHabitNudge(habit.nudge);
    const minute = n?.minuteOfDay ?? suggestedNudgeMinute(habit);
    setNudgeOn(!!n?.enabled);
    setNudgeMinute(minute);
    setNudgeTime(formatMinute(minute));
    setNudgeDays(n?.weekdays ?? suggestedNudgeWeekdays(a, habit));
  }, [habit?.id, habit?.updatedAt]);
  if (!habit) return null;
  const p = habitProgress(a, habit);
  const from = Date.now() - 90 * DAY, to = Date.now();
  const cause = antecedents(a, from, to, { selector: habit.selector });
  const cond = habit.selector.labels?.length
    ? conditionalRates(a, from, to, { selector: habit.selector }, { label: "Groceries" }, 24)
    : null;
  const txs = matchingTxs(a, habit.selector, from, to).slice(-8).reverse();
  const exps = listExperimentsForHabit(db, habit.id);
  const nudgeStats = nudgeResponseStats(a, habit.id, Date.now() - 56 * DAY);
  const experiments = exps.map((e) => {
    let result: { cumulativeEffect?: number; lo95?: number; hi95?: number; postMean?: number; preMean?: number } | null = null;
    try { result = e.resultJson ? JSON.parse(e.resultJson) : null; } catch { result = null; }
    return { ...e, result };
  });

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "92%" }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 34 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={text(22, C.text, "700")} numberOfLines={1}>{habit.name}</Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={onClose} style={{ minHeight: 48, justifyContent: "center" }}><Text style={text(13, C.muted)}>Close</Text></TouchableOpacity>
            </View>
            <Text style={[text(12, C.muted), { marginTop: 4 }]}>
              Baseline {p.baseline.meanCount.toFixed(1)}/week ({p.baseline.countLo}–{p.baseline.countHi}) · target {p.target?.count ?? "not set"}
            </Text>
            <Text style={[text(13, C.text), { marginTop: 6 }]}>{p.heldOfLastM ?? "Not enough weeks yet."}</Text>
            <TouchableOpacity onPress={() => {
              if (!habit || explaining) return;
              setExplaining(true);
              const finding = {
                detector: "habit", id: `habit:${habit.id}`, n: p.baseline.counts.reduce((x, y) => x + y, 0),
                title: `${habit.name}: ${p.current?.count ?? 0} this week against a target of ${p.target?.count ?? "no target"}; baseline ${p.baseline.meanCount.toFixed(1)} per week.`,
                evidence: { habit: habit.name, baseline: p.baseline.meanCount, current: p.current?.count ?? 0 },
              };
              void narrateOffline(finding, { language: getProfile(a).language }).then((r) => { setExplain(r.text); setExplainNote(r.note ?? null); setExplaining(false); }).catch(() => { setExplainNote("model_missing"); setExplain("Explaining on your phone needs a model download."); setExplaining(false); });
            }} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
              <Text style={text(12, C.blue, "600")}>{explaining ? "Explaining on your phone…" : "Explain this habit"}</Text>
            </TouchableOpacity>
            {explain && <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 18 }]}>{explain}</Text>}
            {explainNote === "model_missing" && onSetupModels && (
              <TouchableOpacity onPress={onSetupModels} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
                <Text style={text(12, C.blue, "600")}>Download explanations ›</Text>
              </TouchableOpacity>
            )}

            <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>MOMENT NUDGE</Text>
            <Card style={{ marginTop: 8 }}>
              <TouchableOpacity onPress={() => {
                const next = !nudgeOn;
                setNudgeOn(next); setNudgeError(null);
                try { setHabitNudge(a, habit.id, next ? { enabled: true, minuteOfDay: adjustNudgeMinute(nudgeMinute), weekdays: nudgeDays.length ? nudgeDays : [1, 2, 3, 4, 5] } : null); void syncHabitNudges(db); reload(); onChanged(); }
                catch { setNudgeError("Could not save the nudge."); }
              }} accessibilityRole="switch" accessibilityState={{ checked: nudgeOn }} accessibilityLabel="Habit moment nudge"
                style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
                <View style={{ flex: 1 }}>
                  <Text style={text(13, C.text, "600")}>Remind me at a set time</Text>
                  <Text style={text(10, C.dim)}>Optional · one quiet notification on the days you choose</Text>
                </View>
                <Pill label={nudgeOn ? "on" : "off"} tone={nudgeOn ? "green" : "dim"} />
              </TouchableOpacity>
              {nudgeOn && (
                <View style={{ marginTop: 8 }}>
                  <Text style={[text(10, C.muted, "700")]}>DAYS</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                    {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                      <Chip key={i} label={d} selected={nudgeDays.includes(i)}
                        onPress={() => setNudgeDays((old) => old.includes(i) ? old.filter((x) => x !== i) : [...old, i].sort((x, y) => x - y))} />
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <Text style={text(11, C.muted)}>Time</Text>
                    <TextInput value={nudgeTime} onChangeText={setNudgeTime} placeholder="20:00" keyboardType="numbers-and-punctuation"
                      style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, width: 92 }]} />
                    <Button label="Save" kind="soft" onPress={() => {
                      const m = /^(\d{1,2}):(\d{2})$/.exec(nudgeTime.trim());
                      const minute = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
                      if (!Number.isInteger(minute) || minute < 0 || minute > 1439) { setNudgeError("Use a time like 21:30."); return; }
                      if (!nudgeDays.length) { setNudgeError("Pick at least one day."); return; }
                      const adjusted = adjustNudgeMinute(minute);
                      try { setHabitNudge(a, habit.id, { enabled: true, minuteOfDay: adjusted, weekdays: nudgeDays }); setNudgeMinute(adjusted); setNudgeTime(formatMinute(adjusted)); setNudgeError(null); void syncHabitNudges(db); reload(); onChanged(); }
                      catch { setNudgeError("Could not save the nudge."); }
                    }} />
                  </View>
                  <Text style={[text(10, C.dim), { marginTop: 5 }]}>Quiet hours move it to the first allowed minute. Responses are logged only on this phone.</Text>
                </View>
              )}
              {nudgeError && <Text style={[text(11, C.amber), { marginTop: 6 }]}>{nudgeError}</Text>}
              {nudgeStats.delivered > 0 && <Text style={[text(10, C.dim), { marginTop: 5 }]}>{nudgeStats.delivered} nudges logged · {nudgeStats.acted} handled · {nudgeStats.snoozed} snoozed.</Text>}
            </Card>

            <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>WHAT CAME BEFORE</Text>
            {cause.message && <Text style={[text(12, C.dim), { marginTop: 6 }]}>{cause.message}</Text>}
            {cause.factors.map((f) => (
              <Card key={f.key} style={{ marginTop: 8 }}>
                <Text style={text(13, C.text, "600")}>{f.label}</Text>
                <Text style={[text(12, C.muted), { marginTop: 3 }]}>
                  {f.unit === "cents" ? `${kes(f.eventValue)} vs ${kes(f.comparisonValue)}` : f.unit === "rate" ? `${Math.round(f.eventValue * 100)}% vs ${Math.round(f.comparisonValue * 100)}%` : `${f.eventValue.toFixed(1)} vs ${f.comparisonValue.toFixed(1)} ${f.unit}`}
                  {" · "}events {f.nEvent}, comparison {f.nComparison}
                </Text>
              </Card>
            ))}
            {cond && <Text style={[text(12, C.muted), { marginTop: 8, lineHeight: 18 }]}>{cond.message}</Text>}

            {habit.selector.labels?.length ? (
              <>
                <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>TRY A CHANGE</Text>
                {["Shop for food on Mondays", "No Fuliza for small buys", "Cook instead of takeaway"].map((t) => (
                  <TouchableOpacity key={t} onPress={() => { createHabitExperiment(db, habit.id, t); reload(); }} style={{ minHeight: 48, justifyContent: "center" }}>
                    <Text style={text(12, C.blue, "600")}>+ {t}</Text>
                  </TouchableOpacity>
                ))}
              </>
            ) : null}

            {experiments.map((e) => {
              const days = Math.floor((Date.now() - e.startedAt) / DAY);
              const r = e.result;
              return (
                <Card key={e.id} style={{ marginTop: 8 }}>
                  <Text style={text(13, C.text, "600")}>{e.name}</Text>
                  <Text style={[text(11, C.dim), { marginTop: 2 }]}>{e.status} · since {displayEat(e.startedAt)} ({days} days)</Text>
                  {r ? (
                    <Text style={[text(12, C.muted), { marginTop: 6, lineHeight: 18 }]}>
                      {r.lo95 != null && r.hi95 != null && (r.lo95 > 0 || r.hi95 < 0)
                        ? `Likely ${r.cumulativeEffect! < 0 ? "fewer" : "more"} habit payments (interval ${Math.round(r.lo95)} to ${Math.round(r.hi95)}).`
                        : "The result is still within noise; keep going or try a longer window."}
                    </Text>
                  ) : days >= 14 ? (
                    <TouchableOpacity onPress={() => { runHabitExperiment(db, e.id); reload(); }} style={{ minHeight: 48, justifyContent: "center" }}>
                      <Text style={text(12, C.blue, "600")}>See result</Text>
                    </TouchableOpacity>
                  ) : <Text style={[text(11, C.dim), { marginTop: 4 }]}>Too early to tell ({14 - days} days left).</Text>}
                  {r && (
                    <TouchableOpacity disabled={expBusy === e.id} onPress={() => {
                      if (expBusy === e.id) return;
                      setExpBusy(e.id);
                      const effect = Number(r.cumulativeEffect ?? 0);
                      const lo = Number(r.lo95 ?? 0), hi = Number(r.hi95 ?? 0);
                      const finding = {
                        detector: "experiment", id: `experiment:${e.id}`, n: 28,
                        title: `${e.name}: ${effect < 0 ? "fewer" : "more"} habit payments, interval ${Math.round(lo)} to ${Math.round(hi)}.`,
                        evidence: { experimentId: e.id },
                      };
                      void narrateOffline(finding, { language: getProfile(a).language })
                        .then((x) => setExpExplain((old) => ({ ...old, [e.id]: x.note === "model_missing" ? `${x.text}\nDownload explanations in More → Model setup.` : x.text })))
                        .catch(() => setExpExplain((old) => ({ ...old, [e.id]: "Explaining on your phone needs a model download." })))
                        .finally(() => setExpBusy(null));
                    }} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
                      <Text style={text(12, C.blue, "600")}>{expBusy === e.id ? "Explaining on your phone…" : "Explain this result ›"}</Text>
                    </TouchableOpacity>
                  )}
                  {expExplain[e.id] && <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 18 }]}>{expExplain[e.id]}</Text>}
                </Card>
              );
            })}

            <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>RECENT MATCHES</Text>
            {txs.length === 0 && <Text style={[text(12, C.dim), { marginTop: 4 }]}>No matches in 90 days.</Text>}
            {txs.map((t) => (
              <Text key={t.id} style={[text(11, C.muted), { marginTop: 4 }]}>{displayEatTime(t.at)} · {t.label ?? "unlabelled"} · {kes(t.amountCents)}</Text>
            ))}

            <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
              <Button label={habit.status === "active" ? "Pause" : "Resume"} onPress={() => { setHabitStatus(a, habit.id, habit.status === "active" ? "paused" : "active"); void syncHabitNudges(db); reload(); onChanged(); }} />
              <Button label="Archive" onPress={() => { setHabitStatus(a, habit.id, "archived"); void syncHabitNudges(db); onChanged(); onClose(); }} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
