import { useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { getLedger } from "../../db/ledger";
import { loadPlan, type PlanData } from "../../plan/data";
import { getPrimaryMode, setPrimaryMode, type GoalMode } from "@yako/core";
import { asDbAdapter } from "../../db/open";
import { C, Empty, Pill, Screen, text } from "../../ui";
import { BudgetsSection } from "./Budgets";
import { ExpectedSection } from "./Expected";
import { FloatCard, Strip } from "./Overview";
import { Button, Chip, Wrap } from "./parts";
import { SavingsSection } from "./Savings";
import { AdherenceSection } from "./Adherence";
import { HabitsSection } from "./Habits";

type Seg = "afford" | "coming" | "goals" | "doing";
const SEGS: Array<[Seg, string]> = [["afford", "Afford it"], ["coming", "What's coming"], ["goals", "Goals & habits"], ["doing", "How am I doing"]];
const MODES: Array<[GoalMode, string, string]> = [
  ["steady", "Steady", "Runway, credit-funded share and Fuliza cost"],
  ["grow", "Grow", "Savings rate, goals and pots"],
  ["business", "Business", "Venture margin and cash"],
  ["clarity", "Clarity", "Month in, out, net and changes"],
];

export function PlanScreen({ refreshKey, onSetupModels }: { refreshKey: number; onSetupModels?: () => void }) {
  const db = getLedger().db;
  const [seg, setSeg] = useState<Seg>("afford");
  const [mode, setMode] = useState<GoalMode>("clarity");
  const [data, setData] = useState<PlanData | null>(null);
  const [failed, setFailed] = useState(false);
  const [local, setLocal] = useState(0);
  const reload = () => setLocal((n) => n + 1);

  useEffect(() => {
    try { setData(loadPlan(db)); setMode(getPrimaryMode(asDbAdapter(db))); setFailed(false); } catch { setFailed(true); }
  }, [db, refreshKey, local]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 24, paddingBottom: 120 }}>
        <Text style={text(30, C.text, "700")} accessibilityRole="header" maxFontSizeMultiplier={1.5}>Plan</Text>
        <Text style={[text(13, C.muted), { marginTop: 2, lineHeight: 19 }]}>What is coming in, what is due, and what is safe to spend.</Text>

        <Wrap style={{ marginTop: 16 }}>
          {SEGS.map(([k, l]) => <Chip key={k} label={l} selected={seg === k} onPress={() => setSeg(k)} a11yLabel={`${l} section`} />)}
        </Wrap>

        {failed && (
          <View style={{ marginTop: 16 }}>
            <Empty title="Could not load your plan" body="Something went wrong reading your data. Nothing was changed." />
            <Wrap style={{ justifyContent: "center" }}><Button label="Try again" onPress={reload} /></Wrap>
          </View>
        )}
        {!data && !failed && <Text style={[text(13, C.muted), { marginTop: 24 }]}>Loading…</Text>}

        {data && seg === "afford" && (
          <>
            <FloatCard f={data.float} spendEnough={data.spendEnough} />
            <Strip days={data.strip} today={data.today} />
          </>
        )}
        {data && seg === "coming" && (
          <ExpectedSection db={db} views={data.flows} notices={data.noticeSuggestions} patterns={data.patternSuggestions} today={data.today} onChanged={reload} />
        )}
        {data && seg === "goals" && (
          <>
            <Text style={[text(11, C.muted, "700"), { marginTop: 16 }]}>PRIMARY MODE</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {MODES.map(([m, name]) => (
                <TouchableOpacity key={m} onPress={() => { setPrimaryMode(asDbAdapter(db), m); setMode(m); reload(); }}
                  accessibilityRole="radio" accessibilityState={{ selected: mode === m }} accessibilityLabel={`Primary mode: ${name}`}
                  style={{ backgroundColor: mode === m ? C.blue : C.card2, borderRadius: 14, paddingHorizontal: 10, minHeight: 48, justifyContent: "center" }}>
                  <Text style={text(11, mode === m ? "#fff" : C.muted, "600")}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[text(11, C.dim), { marginTop: 4 }]}>{MODES.find(([m]) => m === mode)?.[2]}</Text>
            <HabitsSection db={db} onChanged={reload} onSetupModels={onSetupModels} />
            <SavingsSection db={db} locations={data.locations} goals={data.goals} now={data.now} onChanged={reload} />
            <BudgetsSection db={db} items={data.budgets} labels={data.labels} onChanged={reload} />
          </>
        )}
        {data && seg === "doing" && <AdherenceSection db={db} refreshKey={refreshKey + local} />}

        <Text style={[text(11, C.dim), { marginTop: 28, lineHeight: 17, textAlign: "center" }]}>
          Informational, not financial advice. Numbers come from messages on this phone and what you tell the app, so they can be wrong or out of date.
        </Text>
      </ScrollView>
    </Screen>
  );
}
