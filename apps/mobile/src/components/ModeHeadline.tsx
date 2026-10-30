import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { getPrimaryMode, modeMeasures, type GoalMode, type ModeMeasure } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { C, Card, kes, text } from "../ui";

const MODE_NAME: Record<GoalMode, string> = { steady: "Steady", grow: "Grow", business: "Business", clarity: "Clarity" };

function valueText(m: ModeMeasure): string {
  if (m.unit === "cents") return kes(m.value);
  if (m.unit === "days") return `${m.value.toFixed(1)} days`;
  if (m.unit === "share") return `${Math.round(m.value * 100)}%`;
  if (m.unit === "ratio") return `${Math.round(m.value * 100)}%`;
  return String(m.value);
}

export function ModeHeadline({ db, refreshKey }: { db: SQLiteDatabase; refreshKey: number }) {
  const [mode, setMode] = useState<GoalMode>("clarity");
  const [measures, setMeasures] = useState<ModeMeasure[]>([]);
  useEffect(() => {
    try {
      const a = asDbAdapter(db);
      const m = getPrimaryMode(a);
      setMode(m);
      setMeasures(modeMeasures(a, m));
    } catch { setMeasures([]); }
  }, [db, refreshKey]);
  if (!measures.length) return null;
  const first = measures[0]!;
  return (
    <Card style={{ marginTop: 14 }}>
      <View accessible accessibilityLabel={`${MODE_NAME[mode]} headline. ${first.sentence}`}>
      <Text style={text(10, C.muted, "700")}>YOUR PLAN · {MODE_NAME[mode].toUpperCase()}</Text>
      <Text style={[text(34, C.text, "700"), { marginTop: 4 }]} maxFontSizeMultiplier={1.4}>{valueText(first)}</Text>
      <Text style={[text(13, C.muted), { marginTop: 4, lineHeight: 19 }]}>{first.sentence}</Text>
      {measures.length > 1 && (
        <Text style={[text(11, C.dim), { marginTop: 8 }]}>
          {measures.slice(1, 3).map((m) => `${m.label}: ${valueText(m)}`).join(" · ")}
        </Text>
      )}
      </View>
    </Card>
  );
}
