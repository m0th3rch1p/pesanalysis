import { useEffect, useState } from "react";
import {
  Alert, Image, Modal, ScrollView, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import * as ImagePicker from "expo-image-picker";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  addNote, addTxItem, confirmTxItems, createProduct, createRole, deleteTxItems, learnItemPricesForTx, listRolesFull, listTxItems,
  matchProducts, mergeOcrLines, parseReceipt, setCounterpartyRole, tagTx, untagTx, tagsForTx, listTags,
  type RoleRow, type TagRow, type TxItemRow,
} from "@yako/core";
import { imageHash } from "../../modules/yako-sms";
import { asDbAdapter } from "../db/open";
import { addAttachment, attachmentsFor, copyIntoApp, deleteAttachment, fileUri, type Attachment } from "../media";
import { Btn, C, Card, Pill, kes, text } from "../ui";
import { timeLabel } from "../queries";
import { notificationState } from "../notify";

interface TxContext {
  lat: number | null; lng: number | null; accuracy: number | null;
  batteryPct: number | null; isCharging: number | null;
  calendarTitle: string | null; source: string | null; capturedAt: number | null;
}

interface TxFull {
  id: number; occurredAt: number; amount: number; fee: number | null; direction: string; kind: string;
  provider: string; status: string; scope: string; template: string; cpName: string | null;
  label: string | null; note: string | null; cpId: number | null; role: string | null;
}

function loadTx(db: SQLiteDatabase, id: number): TxFull | null {
  return db.getFirstSync<TxFull>(
    `SELECT t.id, t.occurred_at AS occurredAt, t.amount, t.fee, t.direction, t.kind, t.provider,
            t.status, t.scope, t.template,
            c.id AS cpId, COALESCE(c.display_name, json_extract(c.raw_names, '$[0]')) AS cpName,
            r.name AS role,
            (SELECT l.name FROM tx_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.tx_id = t.id
              ORDER BY (tl.confirmed_at IS NOT NULL) DESC, tl.confidence DESC LIMIT 1) AS label,
            (SELECT n.text FROM tx_notes n WHERE n.tx_id = t.id AND n.kind = 'note' ORDER BY n.created_at DESC LIMIT 1) AS note
       FROM tx_events t LEFT JOIN counterparties c ON c.id = t.counterparty_id
       LEFT JOIN roles r ON r.id = c.role_id WHERE t.id = ?`,
    [id],
  );
}

function VideoAttachment({ a, onDelete, onTrack }: { a: Attachment; onDelete: () => void; onTrack: () => void }) {
  const player = useVideoPlayer(fileUri(a.uri), (p) => { p.loop = false; });
  return (
    <View style={{ marginTop: 10 }}>
      <VideoView player={player} style={{ width: "100%", height: 200, borderRadius: 12 }} nativeControls contentFit="contain" />
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        <TouchableOpacity onPress={onTrack}><Text style={text(11, C.blue, "600")}>Track this item</Text></TouchableOpacity>
        <TouchableOpacity onPress={onDelete}><Text style={text(11, C.red)}>remove</Text></TouchableOpacity>
      </View>
    </View>
  );
}

export function TxDetail({ db, txId, onClose, onChanged }: { db: SQLiteDatabase; txId: number; onClose: () => void; onChanged: () => void }) {
  const [tx, setTx] = useState<TxFull | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [ctx, setCtx] = useState<TxContext | null>(null);
  const [tags, setTags] = useState<Array<{ id: number; name: string; kind: string }>>([]);
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [newRole, setNewRole] = useState("");
  const [tracking, setTracking] = useState<Attachment | null>(null);
  const [receiptBusy, setReceiptBusy] = useState<number | null>(null);
  const [txItems, setTxItems] = useState<TxItemRow[]>([]);
  const [itemName, setItemName] = useState("");
  const [itemBrand, setItemBrand] = useState("");
  const [warrantyMonths, setWarrantyMonths] = useState("12");
  const [savingItem, setSavingItem] = useState(false);

  /** Read 1-4 receipt photos, merge overlaps in either attach order, and apply items only on a total match. */
  const readReceipts = async (photos: Attachment[]) => {
    const chosen = [...photos].sort((a, b) => a.id - b.id).slice(0, 4);
    if (!chosen.length) return;
    setReceiptBusy(chosen[0]!.id);
    let notifId: string | null = null;
    const progress = async (i: number, n: number) => {
      try {
        const st = await notificationState();
        if (!st.granted) return;
        const Notifications = await import("expo-notifications");
        if (notifId) await Notifications.dismissNotificationAsync(notifId).catch(() => undefined);
        notifId = await Notifications.scheduleNotificationAsync({
          content: { title: `Reading receipt ${i} of ${n}`, body: "On this phone. Nothing is uploaded.", sound: false },
          trigger: null,
        });
      } catch { /* progress is best effort */ }
    };
    try {
      const q = await import("../qvac");
      if (!q.localPath(q.MODELS.ocr_latin) || !q.localPath(q.MODELS.ocr_craft)) {
        Alert.alert("Receipt reader needs setup", "Staging the OCR model needs a network connection once. Open More > On-device intelligence, download receipt reading, then come back. Your photo never leaves the phone.");
        return;
      }
      const loaded = await q.loadLocal(q.MODELS.ocr_latin);
      const perPhoto: Array<Array<{ text: string; confidence?: number }>> = [];
      for (let i = 0; i < chosen.length; i++) {
        const a = chosen[i]!;
        setReceiptBusy(a.id);
        await progress(i + 1, chosen.length);
        q.beginInference("ocr:receipt");
        try { perPhoto.push((await q.ocrImage(loaded.modelId, fileUri(a.uri))).blocks); } finally { q.endInference(); }
      }
      const blocks = mergeOcrLines(perPhoto);
      if (!blocks.length) { Alert.alert("Nothing readable", "We could not read text from these photos. Try clearer, straight-on photos of the till slip."); return; }
      const r = parseReceipt(blocks, { now: tx!.occurredAt });
      const total = r.totalCents?.value ?? null;
      const merchant = r.merchant?.value ?? null;
      const date = r.date?.value ?? null;
      const tolerance = Math.max(100, Math.round(tx!.amount * 0.01));
      const diff = total != null && Math.abs(total - tx!.amount) > tolerance;
      const items = r.items;
      const lines = blocks.map((b) => b.text).filter(Boolean).slice(0, 60).join("\n");
      const summary = [
        total != null ? `Total on receipt: ${kes(total)}` : "No clear total found",
        merchant ? `Merchant: ${merchant}` : null,
        date ? `Date: ${date}` : null,
        items.length ? `${items.length} items: ${items.slice(0, 4).map((i) => `${i.name} ${kes(i.amountCents)}`).join(", ")}${items.length > 4 ? "…" : ""}` : "No item lines found",
        diff ? `Receipt total differs from the payment (${kes(tx!.amount)} by ${kes(Math.abs(total! - tx!.amount))}).` : total != null ? "The total matches the payment." : null,
      ].filter(Boolean).join("\n");
      const save = (applyItems: boolean) => {
        addNote(asDbAdapter(db), txId, "note",
          `Receipt (read on device): ${[merchant && `merchant ${merchant}`, total != null && `total ${kes(total)}`, date && `date ${date}`].filter(Boolean).join(", ")}.` + (diff ? " Receipt total differs from the payment amount; please check." : ""),
          null, Date.now());
        if (applyItems) {
          deleteTxItems(asDbAdapter(db), txId, "ocr");
          for (const it of items) addTxItem(asDbAdapter(db), txId, {
            item: it.name, qty: it.qty, amountCents: it.amountCents, source: "ocr", confidence: it.confidence, confirmed: false,
          });
        }
        refresh(); onChanged();
      };
      const buttons: Array<{ text: string; style?: "cancel" | "default" | "destructive"; onPress?: () => void }> = [
        { text: "Cancel", style: "cancel" },
        { text: "Note only", onPress: () => save(false) },
      ];
      if (items.length) buttons.push({ text: diff ? "Apply items anyway" : "Save items", onPress: () => save(true) });
      Alert.alert(diff ? "Receipt total does not match" : "Receipt read on this phone", summary + (diff ? "\n\nCheck the photos. Items are not applied unless you choose." : ""), buttons);
      if (items.length && !diff) { /* user chooses; nothing auto-confirmed */ }
    } catch (e) {
      Alert.alert("Could not read receipt", "The on-device reader could not finish. Try clearer, straight-on photos. The photos stay on this phone.");
    } finally {
      setReceiptBusy(null);
      try { if (notifId) { const N = await import("expo-notifications"); await N.dismissNotificationAsync(notifId); } } catch { /* gone */ }
    }
  };

  const refresh = () => {
    setTx(loadTx(db, txId));
    setTxItems(listTxItems(asDbAdapter(db), txId));
    setAtts(attachmentsFor(db, txId));
    setCtx(db.getFirstSync<TxContext>(
      `SELECT lat, lng, accuracy_m AS accuracy, battery_pct AS batteryPct, is_charging AS isCharging,
              calendar_title AS calendarTitle, source, captured_at AS capturedAt
         FROM tx_context WHERE tx_id = ?`, [txId],
    ) ?? null);
    setTags(tagsForTx(asDbAdapter(db), txId));
    setAllTags(listTags(asDbAdapter(db)).filter((t) => t.status === "active"));
    try { setRoles(listRolesFull(asDbAdapter(db))); } catch { setRoles([]); }
  };
  useEffect(refresh, [txId]);

  const pick = async (source: "library" | "camera") => {
    if (busy) return;
    setBusy(true);
    try {
      if (source === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) throw new Error("camera permission denied");
      }
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images", "videos"], quality: 0.8, videoMaxDuration: 60 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"], quality: 0.8, videoMaxDuration: 60,
            allowsMultipleSelection: true, selectionLimit: 4, orderedSelection: true,
          });
      if (res.canceled || !res.assets.length) return;
      let added = 0;
      for (const a of res.assets.slice(0, 4)) {
        try {
          const kind = a.type === "video" ? "video" : "photo";
          const ext = a.fileName?.split(".").pop() ?? a.mimeType?.split("/").pop() ?? (kind === "video" ? "mp4" : "jpg");
          const copied = copyIntoApp(a.uri, txId, ext);
          addAttachment(db, {
            txId, kind, uri: copied.uri, mime: a.mimeType ?? null, bytes: a.fileSize ?? copied.bytes,
            durationMs: a.duration ?? null, width: a.width ?? null, height: a.height ?? null, caption: null,
          });
          added++;
        } catch { /* keep other selected files; report below if none survived */ }
      }
      if (!added) throw new Error("no media copied");
      refresh();
      onChanged();
      if (added < res.assets.slice(0, 4).length) {
        Alert.alert("Some media was not attached", `${added} of ${res.assets.slice(0, 4).length} selected files were saved. Try the rest again.`);
      }
    } catch (e) {
      Alert.alert("Could not attach", "The media could not be saved on this phone. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const saveNote = () => {
    const t = note.trim();
    if (!t) return;
    addNote(asDbAdapter(db), txId, "note", t, null);
    setNote("");
    refresh();
    onChanged();
  };

  const saveTag = (name: string) => {
    const t = name.trim();
    if (!t) return;
    tagTx(asDbAdapter(db), txId, t, "user");
    setTag("");
    refresh();
    onChanged();
  };

  if (!tx) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={{ maxHeight: "92%", backgroundColor: C.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 16 }}>
            <Text style={text(18, C.text, "700")}>Transaction</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose}><Text style={text(14, C.blue, "600")}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <Text style={text(34, tx.direction === "in" ? C.green : C.text, "700")}>
              {tx.direction === "in" ? "+" : "−"}{kes(tx.amount)}
            </Text>
            <Text style={[text(15, C.text, "600"), { marginTop: 4 }]}>{tx.cpName ?? tx.kind.replace(/_/g, " ")}</Text>
            <Text style={[text(12, C.muted), { marginTop: 2 }]}>{timeLabel(tx.occurredAt)} · {tx.kind.replace(/_/g, " ")} · {tx.provider}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {tx.label && <Pill label={tx.label} tone="blue" />}
              <Pill label={tx.status} tone={tx.status === "pending" ? "amber" : "green"} />
              <Pill label={tx.scope} />
              {(tx.fee ?? 0) > 0 && <Pill label={`fee ${kes(tx.fee!)}`} tone="amber" />}
            </View>

            {tx.cpId != null && (
              <Card style={{ marginTop: 18 }}>
                <Text style={text(12, C.muted, "700")}>WHO IS THIS?</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {roles.map((r) => (
                    <TouchableOpacity key={r.id} onPress={() => {
                      setCounterpartyRole(asDbAdapter(db), tx.cpId!, r.id); refresh(); onChanged();
                    }}>
                      <Pill label={r.name} tone={tx.role === r.name ? "blue" : "dim"} />
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
                  <TextInput value={newRole} onChangeText={setNewRole} placeholder="New role, e.g. supplier"
                    placeholderTextColor={C.dim}
                    style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
                  <TouchableOpacity onPress={() => {
                    const n = newRole.trim(); if (!n || tx.cpId == null) return;
                    try {
                      const id = createRole(asDbAdapter(db), n);
                      setCounterpartyRole(asDbAdapter(db), tx.cpId, id);
                      setNewRole(""); refresh(); onChanged();
                    } catch { /* duplicate/invalid */ }
                  }}><Text style={text(12, C.blue, "600")}>Add</Text></TouchableOpacity>
                </View>
              </Card>
            )}

            {ctx && (
              <Card style={{ marginTop: 18 }}>
                <Text style={text(12, C.muted, "700")}>CONTEXT (ON-DEVICE)</Text>
                {ctx.calendarTitle ? <Text style={[text(13, C.text, "600"), { marginTop: 6 }]}>Calendar · {ctx.calendarTitle}</Text> : null}
                <Text style={[text(11, C.muted), { marginTop: 4 }]}>
                  {[
                    ctx.lat != null ? `location ${ctx.lat.toFixed(4)}, ${ctx.lng!.toFixed(4)}${ctx.accuracy ? ` ±${Math.round(ctx.accuracy)}m` : ""}` : null,
                    ctx.batteryPct != null ? `battery ${ctx.batteryPct}%${ctx.isCharging ? " charging" : ""}` : null,
                    ctx.source ? `via ${ctx.source}` : null,
                  ].filter(Boolean).join(" · ") || "No location/battery snapshot for this message."}
                </Text>
              </Card>
            )}

            <Card style={{ marginTop: 18 }}>
              <Text style={text(12, C.muted, "700")}>TAGS & VENTURES</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {tags.map((t) => (
                  <TouchableOpacity key={t.id} onPress={() => { untagTx(asDbAdapter(db), txId, t.id); refresh(); onChanged(); }} activeOpacity={0.7}>
                    <Pill label={`${t.name} ×`} tone={t.kind === "venture" ? "green" : "dim"} />
                  </TouchableOpacity>
                ))}
                {tags.length === 0 && <Text style={text(12, C.dim)}>No tags yet. Tag this to a venture.</Text>}
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <TextInput
                  value={tag} onChangeText={setTag} placeholder="Add tag or venture" placeholderTextColor={C.dim}
                  onSubmitEditing={() => saveTag(tag)}
                  style={[text(13, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }]}
                />
                <TouchableOpacity onPress={() => saveTag(tag)}><Text style={text(13, C.blue, "600")}>Add</Text></TouchableOpacity>
              </View>
              {allTags.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                  {allTags.filter((t) => !tags.some((x) => x.id === t.id)).slice(0, 12).map((t) => (
                    <TouchableOpacity key={t.id} onPress={() => saveTag(t.name)} style={{ marginRight: 6 }}>
                      <Pill label={t.name} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </Card>

            <Card style={{ marginTop: 12 }}>
              <Text style={text(12, C.muted, "700")}>NOTE</Text>
              {tx.note ? <Text style={[text(13, C.text), { marginTop: 6, lineHeight: 19 }]}>{tx.note}</Text> : null}
              <TextInput
                value={note} onChangeText={setNote} placeholder="What was this for? (optional)"
                placeholderTextColor={C.dim} multiline
                style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 10, padding: 10, marginTop: 8, minHeight: 44 }]}
              />
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <Btn label="Save note" kind="soft" onPress={saveNote} style={{ flex: 1, paddingVertical: 9 }} />
              </View>
            </Card>

            <Card style={{ marginTop: 12 }}>
              <Text style={text(12, C.muted, "700")}>PHOTOS & VIDEOS</Text>
              <Text style={[text(11, C.dim), { marginTop: 3 }]}>Stored only on this phone. Not encrypted at file level yet.</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <Btn label="Camera" kind="soft" onPress={() => pick("camera")} disabled={busy} style={{ flex: 1, paddingVertical: 9 }} />
                <Btn label="Library" kind="soft" onPress={() => pick("library")} disabled={busy} style={{ flex: 1, paddingVertical: 9 }} />
              </View>
              {txItems.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={text(11, C.muted, "700")}>ITEMS</Text>
                  {txItems.map((it) => (
                    <View key={it.id} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 3 }}>
                      <Text style={text(12, C.text)}>{it.itemName ?? it.groupName ?? "Item"}{it.qty && it.qty > 1 ? ` × ${it.qty}` : ""}</Text>
                      <Text style={text(12, C.muted)}>{it.amountCents != null ? kes(it.amountCents) : ""}</Text>
                    </View>
                  ))}
                  {txItems.some((it) => it.confirmedAt == null) && (
                    <TouchableOpacity onPress={() => {
                      confirmTxItems(asDbAdapter(db), txId);
                      learnItemPricesForTx(asDbAdapter(db), txId);
                      refresh(); onChanged();
                    }} style={{ marginTop: 6 }}><Text style={text(11, C.blue, "600")}>Confirm these items</Text></TouchableOpacity>
                  )}
                </View>
              )}
              {atts.filter((a) => a.kind === "photo").length > 1 && (
                <Btn label={`Read all ${Math.min(4, atts.filter((a) => a.kind === "photo").length)} photos`} kind="soft"
                  onPress={() => void readReceipts(atts.filter((a) => a.kind === "photo"))} disabled={receiptBusy != null}
                  style={{ marginTop: 10, paddingVertical: 9 }} />
              )}
              {atts.filter((a) => a.kind === "photo").map((a) => (
                <View key={a.id} style={{ marginTop: 10 }}>
                  <Image source={{ uri: fileUri(a.uri) }} style={{ width: "100%", height: 190, borderRadius: 12 }} resizeMode="cover" />
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                    <TouchableOpacity onPress={() => {
                      setTracking(a); setItemName(tx.cpName ?? "Item");
                      setItemBrand(""); setWarrantyMonths("12");
                    }}><Text style={text(11, C.blue, "600")}>Track this item</Text></TouchableOpacity>
                    <View style={{ flexDirection: "row", gap: 16 }}>
                      <TouchableOpacity onPress={() => void readReceipts([a])} disabled={receiptBusy === a.id} accessibilityRole="button" accessibilityLabel="Read this receipt on the device">
                        <Text style={text(11, C.blue, "600")}>{receiptBusy === a.id ? "Reading…" : "Read receipt"}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => { deleteAttachment(db, a.id); refresh(); onChanged(); }}><Text style={text(11, C.red)}>remove</Text></TouchableOpacity>
                    </View>
                  </View>
                </View>
              ))}
              {atts.filter((a) => a.kind === "video").map((a) => (
                <VideoAttachment key={a.id} a={a}
                  onTrack={() => { setTracking(a); setItemName(tx.cpName ?? "Item"); setItemBrand(""); setWarrantyMonths("12"); }}
                  onDelete={() => { deleteAttachment(db, a.id); refresh(); onChanged(); }} />
              ))}
              {atts.filter((a) => a.kind === "document").map((a) => (
                <View key={a.id} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                  <Text style={text(12, C.text)}>{a.caption ?? a.uri.split("/").pop()}</Text>
                  <TouchableOpacity onPress={() => { deleteAttachment(db, a.id); refresh(); onChanged(); }}><Text style={text(11, C.red)}>remove</Text></TouchableOpacity>
                </View>
              ))}
            </Card>

            <Text style={[text(10, C.dim), { marginTop: 16, lineHeight: 15 }]}>
              Parsed by {tx.template} · scope {tx.scope} · transaction #{tx.id}
            </Text>

            {tracking && (
              <Card style={{ marginTop: 12, borderColor: C.blue }}>
                <Text style={text(13, C.text, "700")}>Track this item</Text>
                <Text style={[text(10, C.dim), { marginTop: 3 }]}>The photo stays on this phone. The fingerprint is used only to find similar items here.</Text>
                <TextInput value={itemName} onChangeText={setItemName} placeholder="Item name" placeholderTextColor={C.dim}
                  style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, marginTop: 8 }]} />
                <TextInput value={itemBrand} onChangeText={setItemBrand} placeholder="Brand (optional)" placeholderTextColor={C.dim}
                  style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6 }]} />
                <TextInput value={warrantyMonths} onChangeText={setWarrantyMonths} placeholder="Warranty months" placeholderTextColor={C.dim} keyboardType="number-pad"
                  style={[text(13, C.text), { backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6 }]} />
                <View style={{ flexDirection: "row", gap: 8, marginTop: 9 }}>
                  <Btn label={savingItem ? "Saving…" : "Save item"} kind="soft" disabled={savingItem} onPress={async () => {
                    if (savingItem || !itemName.trim()) return;
                    setSavingItem(true);
                    try {
                      const hash = tracking.kind === "photo" ? await imageHash(fileUri(tracking.uri)) : null;
                      const matches = hash ? matchProducts(asDbAdapter(db), hash) : [];
                      createProduct(asDbAdapter(db), {
                        txId: tx.id, attachmentId: tracking.id, name: itemName, brand: itemBrand || null,
                        boughtAt: tx.occurredAt, priceCents: tx.amount,
                        warrantyMonths: Number(warrantyMonths) || null, imageHash: hash,
                      });
                      setTracking(null); refresh(); onChanged();
                      const close = matches.find((m) => m.distance <= 8);
                      Alert.alert("Item saved", close ? `Looks similar to ${close.product.name}${close.product.brand ? ` (${close.product.brand})` : ""} — ${Math.round((1 - close.distance / 64) * 100)}% visual match.` : "Warranty and lifespan tracking started for this item.");
                    } catch (e) { Alert.alert("Could not save item", "That item could not be saved. Try again."); }
                    finally { setSavingItem(false); }
                  }} style={{ flex: 1, paddingVertical: 9 }} />
                  <Btn label="Cancel" kind="ghost" onPress={() => setTracking(null)} style={{ flex: 1, paddingVertical: 9 }} />
                </View>
              </Card>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
