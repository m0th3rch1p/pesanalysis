import { useEffect, useState } from "react";
import { Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  acceptDebtLink, createDebt, debtSummary, dismissDebtLink, extractDebtTerms, listDebts,
  pendingDebtLinks, settleDebt, suggestDebtLinks, updateDebt,
  type DebtFrequency, type DebtLinkCandidate, type DebtRow,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Card, Pill, text, kes } from "../ui";

function cents(v: string): number | null {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
function dateAt(v: string): number | null {
  if (!v.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+03:00`);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function dateLabel(at: number | null): string {
  return at == null ? "not set" : new Date(at + 3 * 3_600_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function DebtManager({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const a = asDbAdapter(db);
  const [debts, setDebts] = useState<DebtRow[]>([]);
  const [pending, setPending] = useState<DebtLinkCandidate[]>([]);
  const [open, setOpen] = useState(false);
  const [contract, setContract] = useState("");
  const [name, setName] = useState("");
  const [creditor, setCreditor] = useState("");
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState("personal");
  const [principal, setPrincipal] = useState("");
  const [balance, setBalance] = useState("");
  const [rate, setRate] = useState("");
  const [payment, setPayment] = useState("");
  const [frequency, setFrequency] = useState<DebtFrequency>("monthly");
  const [start, setStart] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    try {
      setDebts(listDebts(a, "all"));
      setPending(pendingDebtLinks(a));
    } catch { setDebts([]); setPending([]); }
  };
  useEffect(load, [db]);

  const fillFromContract = () => {
    const x = extractDebtTerms(contract);
    if (x.principalCents) setPrincipal((x.principalCents / 100).toFixed(2));
    if (x.interestRateBps) setRate((x.interestRateBps / 100).toFixed(2));
    if (x.paymentCents) setPayment((x.paymentCents / 100).toFixed(2));
    if (x.paymentFrequency) setFrequency(x.paymentFrequency);
    if (x.startAt) setStart(new Date(x.startAt + 3 * 3_600_000).toISOString().slice(0, 10));
    Alert.alert("Contract read", x.confidence >= 0.6 ? "I filled the fields I could see. Check every value before saving." : "I found only a little. Fill the rest manually.");
  };

  const add = () => {
    if (busy) return;
    if (!name.trim()) { Alert.alert("Name the debt", "e.g. Personal loan — KCB"); return; }
    setBusy(true);
    try {
      createDebt(a, {
        name, creditor: creditor.trim() || null, creditorPhone: phone.trim() || null,
        kind: kind as "personal", principalCents: cents(principal), balanceCents: cents(balance) ?? cents(principal),
        interestRateBps: rate.trim() ? Math.round(Number(rate.replace(/[^0-9.]/g, "")) * 100) : null,
        interestType: rate.trim() ? "simple" : "none", paymentCents: cents(payment),
        paymentFrequency: frequency, startAt: dateAt(start), notes: notes.trim() || null,
      });
      setOpen(false); setContract(""); setName(""); setCreditor(""); setPhone(""); setPrincipal(""); setBalance("");
      setRate(""); setPayment(""); setStart(""); setNotes("");
      load(); onChanged();
    } catch (e) { Alert.alert("Could not add debt", String(e).slice(0, 180)); }
    finally { setBusy(false); }
  };

  const find = (d: DebtRow) => {
    try {
      const rows = suggestDebtLinks(a, d.id);
      load(); onChanged();
      Alert.alert("Repayment search", rows.length ? `${rows.length} likely repayment${rows.length === 1 ? "" : "s"} found. Review each below before accepting.` : "No safe matches yet. New payments to this creditor will be suggested automatically.");
    } catch (e) { Alert.alert("Search failed", String(e).slice(0, 180)); }
  };

  const accept = (c: DebtLinkCandidate) => {
    try { acceptDebtLink(a, c.debtId, c.txId); load(); onChanged(); } catch (e) { Alert.alert("Could not link", String(e).slice(0, 180)); }
  };
  const dismiss = (c: DebtLinkCandidate) => {
    try { dismissDebtLink(a, c.debtId, c.txId); load(); } catch { /* ignore */ }
  };

  return (
    <View>
      <Text style={[text(11, C.muted), { lineHeight: 17 }]}>
        Add a personal or business debt once. Pesanalysis stores the contract facts, suggests repayments already in the ledger, and lets you confirm them. No repayment is linked without your tap.
      </Text>
      {debts.length === 0 && <Text style={[text(12, C.dim), { marginTop: 10 }]}>No debts tracked yet.</Text>}
      {debts.map((d) => (
        <Card key={d.id} style={{ marginTop: 9, padding: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={text(13, C.text, "700")}>{d.name}</Text>
              <Text style={[text(10, C.dim), { marginTop: 2 }]}>{d.kind} · {d.creditor ?? "creditor not named"} · {d.interestRateBps != null ? `${(d.interestRateBps / 100).toFixed(2)}%` : "no rate"}</Text>
            </View>
            <Text style={text(14, d.balanceCents ? C.amber : C.green, "700")}>{d.balanceCents == null ? "—" : kes(d.balanceCents)}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
            <Pill label={d.paymentCents ? `${kes(d.paymentCents)} / ${d.paymentFrequency}` : "no payment set"} tone="dim" />
            <Pill label={`next ${dateLabel(d.nextDueAt)}`} tone={d.nextDueAt && d.nextDueAt < Date.now() ? "amber" : "dim"} />
            <Pill label={`${d.linkedCount} linked`} tone={d.linkedCount ? "green" : "dim"} />
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
            <Btn label="Find repayments" kind="soft" onPress={() => find(d)} style={{ flex: 1, paddingVertical: 8 }} />
            <Btn label={d.status === "settled" ? "Settled" : "Mark settled"} kind="ghost" onPress={() => {
              try { updateDebt(a, d.id, { balanceCents: 0 }); settleDebt(a, d.id); load(); onChanged(); } catch { /* ignore */ }
            }} style={{ flex: 1, paddingVertical: 8 }} />
          </View>
          {d.startAt != null && <Text style={[text(9, C.dim), { marginTop: 6 }]}>Tracking from {dateLabel(d.startAt)}{d.notes ? ` · ${d.notes.slice(0, 80)}` : ""}</Text>}
        </Card>
      ))}

      {pending.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <Text style={[text(11, C.muted, "700")]}>SUGGESTED REPAYMENTS</Text>
          {pending.map((c) => (
            <Card key={`${c.debtId}-${c.txId}`} style={{ marginTop: 8, padding: 11 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={text(12, C.text, "600")}>{c.cpName ?? "Unknown"} · {kes(c.amountCents)}</Text>
                  <Text style={text(10, C.dim)}>{dateLabel(c.occurredAt)} · {c.reason} · {Math.round(c.score * 100)}%</Text>
                </View>
                <Pill label="Debt repayment" tone="amber" />
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <Btn label="Accept" kind="soft" onPress={() => accept(c)} style={{ flex: 1, paddingVertical: 8 }} />
                <Btn label="No" kind="ghost" onPress={() => dismiss(c)} style={{ flex: 1, paddingVertical: 8 }} />
              </View>
            </Card>
          ))}
        </View>
      )}

      {!open ? (
        <Btn label="+ Add a debt" kind="soft" onPress={() => setOpen(true)} style={{ marginTop: 10, paddingVertical: 9 }} />
      ) : (
        <Card style={{ marginTop: 10 }}>
          <Text style={text(13, C.text, "700")}>New debt</Text>
          <Text style={[text(10, C.dim), { marginTop: 3, lineHeight: 15 }]}>Paste contract text to prefill what can be read locally. Every field stays editable.</Text>
          <TextInput value={contract} onChangeText={setContract} multiline placeholder="Paste contract text (optional)"
            placeholderTextColor={C.dim} style={[text(11, C.text), { backgroundColor: C.card2, borderRadius: 9, padding: 9, marginTop: 8, minHeight: 60 }]} />
          <Btn label="Read contract text" kind="ghost" onPress={fillFromContract} style={{ marginTop: 5, paddingVertical: 7 }} />
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            <TextInput value={name} onChangeText={setName} placeholder="Debt name *" placeholderTextColor={C.dim}
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
            <TextInput value={creditor} onChangeText={setCreditor} placeholder="Creditor" placeholderTextColor={C.dim}
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
            <TextInput value={principal} onChangeText={setPrincipal} placeholder="Principal KES" placeholderTextColor={C.dim} keyboardType="decimal-pad"
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
            <TextInput value={balance} onChangeText={setBalance} placeholder="Balance KES" placeholderTextColor={C.dim} keyboardType="decimal-pad"
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
            <TextInput value={rate} onChangeText={setRate} placeholder="Interest % p.a." placeholderTextColor={C.dim} keyboardType="decimal-pad"
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
            <TextInput value={payment} onChangeText={setPayment} placeholder="Payment KES" placeholderTextColor={C.dim} keyboardType="decimal-pad"
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
            <TextInput value={phone} onChangeText={setPhone} placeholder="Creditor phone (optional)" placeholderTextColor={C.dim} keyboardType="phone-pad"
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
            <TextInput value={start} onChangeText={setStart} placeholder="Start YYYY-MM-DD" placeholderTextColor={C.dim}
              style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8 }]} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
            {(["personal", "business", "loan", "informal"] as const).map((k) => (
              <TouchableOpacity key={k} onPress={() => setKind(k)}><Pill label={k} tone={kind === k ? "blue" : "dim"} /></TouchableOpacity>
            ))}
            {(["weekly", "biweekly", "monthly", "oneoff"] as const).map((f) => (
              <TouchableOpacity key={f} onPress={() => setFrequency(f)}><Pill label={f} tone={frequency === f ? "blue" : "dim"} /></TouchableOpacity>
            ))}
          </View>
          <TextInput value={notes} onChangeText={setNotes} placeholder="Notes / terms" placeholderTextColor={C.dim}
            style={[text(12, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 8, marginTop: 6 }]} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
            <Btn label={busy ? "Saving…" : "Save debt"} kind="soft" onPress={add} disabled={busy} style={{ flex: 1, paddingVertical: 8 }} />
            <Btn label="Cancel" kind="ghost" onPress={() => setOpen(false)} style={{ flex: 1, paddingVertical: 8 }} />
          </View>
        </Card>
      )}
      {debts.length > 0 && (
        <Text style={[text(10, C.dim), { marginTop: 10, lineHeight: 15 }]}>
          Outstanding {kes(debtSummary(a).outstandingCents)} · scheduled {kes(debtSummary(a).monthlyCents)}/month. Accepted repayments are tagged “Debt: name” and confirmed as Debt repayment.
        </Text>
      )}
    </View>
  );
}
