import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { addDays, adherenceVerdict, dayOf, planAdherence, type AdherenceSummary } from "@yako/core";
import { asDbAdapter } from "../../db/open";
import { C, Card, Empty, SectionTitle, kes, text } from "../../ui";
import { Chip, Hint, Meter, Row, Wrap } from "./parts";

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

const VERDICT: Record<ReturnType<typeof adherenceVerdict>, { title: string; body: string; color: string }> = {
  no_plan: { title: "No outcomes yet", body: "Add expected income and bills. Once due dates pass, this page shows how closely what happened matched the plan.", color: C.muted },
  faithful: { title: "Mostly followed", body: "Most of the plan arrived on time. Keep the expectations realistic; a plan you beat is also information.", color: C.green },
  mixed: { title: "Half followed", body: "Some of the plan happened, some slipped. Look at the flows below before changing the plan itself.", color: C.amber },
  drifted: { title: "Drifted from the plan", body: "Most due items did not arrive as planned. The plan may be wrong, or this was an unusual period; both are worth knowing.", color: C.red },
};

export function AdherenceSection({ db, refreshKey }: { db: SQLiteDatabase; refreshKey: number }) {
  const [days, setDays] = useState<30 | 90>(30);
  const [data, setData] = useState<AdherenceSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    try {
      const now = Date.now();
      const today = dayOf(now);
      setData(planAdherence(asDbAdapter(db), { fromDay: addDays(today, -(days - 1)), toDay: today, now }));
      setError(false);
    } catch { setError(true); }
  }, [db, refreshKey, days]);

  if (error) return <Empty title="Could not read the plan history" body="Nothing was changed. Try again from the Plan tab." />;
  if (!data) return <Text style={[text(13, C.muted), { marginTop: 24 }]}>Reading the plan history…</Text>;

  const v = VERDICT[adherenceVerdict(data.weightedRate)];
  const nothing = data.planned === 0 && data.budgets.length === 0;

  return (
    <View>
      <Wrap style={{ marginTop: 16 }}>
        {([30, 90] as const).map((d) => (
          <Chip key={d} label={`Last ${d} days`} selected={days === d} onPress={() => setDays(d)} a11yLabel={`Last ${d} days of plan outcomes`} />
        ))}
      </Wrap>

      {nothing ? (
        <View style={{ marginTop: 16 }}>
          <Empty title="No plan outcomes yet" body={v.body} />
        </View>
      ) : (
        <>
          <Card style={{ marginTop: 16 }}>
            <Text style={text(11, C.muted, "700")}>PLAN VS WHAT HAPPENED</Text>
            <Text style={[text(10, C.dim), { marginTop: 2 }]}>Kept to plan, counting the grace period you set for each item.</Text>
            <Text style={[text(34, v.color, "700"), { marginTop: 4 }]} maxFontSizeMultiplier={1.5}>{pct(data.weightedRate)}</Text>
            <Text style={[text(14, C.text, "600"), { marginTop: 2 }]}>{v.title}</Text>
            <Hint>{v.body}</Hint>

            <Row style={{ marginTop: 14 }}
              left={<Text style={text(12, C.muted)}>Exactly on time</Text>}
              right={<Text style={text(13, C.text, "600")}>{data.onTime} of {data.planned}</Text>} />
            <Row
              left={<Text style={text(12, C.muted)}>Within the grace period</Text>}
              right={<Text style={text(13, C.text, "600")}>{data.withinGrace} of {data.planned}</Text>} />
            <Row
              left={<Text style={text(12, C.muted)}>Arrived (partial counts)</Text>}
              right={<Text style={text(13, C.text, "600")}>{data.arrived} of {data.planned}</Text>} />
            <Row
              left={<Text style={text(12, C.muted)}>Money planned vs arrived</Text>}
              right={<Text style={text(13, C.text, "600")}>{kes(data.receivedCents)} of {kes(data.expectedCents)}</Text>} />
            {data.late > 0 && <Row left={<Text style={text(12, C.amber)}>Still open, past due</Text>} right={<Text style={text(13, C.amber, "600")}>{data.late}</Text>} />}
            {data.waived > 0 && <Row left={<Text style={text(12, C.dim)}>Skipped on purpose</Text>} right={<Text style={text(13, C.dim)}>{data.waived}</Text>} />}
            <Text style={[text(10, C.dim), { marginTop: 10, lineHeight: 15 }]}>
              A matched arrival inside the grace days counts fully; a partial payment counts half. Only outcomes inside the window count; skipped and upcoming items are not failures.
            </Text>
          </Card>

          {data.flows.length > 0 && (
            <>
              <SectionTitle>By plan item</SectionTitle>
              {data.flows.map((f) => (
                <Card key={f.flowId} style={{ marginBottom: 8 }}>
                  <Row
                    left={<Text style={[text(14, C.text, "600"), { flexShrink: 1 }]}>{f.name}</Text>}
                    right={<Text style={text(13, f.adherence != null && f.adherence >= 0.8 ? C.green : f.adherence != null && f.adherence >= 0.5 ? C.amber : C.red, "700")}>{pct(f.adherence)}</Text>}
                  />
                  <Hint>
                    {f.withinGrace} of {f.planned} kept to plan{f.onTime !== f.withinGrace ? ` (${f.onTime} exactly on time)` : ""}{f.partial ? ` · ${f.partial} partial` : ""}{f.missed ? ` · ${f.missed} missed` : ""}{f.late ? ` · ${f.late} past due` : ""}
                    {f.medianDelayDays != null && f.medianDelayDays > 0 ? ` · typically ${f.medianDelayDays} day${f.medianDelayDays === 1 ? "" : "s"} late` : ""}
                  </Hint>
                  <Hint>{kes(f.receivedCents)} arrived of {kes(f.expectedCents)} planned.</Hint>
                  <Meter ratio={f.adherence ?? 0} color={f.adherence != null && f.adherence >= 0.8 ? C.green : f.adherence != null && f.adherence >= 0.5 ? C.amber : C.red} />
                </Card>
              ))}
            </>
          )}

          {data.budgets.length > 0 && (
            <>
              <SectionTitle>Budgets this period</SectionTitle>
              {data.budgets.map((b) => (
                <Card key={b.budgetId} style={{ marginBottom: 8 }}>
                  <Row
                    left={<Text style={[text(14, C.text, "600"), { flexShrink: 1 }]}>{b.name}</Text>}
                    right={<Text style={text(13, b.status === "over" ? C.red : b.status === "near" ? C.amber : C.green, "600")}>{b.status === "over" ? "Over" : b.status === "near" ? "Close to limit" : "On track"}</Text>}
                  />
                  <Hint>{kes(b.spentCents)} spent of {kes(b.limitCents)}{b.remainingCents >= 0 ? ` · ${kes(b.remainingCents)} left` : ` · ${kes(Math.abs(b.remainingCents))} over`}</Hint>
                  <Meter ratio={b.limitCents > 0 ? b.spentCents / b.limitCents : 0} color={b.status === "over" ? C.red : b.status === "near" ? C.amber : C.green} />
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </View>
  );
}
