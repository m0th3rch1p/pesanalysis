import { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  addFinePattern, alertMessageView, balanceBreakEvidence, breakExplanation, getSecurityAlert,
  listSecurityAlerts, markAlertUseful, maskPhones, neighbouringMessages, setSecurityAlertVerdict,
  type BalanceBreakEvidence, type NeighbourMessage, type SecurityAlertRow,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Pill, kes, text } from "../ui";
import { timeLabel } from "../queries";

const SEV_TONE = (s: string) => s === "critical" ? "red" : s === "warning" ? "amber" : "dim";

function RuleText(a: SecurityAlertRow): string {
  switch (a.kind) {
    case "balance_break": return "The stated balance after a message did not match the previous balance plus the effects since. This rule looks for missing, late or duplicated messages, not for a person.";
    case "msisdn_spoof": return "A personal phone number sent something that looks like a wallet/bank receipt. Real providers use official sender IDs; this message was kept out of the ledger.";
    case "reversal_trap": return "Someone asked you to send money back after an inflow. A real reversal is done by the provider; sending your own money is how the scam completes.";
    case "phishing": return "A message asked for a PIN, code or fee and linked to a domain that is not the provider's. Credentials entered there can be stolen.";
    case "unsettled_mirror": return "A bank notice did not match any wallet movement. It may be a transfer that has not settled, or a message that belongs to another account.";
  }
  return "This alert was raised by a local safety rule.";
}

export function AlertSheet({ db, alertId, onClose, onChanged, onOpenTx }: {
  db: SQLiteDatabase; alertId: number; onClose: () => void; onChanged: () => void; onOpenTx?: (id: number) => void;
}) {
  const [alert, setAlert] = useState<SecurityAlertRow | null>(null);
  const [evidence, setEvidence] = useState<BalanceBreakEvidence | null>(null);
  const [neighbours, setNeighbours] = useState<NeighbourMessage[]>([]);
  const [showAll, setShowAll] = useState(false);
  const a = asDbAdapter(db);

  useEffect(() => {
    const row = getSecurityAlert(a, alertId);
    setAlert(row);
    setEvidence(row?.kind === "balance_break" ? balanceBreakEvidence(a, alertId) : null);
    setNeighbours(row?.txId ? neighbouringMessages(a, row.txId) : []);
  }, [alertId]);

  if (!alert) return null;
  const msg = alertMessageView(a, alert);

  const fine = () => {
    addFinePattern(a, alert.kind, alert.sender);
    setSecurityAlertVerdict(a, alert.id, "fine", true);
    markAlertUseful(a, alert.id, true);
    onChanged(); onClose();
  };
  const report = () => {
    Alert.alert(
      "Stop. Do not send money.",
      "Call Safaricom on 100 or 200 (or your provider's official number) using the number on your SIM or the official app. Do not use a number or link from the message. A real reversal or refund is handled by the provider, never by sending your own money.",
      [
        { text: "Back", style: "cancel" },
        { text: "I understand", onPress: () => { setSecurityAlertVerdict(a, alert.id, "report", true); onChanged(); onClose(); } },
      ],
    );
  };
  const unsure = () => {
    setSecurityAlertVerdict(a, alert.id, "unsure", false);
    onChanged(); onClose();
  };

  const shown = showAll ? neighbours : neighbours.slice(0, 4);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "92%" }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 34 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Pill label={alert.severity} tone={SEV_TONE(alert.severity)} />
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={onClose} style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }} accessibilityRole="button" accessibilityLabel="Close evidence">
                <Text style={text(13, C.muted)}>Close</Text>
              </TouchableOpacity>
            </View>
            <Text style={[text(24, C.text, "700"), { marginTop: 10 }]}>{alert.title}</Text>
            <Text style={[text(12, C.dim), { marginTop: 4 }]}>{timeLabel(alert.occurredAt)} · sender {maskPhones(msg.sender)}</Text>

            {msg.body && (
              <View style={{ backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 14 }}>
                <Text style={[text(10, C.muted, "700")]}>THE MESSAGE</Text>
                <Text style={[text(13, C.text), { marginTop: 7, lineHeight: 20 }]}>{msg.body}</Text>
              </View>
            )}

            <View style={{ backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10 }}>
              <Text style={[text(10, C.muted, "700")]}>WHAT WE PARSED</Text>
              <Row k="Amount" v={msg.amountCents != null ? kes(msg.amountCents) : "—"} />
              <Row k="Fee" v={msg.feeCents != null ? kes(msg.feeCents) : "—"} />
              <Row k="Type" v={[msg.provider, msg.kind, msg.direction].filter(Boolean).join(" · ") || "—"} />
              <Row k="Counterparty" v={msg.counterparty ? maskPhones(msg.counterparty) : "—"} />
              <Row k="Receipt" v={msg.ref ?? "—"} />
            </View>

            <View style={{ backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10 }}>
              <Text style={[text(10, C.muted, "700")]}>WHY THIS FIRED</Text>
              <Text style={[text(12, C.text), { marginTop: 6, lineHeight: 18 }]}>{RuleText(alert)}</Text>
              {alert.suppressedReason && <Text style={[text(11, C.amber), { marginTop: 8 }]}>Suppressed as: {breakExplanation(alert.suppressedReason as never)}</Text>}
            </View>

            {evidence && (
              <View style={{ backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10 }}>
                <Text style={[text(10, C.muted, "700")]}>THE BALANCE CHECK</Text>
                <Row k="Previous stated balance" v={evidence.previousBalanceCents != null ? kes(evidence.previousBalanceCents) : "—"} />
                <Row k="This message says" v={evidence.statedBalanceCents != null ? kes(evidence.statedBalanceCents) : "—"} />
                <Row k="Expected after effects" v={evidence.expectedBalanceCents != null ? kes(evidence.expectedBalanceCents) : "—"} />
                <Row k="Difference" v={kes(Math.abs(evidence.discrepancyCents))} strong={evidence.discrepancyCents !== 0} />
                {evidence.steps.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={[text(10, C.dim), { marginBottom: 4 }]}>Effects considered (latest {evidence.steps.length})</Text>
                    {evidence.steps.map((s) => (
                      <Text key={s.id} style={text(11, C.muted)}>{timeLabel(s.at)} · {s.kind} {s.direction === "in" ? "+" : "−"}{kes(s.amountCents)}{s.feeCents ? ` + fee ${kes(s.feeCents)}` : ""}</Text>
                    ))}
                  </View>
                )}
              </View>
            )}

            {alert.txId != null && onOpenTx && (
              <TouchableOpacity onPress={() => { onOpenTx(alert.txId!); onClose(); }} style={{ minHeight: 48, justifyContent: "center", marginTop: 6 }} accessibilityRole="button">
                <Text style={text(13, C.blue, "600")}>Open the related payment ›</Text>
              </TouchableOpacity>
            )}

            {neighbours.length > 0 && (
              <View style={{ backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10 }}>
                <Text style={[text(10, C.muted, "700")]}>MESSAGES AROUND IT</Text>
                {shown.map((n) => (
                  <View key={n.id} style={{ marginTop: 8 }}>
                    <Text style={text(10, C.dim)}>{timeLabel(n.at)} · {maskPhones(n.sender)}</Text>
                    <Text style={[text(11, C.muted), { marginTop: 2, lineHeight: 16 }]} numberOfLines={3}>{n.body}</Text>
                  </View>
                ))}
                {neighbours.length > 4 && (
                  <TouchableOpacity onPress={() => setShowAll((v) => !v)} style={{ minHeight: 48, justifyContent: "center" }}>
                    <Text style={text(12, C.blue, "600")}>{showAll ? "Show fewer" : `Show all ${neighbours.length}`}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            <View style={{ gap: 8, marginTop: 16 }}>
              <Btn label="This is fine" onPress={fine} />
              <Btn label="I was scammed / report" kind="soft" onPress={report} />
              <Btn label="Not sure" kind="soft" onPress={unsure} />
            </View>
            <Text style={[text(10, C.dim), { marginTop: 12, lineHeight: 15 }]}>
              "This is fine" teaches this sender pattern to stay in the audit view. Nothing is deleted; you can still find it in More → Ledger audit.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 5 }}>
      <Text style={text(11, C.muted)}>{k}</Text>
      <Text style={text(11, strong ? C.amber : C.text, strong ? "700" : "400")}>{v}</Text>
    </View>
  );
}
