import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Image } from "expo-image";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  brandLifespans, deleteProduct, listProducts, matchProducts, setProductStatus, warrantyInfo,
  type BrandLife, type Product,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { fileUri } from "../media";
import { Btn, C, Card, Empty, Pill, Screen, SectionTitle, kes, text } from "../ui";

function WarrantyPill({ p }: { p: Product }) {
  const w = warrantyInfo(p);
  if (w.state === "none") return <Pill label="no warranty date" tone="dim" />;
  if (w.state === "expired") return <Pill label={`warranty ended ${Math.abs(w.daysLeft ?? 0)}d ago`} tone="red" />;
  if (w.state === "expiring") return <Pill label={`warranty ends in ${w.daysLeft}d`} tone="amber" />;
  return <Pill label={`warranty ${w.daysLeft}d left`} tone="green" />;
}

export function ThingsScreen({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const [items, setItems] = useState<Product[]>([]);
  const [brands, setBrands] = useState<BrandLife[]>([]);
  const load = () => {
    try {
      const a = asDbAdapter(db);
      setItems(listProducts(a)); setBrands(brandLifespans(a));
    } catch { setItems([]); }
  };
  useEffect(load, [db]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 22, paddingBottom: 40 }}>
        <Text style={text(28, C.text, "700")}>Things you own</Text>
        <Text style={[text(12, C.muted), { marginTop: 3, lineHeight: 18 }]}>
          Add an item from a payment photo. Pesanalysis keeps the warranty date and finds similar photos on this phone only.
        </Text>

        {items.length === 0 && (
          <Empty title="No tracked items yet" body="Open a payment, take or add a photo, then tap “Track this item”. The photo and details stay on this phone." />
        )}

        {items.map((p) => (
          <Card key={p.id} style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {p.uri ? (
                <Image source={{ uri: fileUri(p.uri) }} style={{ width: 78, height: 78, borderRadius: 12, backgroundColor: C.card2 }} contentFit="cover" />
              ) : (
                <View style={{ width: 78, height: 78, borderRadius: 12, backgroundColor: C.card2, alignItems: "center", justifyContent: "center" }}>
                  <Text style={text(22)}>▣</Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={text(15, C.text, "700")} numberOfLines={1}>{p.name}</Text>
                <Text style={text(11, C.muted)}>{[p.brand, p.model].filter(Boolean).join(" · ") || "No brand saved"}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
                  <WarrantyPill p={p} />
                  {p.priceCents != null && <Pill label={kes(p.priceCents)} tone="dim" />}
                </View>
              </View>
            </View>
            <Text style={[text(10, C.dim), { marginTop: 8 }]}>
              {p.boughtAt ? `Bought ${new Date(p.boughtAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "Bought date not set"}
              {p.warrantyEndsAt ? ` · warranty ends ${new Date(p.warrantyEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
            </Text>
            {p.notes ? <Text style={[text(11, C.muted), { marginTop: 4 }]}>{p.notes}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
              {p.imageHash && (
                <TouchableOpacity onPress={() => {
                  const m = matchProducts(asDbAdapter(db), p.imageHash!);
                  const others = m.filter((x) => x.product.id !== p.id);
                  Alert.alert("Similar photos on this phone", others.length ? others.map((x) => `${x.product.name}${x.product.brand ? ` (${x.product.brand})` : ""} · ${Math.round((1 - x.distance / 64) * 100)}% similar`).join("\n") : "No close match yet. Add another photo of the same kind of item.");
                }}><Text style={text(11, C.blue, "600")}>Find similar</Text></TouchableOpacity>
              )}
              {p.txId != null && <Text style={text(10, C.dim)}>linked to payment #{p.txId}</Text>}
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={() => {
                Alert.alert("Mark as retired?", `${p.name} stays in your history and counts toward the brand lifespan.`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Retire", onPress: () => { setProductStatus(asDbAdapter(db), p.id, "retired"); load(); onChanged(); } },
                  { text: "Delete", style: "destructive", onPress: () => { deleteProduct(asDbAdapter(db), p.id); load(); onChanged(); } },
                ]);
              }}><Text style={text(10, C.dim)}>retire / delete</Text></TouchableOpacity>
            </View>
          </Card>
        ))}

        {brands.length > 0 && (
          <>
            <SectionTitle>BRAND LIFESPANS</SectionTitle>
            <Card>
              <Text style={[text(11, C.muted), { lineHeight: 17 }]}>How long you have kept things you photographed, by brand. Retiring an item freezes its lifespan.</Text>
              {brands.map((b) => (
                <View key={b.brand} style={{ marginTop: 10 }}>
                  <View style={{ flexDirection: "row" }}>
                    <Text style={[text(13, C.text, "600"), { flex: 1 }]}>{b.brand}</Text>
                    <Text style={text(11, C.muted)}>{b.count} item{b.count === 1 ? "" : "s"} · avg {b.avgOwnedDays}d</Text>
                  </View>
                  <View style={{ height: 5, borderRadius: 3, backgroundColor: C.line, marginTop: 5, overflow: "hidden" }}>
                    <View style={{ width: `${Math.min(100, Math.max(4, (b.avgOwnedDays / Math.max(1, ...brands.map((x) => x.avgOwnedDays))) * 100))}%`, height: 5, backgroundColor: C.blue }} />
                  </View>
                  <Text style={[text(9, C.dim), { marginTop: 2 }]}>{b.active} still active · oldest {b.oldestDays}d</Text>
                </View>
              ))}
            </Card>
          </>
        )}

        <Text style={[text(10, C.dim), { marginTop: 18, textAlign: "center", lineHeight: 15 }]}>
          Visual matching uses a small fingerprint made on this phone. It is not an internet reverse-image search and no photo leaves the device.
        </Text>
      </ScrollView>
    </Screen>
  );
}
