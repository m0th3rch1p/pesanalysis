import { Text, View } from "react-native";
import { type FloatResult, type StripDay, dayLabel, daysPhrase } from "@yako/core";
import { C, Card, SectionTitle, kes, text } from "../../ui";
import { Hint, Row, Wrap, whenLabel } from "./parts";

function dtz(n: number | null, kind: "expected" | "pessimistic"): string {
  if (n == null) return kind === "expected" ? "Not within 60 days" : "Not within 60 days";
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`;
}

export function FloatCard({ f, spendEnough }: { f: FloatResult; spendEnough: boolean }) {
  const s = f.safeToSpend;
  const conf = s?.confidence === "high" ? "High confidence" : s?.confidence === "medium" ? "Medium confidence" : "Low confidence";
  const ageHours = f.balanceAsOf != null ? (Date.now() - f.balanceAsOf) / 3_600_000 : null;
  const safeLine = s ? (s.midCents <= 0
    ? "Nothing is safe to spend today without dipping into bills or Fuliza."
    : `About ${kes(s.midCents)} is safe to spend today.`) : null;
  const summary = f.balanceCents == null
    ? "No balance yet. Plan numbers appear after the first M-Pesa message with a balance."
    : `Free float ${kes(f.freeFloatCents ?? 0)}. ${safeLine ?? ""}`;
  return (
    <Card style={{ marginTop: 14 }}>
      <View accessible accessibilityLabel={summary}>
        <Text style={text(11, C.muted, "700")}>FREE FLOAT</Text>
        {f.balanceCents == null ? (
          <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 20 }]}>
            No balance yet. Plan numbers appear after the first M-Pesa message that shows your balance.
          </Text>
        ) : (
          <>
            <Text style={[text(30, (f.freeFloatCents ?? 0) < 0 ? C.red : C.text, "700"), { marginTop: 4 }]} maxFontSizeMultiplier={1.5}>{kes(f.freeFloatCents ?? 0)}</Text>
            <Hint>Wallet {kes(f.balanceCents)} minus pots {kes(f.potsCents)}, bills due in {f.horizonDays} days {kes(f.obligationsDueCents)} and budget reserve {kes(f.budgetReserveCents)}.</Hint>
          </>
        )}
      </View>

      {s && (
        <View style={{ marginTop: 16 }} accessible accessibilityLabel={`${safeLine} ${conf}.`}>
          <Text style={text(12, C.muted, "600")}>Safe to spend today</Text>
          <Text style={[text(20, s.midCents <= 0 ? C.amber : C.green, "700"), { marginTop: 2, lineHeight: 27 }]} maxFontSizeMultiplier={1.5}>{safeLine}</Text>
          {!spendEnough && <Hint>Your spending history is short, so this is a rough estimate.</Hint>}
        </View>
      )}

      {f.balanceCents != null && (
        <Wrap gap={16} style={{ marginTop: 16 }}>
          <View style={{ flexGrow: 1, flexBasis: 130 }} accessible accessibilityLabel={`Money runs out: expected ${dtz(f.daysToZero.expected, "expected")}. Worst case ${dtz(f.daysToZero.pessimistic, "pessimistic")}.`}>
            <Text style={text(12, C.muted)}>Money runs out</Text>
            <Text style={[text(15, f.daysToZero.expected != null ? C.amber : C.text, "700"), { marginTop: 2 }]}>{dtz(f.daysToZero.expected, "expected")}</Text>
            <Text style={text(11, C.dim)}>Worst case: {dtz(f.daysToZero.pessimistic, "pessimistic")}</Text>
          </View>
          <View style={{ flexGrow: 1, flexBasis: 130 }}>
            <Text style={text(12, C.muted)}>Balance as of</Text>
            <Text style={[text(15, f.quality === "ok" ? C.text : C.amber, "700"), { marginTop: 2 }]}>
              {ageHours != null && ageHours > 6 ? `Balance from ${Math.round(ageHours)} h ago` : whenLabel(f.balanceAsOf)}
            </Text>
            {f.quality === "estimate" && <Text style={text(11, C.amber)}>Old balance, treat as an estimate</Text>}
          </View>
        </Wrap>
      )}

      {f.overdueCents > 0 && (
        <Text style={[text(12, C.red, "600"), { marginTop: 12 }]}>{kes(f.overdueCents)} is already overdue and counted above.</Text>
      )}

      {f.sweep && (
        <View style={{ marginTop: 14, backgroundColor: "#3A2E12", borderRadius: 12, padding: 12 }} accessible accessibilityRole="alert"
          accessibilityLabel={`Fuliza warning. ${kes(f.sweep.outstandingCents)} owed. ${f.sweep.message}`}>
          <Text style={text(13, C.amber, "700")}>Fuliza is owed: {kes(f.sweep.outstandingCents)}</Text>
          <Text style={[text(12, C.text), { marginTop: 4, lineHeight: 18 }]}>
            The next money you receive repays Fuliza first, so saved or expected money will not stay in your wallet.
            {f.sweep.expectedInflowAbsorbedCents > 0 ? ` About ${kes(f.sweep.expectedInflowAbsorbedCents)} of money you expect would go to it.` : ""}
          </Text>
        </View>
      )}
    </Card>
  );
}

export function Strip({ days, today }: { days: StripDay[]; today: string }) {
  const busy = days.filter((d) => d.items.length > 0);
  return (
    <>
      <SectionTitle>Next 30 days</SectionTitle>
      <Card>
        <View accessible accessibilityLabel={`Next 30 days. ${busy.length} days with money moving.`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {days.map((d) => {
            const net = d.inCents > 0 && d.outCents > 0 ? C.amber : d.inCents > 0 ? C.green : d.outCents > 0 ? C.red : C.line;
            return (
              <View key={d.day} importantForAccessibility="no" style={{ width: 20, height: 20, borderRadius: 5, backgroundColor: net, opacity: d.items.length ? 1 : 0.6, borderWidth: d.day === today ? 2 : 0, borderColor: C.text }} />
            );
          })}
        </View>
        <Wrap gap={14} style={{ marginTop: 10 }}>
          <Text style={text(11, C.green)}>Money in</Text><Text style={text(11, C.red)}>Money out</Text><Text style={text(11, C.amber)}>Both</Text>
        </Wrap>
        {busy.length === 0 ? (
          <Text style={[text(13, C.muted), { marginTop: 12, lineHeight: 19 }]}>Nothing due in the next 30 days. Add expected income or bills in the What’s coming tab.</Text>
        ) : busy.map((d) => (
          <View key={d.day} style={{ marginTop: 12 }}>
            <Text style={text(12, C.muted, "700")}>{dayLabel(d.day)} · {daysPhrase(d.offset)}</Text>
            {d.items.map((it, i) => (
              <Row key={i} style={{ marginTop: 4 }}
                left={<Text style={text(14, C.text)}>{it.name}{it.state === "late" ? " (late)" : ""}</Text>}
                right={<Text style={text(14, it.direction === "in" ? C.green : C.red, "600")}>{it.direction === "in" ? "+" : "-"}{kes(it.cents)}</Text>} />
            ))}
          </View>
        ))}
      </Card>
    </>
  );
}
