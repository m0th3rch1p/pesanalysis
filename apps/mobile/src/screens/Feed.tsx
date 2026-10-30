import { useEffect, useMemo, useState } from "react";
import {
  Alert, ScrollView, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import type { ParsedSearch, SearchHit } from "@yako/core";
import { listTags, parseSearch, searchTransactions } from "@yako/core";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { dayKey, dayLabel, timeLabel, whenLabel } from "../queries";
import { fileUri } from "../media";
import { TxDetail } from "../components/TxDetail";
import { C, Empty, Pill, Screen, kes, text } from "../ui";
import { removeChip, serializeSearch } from "../search-query";
import { exportCsv, shareFile } from "../backup";

type FeedTab = "for_you" | "latest" | "needs_you";
type SortKey = "date" | "amount" | "cp";
interface SavedView { name: string; query: string; mode: "feed" | "table"; sort: SortKey; createdAt: number }
type FeedItem = { kind: "day"; key: string; label: string } | { kind: "tx"; key: string; row: SearchHit };

function amountColor(direction: string): string {
  return direction === "in" ? C.green : C.text;
}

function Avatar({ row }: { row: SearchHit }) {
  if (row.thumbUri) {
    return (
      <View style={{ width: 46, height: 46, borderRadius: 23, overflow: "hidden", backgroundColor: C.card2 }}>
        <Image source={{ uri: fileUri(row.thumbUri) }} style={{ width: 46, height: 46 }} contentFit="cover" />
        {row.thumbKind === "video" && (
          <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.28)" }}>
            <Text style={text(14, "#fff", "700")}>▶</Text>
          </View>
        )}
      </View>
    );
  }
  const initial = (row.cpName ?? row.label ?? row.kind ?? "?").trim().charAt(0).toUpperCase();
  return (
    <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: row.direction === "in" ? "#12331D" : C.card2, alignItems: "center", justifyContent: "center" }}>
      <Text style={text(17, row.direction === "in" ? C.green : C.muted, "700")}>{initial}</Text>
    </View>
  );
}

function FeedCard({ row, onPress }: { row: SearchHit; onPress: () => void }) {
  const name = row.cpName ?? row.kind.replace(/_/g, " ");
  const pending = row.status === "pending";
  const bundle = row.bundleId != null && row.bundleHiddenFeeCents != null;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82} style={{ marginBottom: 12 }} accessibilityRole="button" accessibilityLabel={`${row.direction === "out" ? "Paid" : "Received"} ${kes(row.amount)} ${row.direction === "out" ? "to" : "from"} ${name}. ${pending ? "Needs a label" : row.label ? `Filed as ${row.label}` : ""}. ${whenLabel(row.occurredAt)}`}>
      <View accessible={false} style={{
        backgroundColor: C.card, borderRadius: 18, padding: 14,
        borderLeftWidth: pending ? 3 : 0, borderLeftColor: C.amber,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Avatar row={row} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={text(14, C.text, "700")} numberOfLines={1}>{name}</Text>
            <Text style={text(10, C.dim)} numberOfLines={1}>
              {whenLabel(row.occurredAt)} · {pending ? row.label ? `likely ${row.label} · confirm?` : "needs your label" : row.label ? `filed as ${row.label}` : row.kind.replace(/_/g, " ")}
              {row.cpCount > 2 ? ` · ${row.cpCount} payments` : ""}
            </Text>
          </View>
          <Text style={[text(16, amountColor(row.direction), "700")]}>{row.direction === "out" ? "−" : "+"}{kes(row.amount)}</Text>
        </View>

        <Text style={[text(13, C.muted), { marginTop: 10, lineHeight: 18 }]}>
          {row.note
            ? row.note
            : row.direction === "in"
              ? `Money arrived from ${name}.`
              : bundle
                ? `${kes(row.bundlePaidCents ?? row.amount)} bought ${kes(row.bundleReceivedCents ?? 0)} of airtime.`
                : `You paid ${name}. Tap to add the story behind it.`}
        </Text>

        <View style={{ flexDirection: "row", gap: 6, marginTop: 9, flexWrap: "wrap", alignItems: "center" }}>
          {bundle && <Pill label={`${kes(row.bundleHiddenFeeCents ?? 0)} withheld`} tone="amber" />}
          {row.label ? <Pill label={pending ? `likely ${row.label}` : row.label} tone={pending ? "amber" : "blue"} /> : pending ? <Pill label="needs name" tone="amber" /> : null}
          {row.tags ? <Text style={text(10, C.dim)} numberOfLines={1}>#{row.tags.split(",")[0]!.trim()}</Text> : null}
          {row.attachments > 0 && <Text style={text(10, C.dim)}>📎 {row.attachments}</Text>}
          <View style={{ flex: 1 }} />
          <Text style={text(10, C.blue, "600")}>{pending ? "Label ›" : "Add detail ›"}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function TableView({ rows, onSelect, sort, onSort }: { rows: SearchHit[]; onSelect: (id: number) => void; sort: SortKey; onSort: (s: SortKey) => void }) {
  const head = (label: string, key: SortKey, style: object) => (
    <TouchableOpacity onPress={() => onSort(key)} style={[style, { minHeight: 44, justifyContent: "center" }]} accessibilityRole="button" accessibilityLabel={`Sort by ${label.toLowerCase()}`} accessibilityState={{ selected: sort === key }}>
      <Text style={text(10, sort === key ? C.blue : C.dim, "700")}>{label}{sort === key ? " ↓" : ""}</Text>
    </TouchableOpacity>
  );
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
      <View style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
        {head("DATE", "date", { width: 62 })}
        {head("COUNTERPARTY", "cp", { flex: 1 })}
        <Text style={[text(10, C.dim, "700"), { width: 92 }]}>CATEGORY</Text>
        {head("AMOUNT", "amount", { width: 82, alignItems: "flex-end" })}
      </View>
      {rows.map((r) => {
        const d = new Date(r.occurredAt + 3 * 3_600_000);
        return (
          <TouchableOpacity key={r.id} onPress={() => onSelect(r.id)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${r.direction === "out" ? "Paid" : "Received"} ${kes(r.amount)} ${r.direction === "out" ? "to" : "from"} ${r.cpName ?? r.kind} on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`} style={{ flexDirection: "row", alignItems: "center", minHeight: 48, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View style={{ width: 62 }}>
              <Text style={text(10, C.muted)}>{d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Text>
              <Text style={text(9, C.dim)}>{timeLabel(r.occurredAt)}</Text>
            </View>
            <Text style={[text(12, C.text, "600"), { flex: 1, paddingRight: 6 }]} numberOfLines={1}>{r.cpName ?? r.kind.replace(/_/g, " ")}</Text>
            <Text style={[text(10, r.label ? (r.status === "pending" ? C.amber : C.muted) : C.amber), { width: 92 }]} numberOfLines={1}>
              {r.label ? (r.status === "pending" ? `likely ${r.label}` : r.label) : r.status === "pending" ? "needs name" : "—"}
            </Text>
            <Text style={[text(12, amountColor(r.direction), "700"), { width: 82, textAlign: "right" }]}>{r.direction === "out" ? "−" : "+"}{kes(r.amount)}</Text>
          </TouchableOpacity>
        );
      })}
      {rows.length === 0 && <Empty title="No matching rows" body="Try a wider period, a category, or a tag." />}
    </ScrollView>
  );
}

function feedScore(row: SearchHit, now: number): number {
  const ageDays = Math.max(0, (now - row.occurredAt) / 86_400_000);
  const recency = Math.exp(-ageDays / 9);
  const pending = row.status === "pending" && !row.label ? 0.85 : 0;
  const media = Math.min(0.35, row.attachments * 0.18);
  const repetition = Math.min(0.35, Math.log2(1 + row.cpCount) / 12);
  const amount = Math.min(0.25, Math.log10(1 + row.amount / 100) / 16);
  const bundle = row.bundleId != null ? 0.12 : 0;
  return recency + pending + media + repetition + amount + bundle;
}

export function FeedScreen({ refreshKey, focusTx, onFocused }: { refreshKey: number; focusTx?: number | null; onFocused?: () => void }) {
  const [rows, setRows] = useState<SearchHit[]>([]);
  const [tableRows, setTableRows] = useState<SearchHit[]>([]);
  const [tableQuery, setTableQuery] = useState("");
  const [parsed, setParsed] = useState<ParsedSearch>({ filters: {}, fts: "", chips: [] });
  const [mode, setMode] = useState<"feed" | "table">("feed");
  const [feedTab, setFeedTab] = useState<FeedTab>("for_you");
  const [sort, setSort] = useState<SortKey>("date");
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => { if (focusTx != null) { setSelected(focusTx); onFocused?.(); } }, [focusTx]);
  const [refreshing, setRefreshing] = useState(false);
  const [local, setLocal] = useState(0);

  useEffect(() => {
    try {
      const db = getLedger().db;
      const m = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key='feed_mode'`)?.value;
      const f = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key='feed_tab'`)?.value;
      const s = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key='table_sort'`)?.value;
      const v = db.getFirstSync<{ value: string }>(`SELECT value FROM meta WHERE key='saved_views'`)?.value;
      if (m === "table" || m === "feed") setMode(m);
      if (f === "for_you" || f === "latest" || f === "needs_you") setFeedTab(f);
      if (s === "date" || s === "amount" || s === "cp") setSort(s);
      if (v) setViews(JSON.parse(v) as SavedView[]);
    } catch { /* defaults */ }
  }, []);

  const persist = (key: string, value: string) => {
    try { getLedger().db.runSync(`INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]); } catch { /* non-fatal */ }
  };

  const setView = (m: "feed" | "table") => { setMode(m); persist("feed_mode", m); };
  const setTab = (t: FeedTab) => { setFeedTab(t); persist("feed_tab", t); };
  const setSorted = (s: SortKey) => { setSort(s); persist("table_sort", s); };

  const vocab = useMemo(() => {
    try { return { tags: listTags(asDbAdapter(getLedger().db)).map((t) => t.name) }; } catch { return { tags: [] as string[] }; }
  }, [refreshKey, local]);

  // The social feed is intentionally not filtered by the table query.
  useEffect(() => {
    try { setRows(searchTransactions(asDbAdapter(getLedger().db), { filters: {}, fts: "", chips: [] }, Date.now(), 1000)); }
    catch { setRows([]); }
  }, [refreshKey, local]);

  // Table search is a separate surface with its own query/state.
  useEffect(() => {
    const t = setTimeout(() => {
      if (mode !== "table") return;
      try {
        const p = tableQuery.trim() ? parseSearch(tableQuery, Date.now(), vocab) : { filters: {}, fts: "", chips: [] } as ParsedSearch;
        setParsed(p);
        setTableRows(searchTransactions(asDbAdapter(getLedger().db), p, Date.now(), 1000));
      } catch { setTableRows([]); }
    }, 160);
    return () => clearTimeout(t);
  }, [tableQuery, refreshKey, local, vocab, mode]);

  const sortedRows = useMemo(() => {
    const r = [...tableRows];
    if (sort === "amount") r.sort((a, b) => b.amount - a.amount);
    else if (sort === "cp") r.sort((a, b) => (a.cpName ?? "").localeCompare(b.cpName ?? ""));
    else r.sort((a, b) => b.occurredAt - a.occurredAt);
    return r;
  }, [tableRows, sort]);

  const ranked = useMemo(() => {
    const now = Date.now();
    const r = [...rows];
    if (feedTab === "needs_you") return r.filter((x) => x.status === "pending").sort((a, b) => feedScore(b, now) - feedScore(a, now));
    if (feedTab === "latest") return r.sort((a, b) => b.occurredAt - a.occurredAt);
    return r.sort((a, b) => feedScore(b, now) - feedScore(a, now));
  }, [rows, feedTab]);

  const items = useMemo<FeedItem[]>(() => {
    if (feedTab !== "latest") return ranked.map((row) => ({ kind: "tx" as const, key: `t-${row.id}`, row }));
    const out: FeedItem[] = [];
    let last = "";
    for (const r of ranked) {
      const k = dayKey(r.occurredAt);
      if (k !== last) { out.push({ kind: "day", key: `d-${k}`, label: dayLabel(r.occurredAt) }); last = k; }
      out.push({ kind: "tx", key: `t-${r.id}`, row: r });
    }
    return out;
  }, [ranked, feedTab]);

  const today = useMemo(() => {
    const k = dayKey(Date.now());
    let net = 0, count = 0;
    for (const r of rows) {
      if (dayKey(r.occurredAt) !== k) continue;
      count++;
      net += r.direction === "in" ? r.amount : r.direction === "out" ? -r.amount : 0;
    }
    return { net, count, pending: rows.filter((r) => r.status === "pending").length };
  }, [rows]);

  const refresh = () => {
    setRefreshing(true);
    setLocal((n) => n + 1);
    setTimeout(() => setRefreshing(false), 350);
  };

  const remove = (id: string) => {
    const next = removeChip(parsed, id);
    setParsed(next);
    setTableQuery(serializeSearch(next));
  };

  const open = (id: number) => setSelected(id);

  return (
    <Screen>
      <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text accessibilityRole="header" style={text(30, C.text, "700")}>{mode === "feed" ? "Feed" : "Table"}</Text>
          <Text style={[text(12, C.muted), { marginLeft: 8 }]}>{mode === "feed" ? `${ranked.length} moments` : `${sortedRows.length} rows`}</Text>
          <View style={{ flex: 1 }} />
          {mode === "table" ? (
            <>
              <TouchableOpacity onPress={() => { try { void shareFile(exportCsv(sortedRows, getLedger().db), "text/csv", "Pesanalysis CSV"); } catch (e) { Alert.alert("Export failed", String(e).slice(0, 160)); } }} style={{ marginRight: 12, minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Export table as CSV">
                <Text style={text(12, C.blue, "600")}>CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setView("feed")} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button"><Text style={text(12, C.blue, "600")}>Feed</Text></TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => setView("table")} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button"><Text style={text(12, C.blue, "600")}>Search / table</Text></TouchableOpacity>
          )}
        </View>

        {mode === "feed" ? (
          <>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
              {([["for_you", "Moments"], ["latest", "Latest"], ["needs_you", "Needs you"]] as Array<[FeedTab, string]>).map(([id, label]) => (
                <TouchableOpacity key={id} onPress={() => setTab(id)} activeOpacity={0.75} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="tab" accessibilityState={{ selected: feedTab === id }}>
                  <Pill label={label} tone={feedTab === id ? "blue" : "dim"} />
                </TouchableOpacity>
              ))}
            </View>
            {feedTab === "for_you" && (
              <View style={{ backgroundColor: "#111B33", borderRadius: 18, padding: 15, marginTop: 12, borderWidth: 1, borderColor: "#20345C" }}>
                <Text style={text(9, C.blue, "700")}>MOMENTS · TODAY</Text>
                <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: 5 }}>
                  <Text style={[text(25, today.net >= 0 ? C.green : C.red, "700")]}>{today.net >= 0 ? "+" : "−"}{kes(Math.abs(today.net))}</Text>
                  <Text style={[text(10, C.dim), { marginLeft: 8, marginBottom: 4 }]}>{today.count} payment{today.count === 1 ? "" : "s"} today</Text>
                </View>
                <Text style={[text(11, C.muted), { marginTop: 5, lineHeight: 16 }]}>
                  {today.pending > 0
                    ? `${today.pending} payment${today.pending === 1 ? "" : "s"} still need a detail. Photos, a voice note or one word turn a payment into a memory the ledger can use.`
                    : "Your ledger is caught up. Keep living; new payments will appear here."}
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.card, borderRadius: 13, paddingHorizontal: 12, marginTop: 12 }}>
              <Text style={text(15, C.dim)}>⌕</Text>
              <TextInput
                value={tableQuery} onChangeText={setTableQuery}
                placeholder='Search notes, shops, tags, >500, "last week"'
                placeholderTextColor={C.dim}
                style={[text(13, C.text), { flex: 1, paddingVertical: 11, paddingHorizontal: 8 }]}
                autoCapitalize="none" autoCorrect={false} returnKeyType="search" accessibilityLabel="Search transactions"
              />
              {tableQuery.length > 0 && <TouchableOpacity onPress={() => setTableQuery("")} style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Clear search"><Text style={text(13, C.dim)}>✕</Text></TouchableOpacity>}
            </View>
            {views.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
                {views.map((v) => (
                  <TouchableOpacity key={`${v.name}-${v.createdAt}`} onPress={() => { setTableQuery(v.query); setSorted(v.sort); }} onLongPress={() => {
                    Alert.alert("Delete view?", v.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => {
                      const next = views.filter((x) => x.createdAt !== v.createdAt);
                      setViews(next); persist("saved_views", JSON.stringify(next));
                    } }]);
                  }}>
                    <Pill label={v.name} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            {parsed.chips.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
                {parsed.chips.map((chip) => (
                  <TouchableOpacity key={chip.id} onPress={() => remove(chip.id)} activeOpacity={0.7}>
                    <Pill label={`${chip.label} ×`} tone="blue" />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => setTableQuery("")}><Pill label="clear" /></TouchableOpacity>
                <TouchableOpacity onPress={() => {
                  const name = tableQuery.trim().slice(0, 32) || "View";
                  Alert.alert("Save view?", name, [{ text: "Cancel", style: "cancel" }, { text: "Save", onPress: () => {
                    const next = [...views.filter((x) => x.name !== name), { name, query: tableQuery, mode: "table" as const, sort, createdAt: Date.now() }].slice(-6);
                    setViews(next); persist("saved_views", JSON.stringify(next));
                  } }]);
                }}><Pill label="+ save" tone="blue" /></TouchableOpacity>
              </ScrollView>
            )}
          </>
        )}
      </View>

      {mode === "table" ? (
        <View style={{ flex: 1, paddingHorizontal: 20, marginTop: 12 }}>
          <TableView rows={sortedRows} onSelect={open} sort={sort} onSort={setSorted} />
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 }}
          onRefresh={refresh}
          refreshing={refreshing}
          renderItem={({ item }) => item.kind === "day" ? (
            <Text style={[text(11, C.muted, "700"), { marginTop: 18, marginBottom: 6 }]}>{item.label.toUpperCase()}</Text>
          ) : <FeedCard row={item.row} onPress={() => open(item.row.id)} />}
          ListEmptyComponent={<Empty title={feedTab === "needs_you" ? "Nothing waiting" : "No moments yet"} body={feedTab === "needs_you" ? "Every captured payment has a label." : "Incoming SMS payments appear here automatically. Add a note or photo to give one a story."} />}
        />
      )}

      {selected != null && (
        <TxDetail db={getLedger().db} txId={selected} onClose={() => setSelected(null)} onChanged={() => setLocal((n) => n + 1)} />
      )}
    </Screen>
  );
}
