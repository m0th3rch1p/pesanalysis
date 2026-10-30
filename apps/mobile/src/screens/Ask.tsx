import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput,
  TouchableOpacity, View, type ScrollViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SQLiteDatabase } from "expo-sqlite";
import { formatKes, type EvidenceRow, type QueryPlan } from "@yako/core";
import { askAndStore, evidenceFor, loadConversation, newConversation, suggestedQuestions, type MobileAsk, type StoredTurn } from "../ask";
import { Btn, C, Pill, text } from "../ui";

function AnswerBody({ result, onEvidence }: { result: MobileAsk; onEvidence?: (plan: QueryPlan) => void }) {
  if (result.needs) {
    return <Text style={text(14, C.text, "600")}>{result.needs.question}</Text>;
  }
  if (result.answer) {
    return (
      <View>
        <Text style={text(14, C.text, "600")}>{result.answer.headline}</Text>
        {result.answer.bullets.map((b, i) => (
          <Text key={i} style={[text(13, C.muted), { marginTop: 5, lineHeight: 18 }]}>{b}</Text>
        ))}
        {result.answer.detail.map((d, i) => (
          <Text key={i} style={[text(11, C.dim), { marginTop: 5, lineHeight: 16 }]}>{d}</Text>
        ))}
        {result.matches != null && result.matches > 0 && result.plan && onEvidence ? (
          <TouchableOpacity onPress={() => onEvidence(result.plan!)} accessibilityRole="button" accessibilityLabel={`See ${result.matches} payments behind this answer`} style={{ minHeight: 48, justifyContent: "center", marginTop: 4 }}>
            <Text style={text(12, C.blue, "600")}>See {result.matches} payment{result.matches === 1 ? "" : "s"} ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  return <Text style={text(13, C.amber)}>{result.error ?? "I could not answer that yet."}</Text>;
}

function AssistantTurn({ turn, onOption, onEvidence }: { turn: StoredTurn; onOption: (s: string) => void; onEvidence: (plan: QueryPlan) => void }) {
  const result = turn.result;
  return (
    <View style={{ marginTop: 14, alignItems: "flex-start" }}>
      <View style={{ backgroundColor: C.card, borderRadius: 16, padding: 13, maxWidth: "94%" }}>
        {result ? <AnswerBody result={result} onEvidence={onEvidence} /> : <Text style={text(13, C.text)}>{turn.content}</Text>}
        {result?.answer && !result.answer.empty && (
          <Text style={[text(9, C.dim), { marginTop: 8 }]}>
            {result.provenance}{result.engine === "qvac" ? ` · on-device model${result.tokPerSec ? ` ${result.tokPerSec.toFixed(1)} tok/s` : ""}` : " · deterministic"}
          </Text>
        )}
        {result?.needs?.options?.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {result.needs.options.map((o) => (
              <TouchableOpacity key={o} onPress={() => onOption(o)} activeOpacity={0.7}>
                <Pill label={o} tone="blue" />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function AskScreen({ visible, onClose, db, onOpenTx }: { visible: boolean; onClose: () => void; db: SQLiteDatabase; onOpenTx?: (id: number) => void }) {
  const insets = useSafeAreaInsets();
  const [turns, setTurns] = useState<StoredTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<number | null>(null);
  const [evidence, setEvidence] = useState<{ plan: QueryPlan; rows: EvidenceRow[]; matches: number } | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const suggestions = useMemo(() => (visible ? suggestedQuestions(db) : []), [visible, db]);

  useEffect(() => {
    if (!visible) return;
    try {
      const t = loadConversation(db, conv ?? undefined);
      setTurns(t);
      if (!conv && t.length) { /* existing conversation */ }
    } catch { setTurns([]); }
  }, [visible, conv, db]);

  useEffect(() => {
    if (visible) setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
  }, [turns, busy, visible]);

  const openEvidence = (plan: QueryPlan) => {
    const rows = evidenceFor(db, plan);
    setEvidence({ plan, rows, matches: rows.length });
  };

  const send = async (textValue?: string) => {
    const q = (textValue ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    try {
      const { result, conversationId } = await askAndStore(db, q);
      setConv(conversationId);
      setTurns(loadConversation(db, conversationId));
      void result;
    } catch {
      setTurns((t) => [...t, { id: Date.now(), role: "assistant", content: "I could not run that on this phone. Try a simpler question.", plan: null, createdAt: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    try { setConv(newConversation(db)); } catch { setConv(null); }
    setTurns([]);
    setInput("");
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingBottom: 12 }}>
          <Text accessibilityRole="header" style={text(22, C.text, "700")}>Ask</Text>
          <Text style={[text(11, C.muted), { marginLeft: 8 }]}>on-device</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={reset} style={{ marginRight: 16, minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Start a new conversation"><Text style={text(12, C.muted)}>New</Text></TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Close Ask"><Text style={text(13, C.blue, "600")}>Done</Text></TouchableOpacity>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "android" ? 0 : 12} style={{ flex: 1 }}>
          <ScrollView ref={scroll} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
            {turns.length === 0 && (
              <View style={{ marginTop: 10 }}>
                <Text style={[text(13, C.muted), { lineHeight: 19 }]}>
                  Ask about your own ledger. The question and the numbers stay on this phone. Every answer shows how it was computed.
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                  {suggestions.map((q) => (
                    <TouchableOpacity key={q} onPress={() => send(q)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Ask: ${q}`} style={{ minHeight: 48, justifyContent: "center" }}>
                      <Pill label={q} tone="blue" />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {turns.map((t) => t.role === "user" ? (
              <View key={t.id} style={{ marginTop: 16, alignItems: "flex-end" }}>
                <View style={{ backgroundColor: C.blue, borderRadius: 16, paddingHorizontal: 13, paddingVertical: 9, maxWidth: "88%" }}>
                  <Text style={text(13, "#fff")}>{t.content}</Text>
                </View>
              </View>
            ) : (
              <AssistantTurn key={t.id} turn={t} onOption={send} onEvidence={openEvidence} />
            ))}
            {busy && (
              <View style={{ marginTop: 16, flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator color={C.blue} size="small" />
                <Text style={text(12, C.muted)}>Working it out on this phone…</Text>
              </View>
            )}
          </ScrollView>

          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: Math.max(14, insets.bottom), borderTopWidth: 1, borderTopColor: C.line }}>
            <TextInput
              value={input} onChangeText={setInput} placeholder="Ask about spending, fees, a venture…"
              placeholderTextColor={C.dim} multiline={false} returnKeyType="send" blurOnSubmit={false}
              onSubmitEditing={() => void send()} accessibilityLabel="Ask about your money"
              style={[text(13, C.text), { flex: 1, backgroundColor: C.card, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, maxHeight: 110 }]}
            />
            <TouchableOpacity onPress={() => send()} disabled={busy || !input.trim()} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Send question" accessibilityState={{ disabled: busy || !input.trim() }}
              style={{ backgroundColor: input.trim() && !busy ? C.blue : C.card2, borderRadius: 14, paddingHorizontal: 16, minHeight: 48, justifyContent: "center" }}>
              <Text style={text(14, input.trim() && !busy ? "#fff" : C.dim, "600")}>Send</Text>
            </TouchableOpacity>
          </View>
          <Text style={[text(9, C.dim), { textAlign: "center", paddingBottom: insets.bottom + 4 }]}>No network. No cloud model in the answer path.</Text>
        </KeyboardAvoidingView>
        {evidence ? (
          <Modal visible transparent animationType="slide" onRequestClose={() => setEvidence(null)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
              <View style={{ maxHeight: "82%", backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingBottom: 10 }}>
                  <Text accessibilityRole="header" style={[text(17, C.text, "700"), { flex: 1 }]}>Payments behind this answer</Text>
                  <Btn label="Close" kind="ghost" onPress={() => setEvidence(null)} style={{ paddingHorizontal: 10, minHeight: 48 }} />
                </View>
                <Text style={[text(11, C.muted), { paddingHorizontal: 20, paddingBottom: 8 }]}>{evidence.rows.length} shown · {formatKes(evidence.rows.reduce((n, r) => n + (r.direction === "out" ? r.amount : 0), 0))} out</Text>
                <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(28, insets.bottom) }}>
                  {evidence.rows.map((r) => (
                    <TouchableOpacity key={r.id} onPress={() => { setEvidence(null); onOpenTx?.(r.id); }} disabled={!onOpenTx}
                      accessibilityRole="button" accessibilityLabel={`${formatKes(r.amount)} ${r.direction === "in" ? "from" : "to"} ${r.counterparty ?? "unknown"}`}
                      style={{ flexDirection: "row", alignItems: "center", minHeight: 52, borderBottomWidth: 1, borderBottomColor: C.line }}>
                      <View style={{ flex: 1 }}>
                        <Text style={text(13, C.text, "600")}>{r.counterparty ?? "Unknown"}</Text>
                        <Text style={[text(10, C.dim), { marginTop: 2 }]}>{new Date(r.occurredAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{r.label ? ` · ${r.label}` : ""}</Text>
                      </View>
                      <Text style={text(13, r.direction === "in" ? C.green : C.text, "600")}>{r.direction === "in" ? "+" : "−"}{formatKes(r.amount)}</Text>
                    </TouchableOpacity>
                  ))}
                  {evidence.rows.length === 0 ? <Text style={[text(12, C.dim), { marginTop: 16 }]}>No matching payments in this range.</Text> : null}
                </ScrollView>
              </View>
            </View>
          </Modal>
        ) : null}
      </View>
    </Modal>
  );
}
