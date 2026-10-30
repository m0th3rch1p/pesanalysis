import { useEffect, useRef, useState } from "react";
import { Alert, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import * as ImagePicker from "expo-image-picker";
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync } from "expo-audio";
import { addTxItem, deleteTxItems, inferItems, learnItemPricesForTx, listLabelsFull, listTxItems, parseNote, suppressCounterparty, unsuppressCounterparty } from "@yako/core";
import { asDbAdapter } from "../db/open";
import { confirmTx } from "../review";
import { addAttachment, copyIntoApp, attachmentsFor, type Attachment } from "../media";
import { Btn, C, Pill, kes, text } from "../ui";
import { timeLabel } from "../queries";

type Mode = "detail" | "photo" | "voice" | "media";

interface Row {
  id: number; amount: number; direction: string; kind: string; occurredAt: number;
  cpId: number | null; cpName: string | null; label: string | null; note: string | null; status: string;
}

function load(db: SQLiteDatabase, id: number): Row | null {
  return db.getFirstSync<Row>(
    `SELECT t.id, t.amount, t.direction, t.kind, t.occurred_at AS occurredAt,
            c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names,'$[0]')) AS cpName,
            (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.tx_id=t.id
              ORDER BY (tl.confirmed_at IS NOT NULL) DESC, tl.confidence DESC LIMIT 1) AS label,
            (SELECT n.text FROM tx_notes n WHERE n.tx_id=t.id AND n.kind='note' ORDER BY n.created_at DESC LIMIT 1) AS note,
            t.status
       FROM tx_events t LEFT JOIN counterparties c ON c.id=t.counterparty_id WHERE t.id = ?`, [id],
  );
}

const GROUPS = ["Fruits", "Household", "Snacks", "Drinks", "Personal care"];

export function CaptureSheet({ db, txId, initialMode = "detail", onClose, onChanged }: {
  db: SQLiteDatabase; txId: number; initialMode?: Mode; onClose: () => void; onChanged: () => void;
}) {
  const [row, setRow] = useState<Row | null>(null);
  const [labels, setLabels] = useState<Array<{ name: string; txCount: number }>>([]);
  const [label, setLabel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [neverAsk, setNeverAsk] = useState(false);
  const [items, setItems] = useState<ReturnType<typeof listTxItems>>([]);
  const [cands, setCands] = useState<ReturnType<typeof inferItems>>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [tag, setTag] = useState<"planned" | "impulse" | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadedFor = useRef<number | null>(null);
  const recordStart = useRef(0);
  const [recording, setRecording] = useState(false);

  const refresh = (syncInput = false) => {
    const r = load(db, txId);
    setRow(r);
    if (syncInput || loadedFor.current !== txId) {
      setLabel(r?.label ?? null);
      setNote(r?.note ?? "");
      loadedFor.current = txId;
    }
    setAtts(attachmentsFor(db, txId));
    const a = asDbAdapter(db);
    try { setItems(listTxItems(a, txId)); } catch { setItems([]); }
    try {
      const t = db.getFirstSync<{ amount: number; direction: string; kind: string; template: string; cpId: number | null; cpName: string | null }>(
        `SELECT t.amount, t.direction, t.kind, t.template, t.counterparty_id AS cpId,
                COALESCE(c.display_name, json_extract(c.raw_names,'$[0]')) AS cpName
           FROM transactions t LEFT JOIN counterparties c ON c.id=t.counterparty_id WHERE t.id=?`, [txId]);
      setCands(t ? inferItems(a, { id: txId, counterpartyId: t.cpId, amountCents: t.amount }) : []);
    } catch { setCands([]); }
    try {
      setLabels(listLabelsFull(a).filter((l) => l.txCount > 0 || l.parentName).map((l) => ({ name: l.name, txCount: l.txCount })));
    } catch { setLabels([]); }
  };
  useEffect(() => { refresh(true); }, [txId]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const addGuess = (c: (typeof cands)[number]) => {
    const a = asDbAdapter(db);
    deleteTxItems(a, txId, "inferred");
    for (const it of c.items) addTxItem(a, txId, { itemId: it.itemId, qty: it.qty, amountCents: it.amountCents, source: "inferred", confidence: c.confidence, confirmed: true });
    learnItemPricesForTx(a, txId);
    refresh(); onChanged();
  };
  const addGroup = (g: string) => {
    if (groups.includes(g)) return;
    addTxItem(asDbAdapter(db), txId, { group: g, source: "user", confirmed: true });
    setGroups((old) => [...old, g]); refresh(); onChanged();
  };
  const save = () => {
    if (!row || !label) { Alert.alert("Pick a category", "Choose what this payment was for, then save."); return; }
    confirmTx(db, txId, label, "user", note.trim() || undefined);
    if (tag) {
      const exists = db.getFirstSync<{ id: number }>(`SELECT id FROM tx_notes WHERE tx_id = ? AND kind = 'tag' AND text = ?`, [txId, tag]);
      if (!exists) db.runSync(`INSERT INTO tx_notes (tx_id, kind, text, created_at) VALUES (?, 'tag', ?, ?)`, [txId, tag, Date.now()]);
    }
    if (row.cpId != null) {
      if (neverAsk) suppressCounterparty(asDbAdapter(db), row.cpId);
      else unsuppressCounterparty(asDbAdapter(db), row.cpId);
    }
    refresh(true); onChanged(); onClose();
  };

  const pick = async (source: "library" | "camera", kind: "photo" | "video") => {
    if (busy) return;
    setBusy(true);
    try {
      if (source === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) throw new Error("camera permission denied");
      }
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: kind === "video" ? ["videos"] : ["images"], quality: 0.8, videoMaxDuration: 60 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: kind === "video" ? ["videos"] : ["images"], quality: 0.8, videoMaxDuration: 60 });
      if (res.canceled || !res.assets.length) return;
      const a = res.assets[0]!;
      const dot = a.fileName?.lastIndexOf(".") ?? -1;
      const ext = dot > 0 ? a.fileName!.slice(dot + 1) : (kind === "video" ? "mp4" : "jpg");
      const copied = copyIntoApp(a.uri, txId, ext);
      addAttachment(db, { txId, kind, uri: copied.uri, mime: a.mimeType ?? null, bytes: a.fileSize ?? copied.bytes, durationMs: a.duration ?? null, width: a.width ?? null, height: a.height ?? null, caption: null });
      refresh(); onChanged();
    } catch (e) { Alert.alert("Could not attach", "The media could not be saved on this phone. Try again."); }
    finally { setBusy(false); }
  };

  const startVoice = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) { Alert.alert("Microphone off", "Allow microphone access to record a voice note. It stays on this phone."); return; }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
      recordStart.current = Date.now();
      setRecordSec(0);
      timer.current = setInterval(() => setRecordSec((s) => { if (s >= 59) { void stopVoice(); return 60; } return s + 1; }), 1000);
    } catch (e) { Alert.alert("Could not record", "The microphone could not start. Check permission and try again."); }
  };

  const stopVoice = async () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    try {
      setBusy(true);
      await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (uri) {
        const copied = copyIntoApp(uri, txId, "m4a");
        const durationMs = recordStart.current ? Math.max(0, Date.now() - recordStart.current) : recordSec * 1000;
        addAttachment(db, { txId, kind: "voice", uri: copied.uri, mime: "audio/mp4", bytes: copied.bytes, durationMs, width: null, height: null, caption: null });
        refresh(false); onChanged();
      }
    } catch (e) { Alert.alert("Voice note failed", "Could not save this recording. Try again."); }
    finally { setBusy(false); setRecording(false); setRecordSec(0); }
  };

  const toggleNeverAsk = () => {
    const next = !neverAsk;
    setNeverAsk(next);
    if (row?.cpId != null) {
      if (next) suppressCounterparty(asDbAdapter(db), row.cpId);
      else unsuppressCounterparty(asDbAdapter(db), row.cpId);
      onChanged();
    }
  };

  const closeSheet = () => {
    if (recording) void stopVoice().finally(onClose);
    else onClose();
  };

  if (!row) return null;
  const top = showAll ? labels : labels.slice(0, 8);
  const notePreview = (() => {
    if (!note.trim()) return [];
    try {
      return parseNote(note, {
        direction: row.direction === "in" ? "in" : "out", txAmountCents: row.amount,
        interpretCtx: { direction: row.direction === "in" ? "in" : "out", kind: row.kind, counterpartyName: row.cpName },
      }).items;
    } catch { return []; }
  })();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={closeSheet}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{ maxHeight: "90%", backgroundColor: C.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16 }}>
            <Text style={text(18, C.text, "700")}>What was this for?</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={closeSheet} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Close capture sheet"><Text style={text(14, C.blue, "600")}>Close</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
            <Text style={text(30, row.direction === "in" ? C.green : C.text, "700")}>{row.direction === "in" ? "+" : "−"}{kes(row.amount)}</Text>
            <Text style={[text(14, C.text, "600"), { marginTop: 3 }]}>{row.cpName ?? row.kind.replace(/_/g, " ")}</Text>
            <Text style={[text(12, C.muted), { marginTop: 2 }]}>{timeLabel(row.occurredAt)} · {row.kind.replace(/_/g, " ")}</Text>

            {cands.length > 0 && (
              <>
                <Text style={[text(12, C.muted, "700"), { marginTop: 16 }]}>LIKELY ITEMS</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
                  {cands.map((c, i) => (
                    <TouchableOpacity key={i} onPress={() => addGuess(c)} accessibilityRole="button" accessibilityLabel={`Use guess ${c.items.map((x) => x.name).join(" and ")}`}>
                      <Pill label={`${c.items.map((x) => `${x.qty && x.qty > 1 ? `${x.qty} ` : ""}${x.name}`).join(" + ")}?`} tone="amber" />
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[text(10, C.dim), { marginTop: 4 }]}>{cands[0]!.why}</Text>
              </>
            )}
            {items.length > 0 && (
              <Text style={[text(10, C.dim), { marginTop: 6 }]}>{items.map((i) => i.itemName ?? i.groupName ?? "item").join(" · ")}</Text>
            )}

            <Text style={[text(12, C.muted, "700"), { marginTop: 16 }]}>CATEGORY</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
              {top.map((l) => (
                <TouchableOpacity key={l.name} onPress={() => setLabel(l.name)} accessibilityRole="radio" accessibilityState={{ selected: label === l.name }}>
                  <Pill label={l.name} tone={label === l.name ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
              {labels.length > 8 && (
                <TouchableOpacity onPress={() => setShowAll((v) => !v)}><Pill label={showAll ? "less" : `+${labels.length - 8} more`} tone="dim" /></TouchableOpacity>
              )}
            </View>

            {initialMode !== "detail" && (
              <>
                <Text style={[text(12, C.muted, "700"), { marginTop: 18 }]}>GROUP (OPTIONAL)</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
                  {GROUPS.map((g) => (
                    <TouchableOpacity key={g} onPress={() => addGroup(g)} accessibilityRole="checkbox" accessibilityState={{ checked: groups.includes(g) }}>
                      <Pill label={g} tone={groups.includes(g) ? "blue" : "dim"} />
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Text style={[text(12, C.muted, "700"), { marginTop: 18 }]}>NOTE</Text>
            <TextInput
              value={note} onChangeText={setNote} placeholder="e.g. cigarettes 30 · chapo · 6 eggs"
              placeholderTextColor={C.dim} multiline
              style={[text(14, C.text), { backgroundColor: C.card2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8, minHeight: 64 }]}
            />
            {notePreview.length > 0 && (
              <Text style={[text(11, C.blue), { marginTop: 5 }]}>Adds: {notePreview.map((i) => `${i.qty && i.qty > 1 ? `${i.qty} ` : ""}${i.name}`).join(", ")}</Text>
            )}

            <Text style={[text(12, C.muted, "700"), { marginTop: 18 }]}>ATTACH</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              <Btn label="Photo" kind="soft" onPress={() => void pick("camera", "photo")} disabled={busy} style={{ flex: 1, minWidth: 100 }} />
              <Btn label="Video" kind="soft" onPress={() => void pick("camera", "video")} disabled={busy} style={{ flex: 1, minWidth: 100 }} />
              <Btn label={recording ? `Stop ${recordSec}s` : "Voice"} kind={recording ? "primary" : "soft"} onPress={() => recording ? void stopVoice() : void startVoice()} disabled={busy} style={{ flex: 1, minWidth: 100 }} />
              <Btn label="Receipt" kind="soft" onPress={() => void pick("library", "photo")} disabled={busy} style={{ flex: 1, minWidth: 100 }} />
            </View>
            {atts.length > 0 && (
              <Text style={[text(11, C.dim), { marginTop: 8 }]}>{atts.length} attachment{atts.length === 1 ? "" : "s"} saved on this phone.</Text>
            )}

            <Text style={[text(12, C.muted, "700"), { marginTop: 18 }]}>WAS THIS PLANNED?</Text>
            <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
              {(["planned", "impulse"] as const).map((t) => (
                <TouchableOpacity key={t} onPress={() => setTag(tag === t ? null : t)} accessibilityRole="radio" accessibilityState={{ selected: tag === t }}>
                  <Pill label={t} tone={tag === t ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
            </View>

            {row.cpId != null && (
              <TouchableOpacity onPress={toggleNeverAsk} style={{ flexDirection: "row", alignItems: "center", marginTop: 18, minHeight: 48 }} accessibilityRole="checkbox" accessibilityState={{ checked: neverAsk }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: neverAsk ? C.blue : C.dim, backgroundColor: neverAsk ? C.blue : "transparent", marginRight: 9, alignItems: "center", justifyContent: "center" }}>
                  {neverAsk && <Text style={text(12, "#fff", "700")}>✓</Text>}
                </View>
                <Text style={text(12, C.muted)}>Never ask about {row.cpName ?? "this counterparty"}</Text>
              </TouchableOpacity>
            )}

            <View style={{ marginTop: 18 }}>
              <Btn label="Save" kind="primary" onPress={save} style={{ minHeight: 50 }} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
