import { useState } from "react";
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { PermissionsAndroid, Platform } from "react-native";
import { auditBalanceChain, formatKes, itemRollup, listAuditAlerts, listHabits, listSecurityAlerts, parseSms, securityAlertAuditGroups, suppressBalanceBreaks, type ParsedSms } from "@yako/core";
import { captureContextJson, captureFreshContextJson, queueSize, readInbox, resetCapture } from "../../modules/yako-sms";
import { drainDurable } from "../capture-queue";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { ingestInbox, ingestRows, type IngestStats } from "../ingest-inbox";
import { demoFeed } from "../demo-feed";
import { seedDemoLedger } from "../seed-demo";
import { pickBackupBytes, takeSafetySnapshot } from "../backup";
import { applyOpenedLabelPack, openLabelPack, type OpenedLabelPack } from "../label-pack";
import { resetLedger } from "../db/open";
import { loadFindings } from "../insights";
import { C, Screen, text } from "../ui";
import * as Notifications from "expo-notifications";
import { syncHabitNudges } from "../runtime/nudges";
import { CATEGORY, scheduleAt } from "../runtime/notifications";
import { nudgeHabits, nudgeSchedules } from "@yako/core";
import { runAiBenchmark } from "../ai/benchmark";

export function DiagnosticsScreen({ onDataChanged }: { onDataChanged: () => void }) {
  const [log, setLog] = useState<string[]>(["Diagnostics. Not part of the demo."]);
  const [packBytes, setPackBytes] = useState<Uint8Array | null>(null);
  const [packName, setPackName] = useState<string>("");
  const [packPass, setPackPass] = useState<string>("");
  const [packOpen, setPackOpen] = useState<OpenedLabelPack | null>(null);
  const say = (s: string) => setLog((l) => [...l.slice(-120), s]);
  const db = () => getLedger().db;

  const smsCoverage = async () => {
    try {
      if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
        const p = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_SMS);
        say(`sms permission: ${p}`);
      }
      const rows = await readInbox();
      say(`inbox: ${rows.length} rows`);
      const by = new Map<string, number>();
      let parsed = 0, unparsed = 0, notTx = 0;
      const bodies: string[] = [];
      const parsedList: ParsedSms[] = [];
      for (const r of rows) {
        const o = parseSms({ sender: r.sender, body: r.body, receivedAt: r.receivedAt });
        if (!o.ok) {
          if (o.reason === "no_template_match") { unparsed++; if (bodies.length < 3) bodies.push(r.body.slice(0, 120)); }
          else notTx++;
          continue;
        }
        by.set(o.parsed.template, (by.get(o.parsed.template) ?? 0) + 1);
        parsed++; parsedList.push(o.parsed);
      }
      say(`parsed ${parsed} unparsed ${unparsed} notTx ${notTx}`);
      for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) say(`  ${String(v).padStart(4)} ${k}`);
      for (const b of bodies) say(`  unparsed: ${b}`);
      const chain = auditBalanceChain(parsedList);
      say(`chain: ok ${chain.filter((c) => c.status === "ok").length} break ${chain.filter((c) => c.status === "break").length}`);
      if (parsedList[0]) say(`first: ${parsedList[0].template} ${formatKes(parsedList[0].amount)}`);
    } catch (e) { say(`ERR ${String(e)}`); }
  };

  const pickPack = async () => {
    try {
      const f = await pickBackupBytes();
      if (!f) return;
      setPackBytes(f.bytes); setPackName(f.name); setPackOpen(null);
      say(`label pack: picked ${f.name} (${f.bytes.length} bytes)`);
    } catch (e) { say(`label pack ERR ${String(e)}`); }
  };
  const previewPack = async () => {
    try {
      if (!packBytes) return say("pick a label pack first");
      const open = await openLabelPack(db(), packBytes, packPass);
      setPackOpen(open);
      const p = open.preview;
      say(`label pack dry-run: ${p.events} events, ${p.matched} matched, ${p.notFound} not found, +${p.labelsToCreate} labels, ${p.items} items, ${p.fundingLinks} funding links`);
    } catch (e) { say(`label pack ERR ${e instanceof Error ? e.message : String(e)}`); }
  };
  const applyPack = () => {
    try {
      if (!packOpen) return say("preview the pack first");
      const r = applyOpenedLabelPack(db(), packOpen.pack);
      say(`label pack applied: ${r.applied} payments, ${r.items} items, ${r.notes} notes, ${r.labelsCreated} labels, ${r.conflicts} replaced labels`);
      setPackOpen(null); setPackBytes(null); setPackPass("");
      onDataChanged();
    } catch (e) { say(`label pack ERR ${e instanceof Error ? e.message : String(e)}`); }
  };

  const itemsAudit = () => {
    try {
      const now = Date.now();
      const rows = itemRollup(asDbAdapter(db()), now - 90 * 86_400_000, now + 1);
      const pending = db().getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM tx_items WHERE confirmed_at IS NULL`)?.n ?? 0;
      say(`items: ${rows.length} rollup rows, ${pending} unconfirmed`);
      for (const r of rows.slice(0, 10)) say(`  ${r.level} ${r.name} ${formatKes(r.totalCents)} ${r.labelName ?? "—"}`);
    } catch (e) { say(`items ERR ${String(e)}`); }
  };
  const securityAudit = () => {
    try {
      const a = asDbAdapter(db());
      const r = suppressBalanceBreaks(a);
      const groups = securityAlertAuditGroups(a);
      say(`security: suppressed ${r.suppressed}; prominent ${listSecurityAlerts(a, 50, false).length}; audit ${listAuditAlerts(a, 50).length}`);
      for (const g of groups) say(`  audit ${g.reason}: ${g.count}`);
      const breaks = db().getAllSync<{ d: number; n: number }>(`SELECT ABS(CAST(json_extract(evidence_json,'$.discrepancy') AS INTEGER)) AS d, COUNT(*) AS n
        FROM security_alerts WHERE kind='balance_break' AND resolved_at IS NULL AND COALESCE(visibility,'prominent')='prominent'
        GROUP BY d ORDER BY n DESC LIMIT 8`);
      for (const b of breaks) say(`  break Ksh${(b.d / 100).toFixed(2)}: ${b.n}`);
      for (const x of listSecurityAlerts(a, 8, true)) say(`  ${x.visibility} ${x.kind} ${x.suppressedReason ?? ""} ${x.title}`);
    } catch (e) { say(`security ERR ${String(e)}`); }
  };
  const habitsAudit = () => {
    try {
      const rows = listHabits(asDbAdapter(db()), "all");
      say(`habits: ${rows.length}`);
      for (const h of rows) say(`  ${h.name} ${h.direction} labels=${(h.selector.labels ?? []).join(",")} words=${(h.selector.words ?? []).slice(0, 3).join(",")}`);
    } catch (e) { say(`habits ERR ${String(e)}`); }
  };

  const openDb = () => {
    try {
      const l = getLedger();
      const n = (t: string) => l.db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0;
      say(`ledger | cipher=${l.cipherVersion ?? "OFF"} | sms=${n("sms_raw")} tx=${n("transactions")} labels=${n("labels")}`);
    } catch (e) { say(`ledger ERR ${String(e)}`); }
  };

  const captureTest = async () => {
    try {
      const ctx = JSON.parse(await captureContextJson()) as Record<string, unknown>;
      const lat = typeof ctx.lat === "number" ? ctx.lat.toFixed(4) : null;
      const lng = typeof ctx.lng === "number" ? ctx.lng.toFixed(4) : null;
      say(`context self-test: ${lat != null ? `${lat},${lng} ±${Math.round(Number(ctx.accuracy ?? 0))}m` : "no passive fix available"} · battery ${ctx.batteryPct ?? "—"}%${ctx.isCharging ? " charging" : ""}${ctx.calendarTitle ? ` · calendar ${String(ctx.calendarTitle).slice(0, 60)}` : ""}`);
      say(`  source is the same ContextCapture used by SmsReceiver; location needs an OS fix within 30 min.`);
    } catch (e) { say(`context self-test ERR ${String(e)}`); }
  };

  const freshFix = async () => {
    try {
      say("fresh fix: asking the OS (up to ~20s per provider)…");
      const ctx = JSON.parse(await captureFreshContextJson()) as Record<string, unknown>;
      say(`fresh fix: kind=${String(ctx.fixKind ?? "—")} provider=${String(ctx.provider ?? "—")} latency=${ctx.fixLatencyMs ?? "—"}ms ${typeof ctx.lat === "number" ? `accuracy=${Math.round(Number(ctx.accuracy ?? 0))}m` : ""}`);
      if (typeof ctx.ageMs === "number") say(`  last-known age ${Math.round(Number(ctx.ageMs) / 60000)} min`);
    } catch (e) { say(`fresh fix ERR ${String(e).slice(0, 120)}`); }
  };

  const contexts = () => {
    try {
      const rows = db().getAllSync<{ txId: number; fixKind: string | null; provider: string | null; accuracy: number | null; latency: number | null; age: number | null; at: number | null }>(
        `SELECT tx_id AS txId, fix_kind AS fixKind, provider, accuracy_m AS accuracy, fix_latency_ms AS latency, age_ms AS age, captured_at AS at
           FROM tx_context ORDER BY captured_at DESC LIMIT 10`,
      );
      if (!rows.length) { say("no contexts captured yet"); return; }
      for (const r of rows) say(`ctx tx#${r.txId} · ${r.fixKind ?? "—"} · ${r.provider ?? "—"} · ±${r.accuracy == null ? "—" : Math.round(r.accuracy)}m · ${r.latency ?? "—"}ms · age ${r.age == null ? "—" : Math.round(r.age / 1000) + "s"}`);
    } catch (e) { say(`contexts ERR ${String(e).slice(0, 120)}`); }
  };

  const ingest = async () => {
    try {
      say("ingest: reading inbox…");
      const stats: IngestStats = await ingestInbox(db());
      say(`ingest ${stats.ms}ms | read ${stats.read} stored ${stats.stored} skipped ${stats.skipped}`);
      say(`chain ok ${stats.chainOk} break ${stats.chainBreak} first ${stats.chainFirst} unknown ${stats.chainUnknown}`);
      say(`notify ask ${stats.ask} auto ${stats.auto} silent ${stats.silent}`);
      for (const a of stats.recent.slice(0, 4)) say(`· ${a.title}`);
      onDataChanged();
    } catch (e) { say(`ingest ERR ${String(e)}`); }
  };

  const detect = () => {
    try {
      const { txCount, findings } = loadFindings(db());
      say(`detectors over ${txCount} txs → ${findings.length} findings`);
      for (const f of findings.slice(0, 6)) say(`· [${f.detector}] ${f.title}`);
    } catch (e) { say(`detect ERR ${String(e)}`); }
  };

  const captureAudit = () => {
    try {
      const d = db();
      const one = (sql: string) => Number(d.getFirstSync<{ n: number }>(sql)?.n ?? 0);
      const sms = one(`SELECT COUNT(*) AS n FROM sms_raw`);
      const tx = one(`SELECT COUNT(*) AS n FROM tx_events`);
      const pending = one(`SELECT COUNT(*) AS n FROM tx_events WHERE status = 'pending'`);
      const confirmed = one(`SELECT COUNT(*) AS n FROM tx_events t WHERE EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.tx_id=t.id AND tl.confirmed_at IS NOT NULL)`);
      const withCtx = one(`SELECT COUNT(*) AS n FROM tx_events t JOIN tx_context c ON c.tx_id=t.id`);
      const withLoc = one(`SELECT COUNT(*) AS n FROM tx_events t JOIN tx_context c ON c.tx_id=t.id WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL`);
      const latestSms = d.getFirstSync<{ at: number; sender: string }>(`SELECT received_at AS at, sender FROM sms_raw ORDER BY received_at DESC LIMIT 1`);
      say(`live: ${sms} messages · ${tx} events · ${confirmed} confirmed · ${pending} pending`);
      say(`context: ${withCtx}/${tx} have a snapshot · ${withLoc} have a location${latestSms ? ` · latest SMS ${new Date(latestSms.at + 3*3600000).toISOString().slice(0,16)} ${latestSms.sender}` : ""}`);
      const rows = d.getAllSync<{
        at: number; amount: number; direction: string; kind: string; ref: string | null; status: string;
        label: string | null; lat: number | null; lng: number | null; accuracy: number | null;
        source: string | null; battery: number | null; calendar: string | null; attachments: number;
      }>(`SELECT t.occurred_at AS at, t.amount, t.direction, t.kind, t.ref, t.status, l.name AS label,
                 c.lat, c.lng, c.accuracy_m AS accuracy, c.source, c.battery_pct AS battery,
                 c.calendar_title AS calendar,
                 (SELECT COUNT(*) FROM attachments a WHERE a.tx_id=t.id) AS attachments
            FROM tx_events t
            LEFT JOIN tx_labels tl ON tl.rowid = (SELECT x.rowid FROM tx_labels x WHERE x.tx_id=t.id
              ORDER BY (x.confirmed_at IS NOT NULL) DESC, x.confidence DESC LIMIT 1)
            LEFT JOIN labels l ON l.id=tl.label_id
            LEFT JOIN tx_context c ON c.tx_id=t.id
           ORDER BY t.occurred_at DESC LIMIT 8`);
      for (const r of rows) {
        const dt = new Date(r.at + 3*3600000).toISOString().replace("T", " ").slice(0,16);
        const where = r.lat != null ? ` · ${r.lat.toFixed(4)},${r.lng!.toFixed(4)} ±${Math.round(r.accuracy ?? 0)}m` : "";
        say(`${dt} ${r.direction} ${(r.amount/100).toFixed(2)} ${r.kind} · ${r.label ?? r.status}${where}${r.attachments ? ` · ${r.attachments} media` : ""}`);
        say(`  ref ${r.ref ?? "—"} · ctx ${r.source ?? "none"} · battery ${r.battery ?? "—"}${r.calendar ? ` · calendar ${r.calendar}` : ""}`);
      }
    } catch (e) { say(`audit ERR ${String(e)}`); }
  };

  const replay = () => {
    try {
      const s = ingestRows(db(), demoFeed());
      say(`demo feed: read ${s.read} stored ${s.stored} ask ${s.ask} auto ${s.auto} chain-ok ${s.chainOk} break ${s.chainBreak}`);
      onDataChanged();
    } catch (e) { say(`replay ERR ${String(e)}`); }
  };

  const wipe = () => {
    try {
      void takeSafetySnapshot(db(), "pre-reset").then(() => {
        resetLedger(db());
        void resetCapture(Date.now());
        say("ledger reset (safety snapshot kept; More > Undo)");
        onDataChanged();
      }).catch((e) => say(`reset ERR ${String(e)}`));
    } catch (e) { say(`reset ERR ${String(e)}`); }
  };

  const seedDemo = () => {
    Alert.alert(
      "Replace ledger with synthetic demo data?",
      "This wipes the current ledger, learned words and media rows, then installs 180 days of invented boda-rider messages. Real SMS stay in the phone inbox and can be re-ingested later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Seed demo", style: "destructive", onPress: () => {
            void (async () => {
              try {
                const snap = await takeSafetySnapshot(db(), "pre-seed"); // aborts the seed if it cannot be written
                const s = await seedDemoLedger(db());
                say(`demo: ${s.messages} messages, ${s.stored} stored, ${s.labelled} labelled, ${s.pending} left for Review in ${s.ms}ms`);
                say(`safety snapshot: ${snap.name} (More > Undo)`);
                if (s.nightlyError) say(`demo nightly: ${s.nightlyError}`);
                onDataChanged();
              } catch (e) { say(`seed ERR ${String(e)}`); }
            })();
          },
        },
      ],
    );
  };

  const drain = async () => {
    try {
      say(`queue: ${await queueSize()} pending SMS`);
      const s = await drainDurable(db());
      if (s) {
        say(`queued → read ${s.read} stored ${s.stored} ask ${s.ask} auto ${s.auto}`);
        onDataChanged();
      }
    } catch (e) { say(`drain ERR ${String(e)}`); }
  };

  const run = (name: string, f: () => Promise<unknown>) => async () => {
    try { say(`${name}...`); say(`${name}: ${JSON.stringify(await f())}`); }
    catch (e) { say(`${name} ERR ${String(e)}`); }
  };

  const pingWorker = run("worker ping", async () => {
    const q = await import("../qvac");
    return q.ping();
  });
  const models = async () => {
    const q = await import("../qvac");
    say(`cached: ${q.listCachedModels().map((f) => `${f.name} ${Math.round(f.size / 1e6)}MB`).join(", ") || "none"}`);
    say(`crash state: ${JSON.stringify(q.crashState())} · loaded: ${q.loadedModels().map((m) => m.key).join(",") || "none"}`);
  };
  const fetchQwen = run("download Qwen3-0.6B", async () => {
    const q = await import("../qvac");
    return q.fetchModel(q.MODELS.qwen3_06b, (pct) => say(`download ${Math.round(pct)}%`));
  });
  const narrateTest = run("narrate", async () => {
    const { narrateOffline } = await import("../narrate");
    const f = { detector: "test", id: "t", title: "You borrowed KES 1,200 and repaid KES 1,250 across 3 payments this week.", severity: 1, evidence: {} } as never;
    return narrateOffline(f);
  });
  const fetchModel = (key: keyof typeof import("../qvac").MODELS) => async () => {
    const q = await import("../qvac");
    say(`download ${q.MODELS[key].file} (${Math.round(q.MODELS[key].size / 1e6)}MB)…`);
    return q.fetchModel(q.MODELS[key], (pct) => { if (Math.round(pct) % 10 === 0) say(`download ${Math.round(pct)}%`); });
  };
  const runWorker = run("model help: process queued SMS", async () => {
    const { processModelCandidates } = await import("../ai/sms-worker");
    return processModelCandidates(db(), 5);
  });
  const nudgeTest = run("Test habit nudge in 10s", async () => {
    await scheduleAt({
      id: "nudge:test:soon", channel: "alerts", title: "Late-night food",
      body: "It's a test. Check in on Late-night food?",
      data: { v: 1, kind: "habit_nudge", habitId: 1, url: "yako://plan/habits" }, category: CATEGORY.habit,
    }, Date.now() + 10_000);
    say("test nudge scheduled in 10s (id nudge:test:soon)");
  });
  const nudgeDebug = run("Habit nudges: sync + next fire", async () => {
    const hs = nudgeHabits(asDbAdapter(db()));
    say(`nudge habits: ${hs.length}${hs.length ? ` · ${hs.map((h) => `${h.name} ${JSON.stringify(h.nudge)}`).join(" | ")}` : ""}`);
    const plans = nudgeSchedules(hs);
    say(`nudge plans: ${plans.length}`);
    const r = await syncHabitNudges(db());
    say(`nudge sync: scheduled=${r.scheduled} cancelled=${r.cancelled}`);
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const ours = all.filter((n) => n.identifier.startsWith("nudge:"));
    for (const n of ours.slice(0, 20)) {
      let next: number | null = null;
      try { next = await Notifications.getNextTriggerDateAsync(n.trigger as never); } catch { next = null; }
      say(`  ${n.identifier} trigger=${JSON.stringify(n.trigger)} next=${next ? new Date(next).toLocaleString("en-GB") : "—"}`);
    }
    if (!ours.length) say("  no scheduled nudge notifications");
    return r;
  });
  const aiBenchmark = run("AI benchmark (offline)", async () => {
    const r = await runAiBenchmark(db(), 5);
    for (const row of r.rows) say(`${row.job}: n=${row.n} p50=${row.p50Ms ?? "—"}ms p95=${row.p95Ms ?? "—"}ms pass=${row.passRate == null ? "—" : `${Math.round(row.passRate * 100)}%`} ${row.note ?? ""}`);
    say(`benchmark file: ${r.file ?? "could not write"}`);
    return r;
  });
  const coRes = run("load all cached models", async () => {
    const q = await import("../qvac");
    const out: Record<string, unknown> = {};
    for (const k of ["qwen3_06b", "laya_ml_322m", "afri_08b_q4", "ocr_latin"]) {
      const spec = q.MODELS[k];
      if (!spec || !q.localPath(spec)) { out[k] = "not cached"; continue; }
      try { out[k] = (await q.loadLocal(spec)).loadMs; } catch (e) { out[k] = String(e).slice(0, 80); }
    }
    return out;
  });
  const buttons: Array<[string, () => void]> = [
    ["Models: worker ping", () => void pingWorker()],
    ["Models: cached + crash state", () => void models()],
    ["Models: download Qwen3-0.6B (needs network)", () => void fetchQwen()],
    ["Models: narration test (offline)", () => void narrateTest()],
    ["Models: load every cached model together", () => void coRes()],
    ["Models: download Laya 322M (needs network)", () => void run("download Laya", fetchModel("laya_ml_322m"))()],
    ["Models: download AfriSLM 0.8B Q4 (needs network)", () => void run("download AfriSLM", fetchModel("afri_08b_q4"))()],
    ["Models: download OCR latin + detector (needs network)", () => void (async () => { await run("download OCR latin", fetchModel("ocr_latin"))(); await run("download OCR detector", fetchModel("ocr_craft"))(); })()],
    ["AI benchmark (offline; uses installed models)", () => void aiBenchmark()],
    ["Habit nudges: sync + next fire", () => void nudgeDebug()],
    ["Test habit nudge in 10s", () => void nudgeTest()],
    ["Model help: process queued SMS", () => void runWorker()],
    ["SMS permission + parser coverage", smsCoverage],
    ["Live capture audit (latest 8)", captureAudit],
    ["Test passive context capture", captureTest],
    ["Test FRESH location fix (network/GPS)", () => void freshFix()],
    ["Last 10 captured contexts", contexts],
    ["Ingest inbox → ledger", ingest],
    ["Drain native queue", drain],
    ["Ledger: open + migrate (SQLCipher)", openDb],
    ["Items: rollups (90 days)", itemsAudit],
    ["Habits: selectors", habitsAudit],
    ["Security: classify breaks + audit counts", securityAudit],
    ["Run detectors", detect],
    ["Replay synthetic feed (12 messages)", replay],
    ["Seed demo ledger (synthetic 180 days)", seedDemo],
    ["Reset ledger", wipe],
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 28, paddingBottom: 32 }}>
        <Text style={text(28, C.text, "700")}>Diagnostics</Text>
        <Text style={[text(13, C.muted), { marginTop: 3 }]}>For development. Not part of the demo.</Text>

        <View style={{ marginTop: 18, gap: 8 }}>
          {buttons.map(([t, f]) => (
            <TouchableOpacity key={t} onPress={f} style={{ backgroundColor: C.card, borderRadius: 12, padding: 12 }}>
              <Text style={text(13, C.text)}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ marginTop: 18, backgroundColor: C.card, borderRadius: 12, padding: 12, gap: 8 }}>
          <Text style={text(13, C.text, "600")}>Gold label pack (encrypted)</Text>
          <TextInput value={packPass} onChangeText={setPackPass} placeholder="Pack passphrase" placeholderTextColor={C.dim} secureTextEntry
            style={{ backgroundColor: C.bg, color: C.text, borderRadius: 8, padding: 10 }} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={() => void pickPack()} style={{ backgroundColor: C.bg, borderRadius: 8, padding: 10 }}>
              <Text style={text(12, C.text)}>Pick .pesapack</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void previewPack()} style={{ backgroundColor: C.bg, borderRadius: 8, padding: 10 }}>
              <Text style={text(12, C.text)}>Preview</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={applyPack} style={{ backgroundColor: packOpen ? C.green : C.bg, borderRadius: 8, padding: 10 }}>
              <Text style={text(12, packOpen ? C.bg : C.dim)}>Apply</Text>
            </TouchableOpacity>
          </View>
          <Text style={text(10, C.dim)}>{packName || "No pack picked"}{packOpen ? ` · ${packOpen.preview.matched}/${packOpen.preview.events} matched` : ""}</Text>
        </View>

        <View style={{ marginTop: 18, backgroundColor: C.card, borderRadius: 12, padding: 12 }}>
          {log.map((l, i) => (
            <Text key={i} style={{ color: C.muted, fontFamily: "monospace", fontSize: 11, marginBottom: 3 }}>{l}</Text>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}
