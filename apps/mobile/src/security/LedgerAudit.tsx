import { useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { breakExplanation, listAuditAlerts, securityAlertAuditGroups, type SecurityAlertRow } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { AlertSheet } from "./AlertSheet";
import { C, Pill, text } from "../ui";
import { timeLabel } from "../queries";

export function LedgerAudit({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const [groups, setGroups] = useState<Array<{ reason: string; count: number }>>([]);
  const [rows, setRows] = useState<SecurityAlertRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const load = () => {
    const a = asDbAdapter(db);
    try { setGroups(securityAlertAuditGroups(a)); setRows(listAuditAlerts(a, 50)); } catch { setGroups([]); setRows([]); }
  };
  useEffect(load, [db]);
  return (
    <View>
      <Text style={[text(11, C.muted), { lineHeight: 17 }]}>
        Items kept out of the main safety card because a bookkeeping cause explains them, or because you said “This is fine”. Nothing is deleted.
      </Text>
      {groups.length === 0 && <Text style={[text(12, C.dim), { marginTop: 10 }]}>No audit items.</Text>}
      {groups.map((g) => (
        <View key={g.reason} style={{ marginTop: 10, backgroundColor: C.card2, borderRadius: 10, padding: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={text(12, C.text, "600")}>{g.reason.replace(/_/g, " ")}</Text>
            <Pill label={String(g.count)} tone="dim" />
          </View>
          <Text style={[text(10, C.dim), { marginTop: 3, lineHeight: 15 }]}>{breakExplanation(g.reason)}</Text>
        </View>
      ))}
      {rows.map((a) => (
        <TouchableOpacity key={a.id} onPress={() => setOpen(a.id)} style={{ minHeight: 48, justifyContent: "center", borderTopWidth: 1, borderTopColor: C.line }} accessibilityRole="button">
          <Text style={text(12, C.text)} numberOfLines={1}>{a.title}</Text>
          <Text style={text(10, C.dim)}>{timeLabel(a.occurredAt)} · {a.suppressedReason ?? a.kind}</Text>
        </TouchableOpacity>
      ))}
      {open != null && <AlertSheet db={db} alertId={open} onClose={() => setOpen(null)} onChanged={() => { load(); onChanged(); }} />}
    </View>
  );
}
