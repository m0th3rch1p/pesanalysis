import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  debtSummary, fulizaState, generateQuestions, getProfile, listSecurityAlerts, narrateFinding, offRadarSummary,
  pendingQuestions, plainDetector, plainTerms, runAllAnalyses, setFindingState,
  type AnalysisResult, type Finding, type Question, type SecurityAlertRow,
} from "@yako/core";
import { getLedger } from "../db/ledger";
import { asDbAdapter } from "../db/open";
import { homeStats, type HomeStats } from "../queries";
import { loadFindings, loadStoredFindings } from "../insights";
import { narrateOffline, type Narration } from "../narrate";
import { Chart, MiniBars, shortKes } from "../components/Charts";
import { QuestionCard } from "../components/QuestionCard";
import { MergeCard } from "../components/MergeCard";
import { AskScreen } from "./Ask";
import { IdentityWizard } from "../components/IdentityWizard";
import { loadPlan } from "../plan/data";
import { FloatCard } from "./plan/Overview";
import { ModeHeadline } from "../components/ModeHeadline";
import { Btn, C, Card, Empty, Pill, Screen, SectionTitle, kes, text } from "../ui";

function AnalysisCard({ r, compact }: { r: AnalysisResult; compact?: boolean }) {
  const hasChart = r.chart && ((r.chart.series?.some((s) => s.points.length)) || (r.chart.cells?.length ?? 0) > 0);
  if (!hasChart && !r.findings.length) return null;
  return (
    <Card style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text style={text(14, C.text, "700")}>{r.title}</Text>
        <View style={{ flex: 1 }} />
        <Text style={text(9, C.dim)}>{r.findings[0]?.n ?? 0} pts</Text>
      </View>
      {r.findings[0] && (
        <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 17 }]}>{r.findings[0].text}</Text>
      )}
      {hasChart && <View style={{ marginTop: 10 }}>{!compact && <Chart spec={r.chart!} />}</View>}
      {compact && r.chart && <View style={{ marginTop: 10 }}><Chart spec={r.chart} /></View>}
    </Card>
  );
}

function InsightCard({ f, db, onChanged, autoNarrate = false, profile, onSetupModels, onOpenTx }: { f: Finding; db: SQLiteDatabase; onChanged: () => void; autoNarrate?: boolean; profile?: { tone?: string; language?: string; verticals?: string[] } | null; onSetupModels?: () => void; onOpenTx?: (id: number) => void }) {
  const [narr, setNarr] = useState<Narration | null>(null);
  const [busy, setBusy] = useState(false);

  const explain = async () => {
    if (busy) return;
    setBusy(true);
    try { setNarr(await narrateOffline(f, { tone: profile?.tone, language: profile?.language, verticals: profile?.verticals })); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!autoNarrate) return;
    let alive = true;
    setBusy(true);
    narrateOffline(f, { tone: profile?.tone, language: profile?.language, verticals: profile?.verticals })
      .then((n) => { if (alive) setNarr(n); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [f.id, autoNarrate]);

  return (
    <View style={{ backgroundColor: C.card, borderRadius: 16, padding: 14, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pill label={plainDetector(f.detector)} tone="blue" />
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => { setFindingState(asDbAdapter(db), f.id, "dismissed"); onChanged(); }}>
          <Text style={text(10, C.dim)}>dismiss</Text>
        </TouchableOpacity>
      </View>
      <Text style={[text(13, C.text, "600"), { marginTop: 8, lineHeight: 19 }]}>{plainTerms(f.title)}</Text>

      {!narr && (
        <View style={{ marginTop: 10, backgroundColor: C.card2, borderRadius: 12, padding: 11 }}>
          <Text style={[text(13, C.text), { lineHeight: 20 }]}>{narrateFinding(f)}</Text>
          {busy && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 }}>
              <ActivityIndicator size="small" color={C.blue} />
              <Text style={text(10, C.muted)}>Explaining this on the phone…</Text>
            </View>
          )}
        </View>
      )}

      {narr && (
        <View style={{ marginTop: 10, backgroundColor: C.card2, borderRadius: 12, padding: 11 }}>
          <Text style={[text(13, C.text), { lineHeight: 20 }]}>{narr.text}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 9 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: narr.source === "llm" ? C.green : C.amber }} />
            <Text style={text(10, C.muted)}>
              {narr.source === "llm" ? "Rewritten by the on-device model" : "Template"}
              {` · ${(narr.ms / 1000).toFixed(1)}s`}
              {narr.tokPerSec ? ` · ${narr.tokPerSec.toFixed(1)} tok/s` : ""}
            </Text>
          </View>
          {narr.note === "model_missing" && (
            <TouchableOpacity onPress={onSetupModels} style={{ marginTop: 6 }} accessibilityRole="button">
              <Text style={text(10, C.blue, "600")}>Download explanations to rewrite this on the phone ›</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {!busy && !narr && (
        <TouchableOpacity onPress={() => void explain()} style={{ marginTop: 9 }}>
          <Text style={text(11, C.blue, "600")}>Explain this ›</Text>
        </TouchableOpacity>
      )}

      {f.detector === "episodes" && (() => {
        const ant = f.evidence.antecedents as { daysSinceIncome?: number | null; hoursSinceGroceries?: number | null; weekday?: number | null; walletBalanceBeforeCents?: number | null } | undefined;
        const cons = f.evidence.consequences as { fulizaDrawsWithin7d?: number } | undefined;
        const ids = Array.isArray(f.evidence.txIds) ? f.evidence.txIds.map(Number) : [];
        const weekday = ant?.weekday == null ? null : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][ant.weekday] ?? null;
        return (
          <View style={{ marginTop: 9, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
            <Text style={text(10, C.muted, "700")}>WHAT CAME BEFORE</Text>
            <Text style={[text(11, C.muted), { marginTop: 3, lineHeight: 16 }]}>
              {weekday ? `${weekday}` : "Day of week not known"}
              {ant?.daysSinceIncome != null ? ` · ${ant.daysSinceIncome.toFixed(1)} days after money came in` : ""}
              {ant?.hoursSinceGroceries != null ? ` · ${ant.hoursSinceGroceries.toFixed(1)} h after groceries` : ""}
              {ant?.walletBalanceBeforeCents != null ? ` · wallet ${kes(ant.walletBalanceBeforeCents)}` : ""}
            </Text>
            <Text style={[text(10, C.muted, "700"), { marginTop: 8 }]}>WHAT FOLLOWED</Text>
            <Text style={[text(11, C.muted), { marginTop: 3 }]}>{Number(cons?.fulizaDrawsWithin7d ?? 0)} Fuliza draw{Number(cons?.fulizaDrawsWithin7d ?? 0) === 1 ? "" : "s"} within 7 days.</Text>
            {ids.length > 0 && onOpenTx && (
              <TouchableOpacity onPress={() => onOpenTx(ids[0]!)} style={{ minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel={`See ${ids.length} payment${ids.length === 1 ? "" : "s"}`}>
                <Text style={text(11, C.blue, "600")}>See {ids.length} payment{ids.length === 1 ? "" : "s"} ›</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {f.detector === "bocpd_regime" && (
        <View style={{ marginTop: 9, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
          <Text style={text(10, C.muted, "700")}>BEFORE AND AFTER</Text>
          <Text style={[text(11, C.muted), { marginTop: 3 }]}>
            Before about {kes(Number(f.evidence.beforeMeanCents ?? f.evidence.beforeMean ?? 0))} · after {kes(Number(f.evidence.afterMeanCents ?? f.evidence.afterMean ?? 0))}
            {f.evidence.beforeN != null ? ` · ${Number(f.evidence.beforeN)} vs ${Number(f.evidence.afterN)} payments` : ""}
          </Text>
        </View>
      )}
    </View>
  );
}

export function TodayScreen({ refreshKey, onMore, onReview, onQuickReview, onPlan, onAlert, onWeekly, onSetupModels, onOpenTx }: {
  refreshKey: number; onMore: () => void; onReview: () => void; onQuickReview: () => void; onPlan: () => void; onAlert: (id: number) => void; onWeekly: () => void; onSetupModels: () => void; onOpenTx?: (id: number) => void;
}) {
  const db = getLedger().db;
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisResult[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [alerts, setAlerts] = useState<SecurityAlertRow[]>([]);
  const [offRadar, setOffRadar] = useState<ReturnType<typeof offRadarSummary> | null>(null);
  const [fuliza, setFuliza] = useState<ReturnType<typeof fulizaState>>(null);
  const [debts, setDebts] = useState<ReturnType<typeof debtSummary> | null>(null);
  const [ask, setAsk] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [local, setLocal] = useState(0);
  const [wizard, setWizard] = useState(false);
  const [floatData, setFloatData] = useState<ReturnType<typeof loadPlan> | null>(null);

  useEffect(() => {
    try {
      setStats(homeStats(db));
      setTimeout(() => { try { setFloatData(loadPlan(db)); } catch { /* plan optional */ } }, 50);
      setAnalyses(runAllAnalyses(asDbAdapter(db)));
      generateQuestions(asDbAdapter(db));
      setQuestions(pendingQuestions(asDbAdapter(db), 3));
      const stored = loadStoredFindings(db);
      setFindings(stored);
      if (!stored.length) setTimeout(() => { try { setFindings(loadFindings(db).findings); } catch { /* empty */ } }, 250);
      setAlerts(listSecurityAlerts(asDbAdapter(db), 5));
      setOffRadar(offRadarSummary(asDbAdapter(db), Date.now() - 180 * 86_400_000));
      setFuliza(fulizaState(asDbAdapter(db)));
      setDebts(debtSummary(asDbAdapter(db)));
    } catch {
      setAnalyses([]);
    }
  }, [refreshKey, local]);

  const profile = useMemo(() => { try { return getProfile(asDbAdapter(db)); } catch { return null; } }, [db, refreshKey, local]);
  const monthFlow = analyses.find((a) => a.kind === "month_flow");
  const daily = analyses.find((a) => a.kind === "daily_spend");
  const net = (stats?.monthIn ?? 0) - (stats?.monthOut ?? 0) - (stats?.monthFees ?? 0);
  const todayNet = (stats?.todayIn ?? 0) - (stats?.todayOut ?? 0) - (stats?.todayFees ?? 0);
  const needsIdentity = !profile || (!profile.verticals.length && !profile.name && !profile.identityCustom);
  const monthFees = stats?.monthFees;
  const chartOf = (kind: string) => analyses.find((a) => a.kind === kind);
  const loading = stats === null;
  // Auto-explain the first simple finding. Multi-amount debt/loan findings are
  // left on the deterministic template because small models swap their roles.
  const shownFindings = findings.filter((f) => !f.gate || f.gate === "shown");
  const autoNarrateId = shownFindings.slice(0, 3).find((f) => {
    const amounts = (f.title.match(/(?:KES|Ksh|KSh)\s*[\d]/g) ?? []).length;
    return amounts <= 1 && !/\b(borrowed|repaid)\b/i.test(f.title);
  })?.id;

  const refresh = () => { setRefreshing(true); setLocal((n) => n + 1); setTimeout(() => setRefreshing(false), 350); };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 24, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.blue} />}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text style={text(30, C.text, "700")} maxFontSizeMultiplier={1.4} accessibilityRole="header">Home</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => setAsk(true)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Ask a question about your money"
            style={{ backgroundColor: C.blue, borderRadius: 20, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" }}>
            <Text style={text(12, "#fff", "700")}>Ask</Text>
          </TouchableOpacity>
        </View>
        <Text style={[text(12, C.muted), { marginTop: 2 }]}>
          {profile?.verticals.length ? `${profile.verticals.length} occupation${profile.verticals.length === 1 ? "" : "s"} · ${profile.tone} tone` : "Analyst view · computed on this phone"}
        </Text>

        <ModeHeadline db={db} refreshKey={refreshKey} />

        {(stats?.pending ?? 0) > 0 && (
          <TouchableOpacity onPress={onQuickReview} activeOpacity={0.8} accessibilityRole="button"
            accessibilityLabel={`${stats!.pending} payments need a name. Start quick labelling.`} style={{ marginTop: 16 }}>
            <Card style={{ borderColor: "#3A2E12", backgroundColor: "#17130A", minHeight: 48 }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
                <Pill label="NEEDS YOU" tone="amber" />
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={onReview} accessibilityRole="button" accessibilityLabel="Open the full queue" style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 6 }}>
                  <Text style={text(11, C.blue, "600")}>Full queue ›</Text>
                </TouchableOpacity>
              </View>
              <Text style={[text(16, C.text, "700"), { marginTop: 4 }]}>{stats!.pending} payment{stats!.pending === 1 ? "" : "s"} need a name</Text>
              <Text style={[text(12, C.muted), { marginTop: 4, lineHeight: 17 }]}>Name the biggest and most repeated first. One answer can cover every payment to the same place.</Text>
              <Text style={[text(12, C.amber, "700"), { marginTop: 8 }]}>Start quick labelling ›</Text>
            </Card>
          </TouchableOpacity>
        )}

        {floatData && (
          <TouchableOpacity onPress={onPlan} activeOpacity={0.9} accessibilityRole="button" accessibilityLabel="Open Plan">
            <FloatCard f={floatData.float} spendEnough={floatData.spendEnough} />
          </TouchableOpacity>
        )}

        {!loading && (
          <Card style={{ marginTop: 14 }}>
            <Text style={text(11, C.muted, "700")}>TODAY</Text>
            <View style={{ flexDirection: "row", marginTop: 10, gap: 24, flexWrap: "wrap" }}>
              <View style={{ flexGrow: 1, flexBasis: 110 }}><Text style={text(12, C.muted)}>In</Text><Text style={[text(20, C.green, "700"), { marginTop: 2 }]} maxFontSizeMultiplier={1.5}>{kes(stats?.todayIn ?? 0)}</Text></View>
              <View style={{ flexGrow: 1, flexBasis: 110 }}><Text style={text(12, C.muted)}>Out</Text><Text style={[text(20, C.red, "700"), { marginTop: 2 }]} maxFontSizeMultiplier={1.5}>{kes(stats?.todayOut ?? 0)}</Text></View>
            </View>
            <Text style={[text(12, C.muted), { marginTop: 10 }]}>Net {todayNet >= 0 ? "+" : ""}{kes(todayNet)} after {kes(stats?.todayFees ?? 0)} fees. Loans you took or repaid and moves between your own accounts are shown separately, see How we count.</Text>
          </Card>
        )}

        {needsIdentity && (
          <TouchableOpacity onPress={() => setWizard(true)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Start personal setup">
            <Card tone="card2" style={{ marginTop: 12 }}>
              <Text style={text(14, C.text, "600")}>Make it yours</Text>
              <Text style={[text(12, C.muted), { marginTop: 3, lineHeight: 17 }]}>A short setup. Pesanalysis can guess from your messages, then you choose. Nothing leaves the phone.</Text>
              <Text style={[text(12, C.blue, "600"), { marginTop: 8 }]}>Start setup ›</Text>
            </Card>
          </TouchableOpacity>
        )}

        {loading ? (
          <Card style={{ marginTop: 16, alignItems: "center", paddingVertical: 34 }}>
            <ActivityIndicator color={C.blue} />
            <Text style={[text(12, C.muted), { marginTop: 10 }]}>Reading the ledger on this phone…</Text>
          </Card>
        ) : (
        <Card style={{ marginTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
            <View style={{ flex: 1 }}>
              <Text style={text(10, C.muted, "700")}>THIS MONTH</Text>
              <Text style={[text(30, net >= 0 ? C.green : C.red, "700"), { marginTop: 4 }]}>{net >= 0 ? "+" : ""}{kes(net)}</Text>
              <Text style={text(11, C.dim)}>net after spending</Text>
            </View>
            {daily?.chart?.series[0] && <MiniBars values={daily.chart.series[0].points.map((p) => p.y)} color={C.blue} />}
          </View>
          <View style={{ flexDirection: "row", marginTop: 14, gap: 18 }}>
            <View style={{ flex: 1 }}>
              <Text style={text(10, C.dim)}>IN</Text>
              <Text style={text(15, C.green, "700")}>{kes(stats?.monthIn ?? 0)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={text(10, C.dim)}>OUT</Text>
              <Text style={text(15, C.red, "700")}>{kes(stats?.monthOut ?? 0)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={text(10, C.dim)}>FEES</Text>
              <Text style={text(15, C.text, "700")}>{monthFees != null ? kes(monthFees) : "—"}</Text>
            </View>
          </View>
          {monthFlow?.findings[0] && (
            <Text style={[text(11, C.muted), { marginTop: 12, lineHeight: 16 }]}>{monthFlow.findings[0].text}</Text>
          )}
        </Card>
        )}

        {alerts.length > 0 && (
          <>
            <SectionTitle>SAFETY CHECK</SectionTitle>
            {alerts.slice(0, 2).map((a) => (
              <TouchableOpacity key={a.id} onPress={() => onAlert(a.id)} activeOpacity={0.8} accessibilityRole="button"
                accessibilityLabel={`Safety alert: ${a.title}. Open evidence`}
                style={{ backgroundColor: a.severity === "critical" ? "#3A1114" : "#2A2110", borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: a.severity === "critical" ? C.red : C.amber, minHeight: 48 }}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Pill label={a.severity} tone={a.severity === "critical" ? "red" : "amber"} />
                  <View style={{ flex: 1 }} />
                  <Text style={text(11, C.blue, "600")}>See evidence ›</Text>
                </View>
                <Text style={[text(13, C.text, "700"), { marginTop: 8 }]}>{a.title}</Text>
                <Text style={[text(11, C.muted), { marginTop: 4, lineHeight: 16 }]}>{a.detail}</Text>
              </TouchableOpacity>
            ))}
            {alerts.length > 2 && <Text style={text(10, C.dim)}>+{alerts.length - 2} more alerts</Text>}
          </>
        )}

        {offRadar && (
          <>
            <SectionTitle>ACCOUNTS & MONEY OUTSIDE SMS</SectionTitle>
            <Card style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={text(14, C.text, "700")}>{offRadar.accounts.length} accounts auto-discovered</Text>
                <View style={{ flex: 1 }} />
                <Text style={text(10, alerts.length ? C.amber : C.green, "600")}>{alerts.length ? `${alerts.length} alerts` : "shield clear"}</Text>
              </View>
              {offRadar.accounts.slice(0, 5).map((a) => (
                <View key={a.id} style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={text(12, C.text, "600")} numberOfLines={1}>{a.name}</Text>
                    <Text style={text(9, C.dim)}>{a.kind} · {a.visibility} · {a.tx_count} tx</Text>
                  </View>
                  <Text style={text(11, C.muted)}>{a.last_balance_cents != null ? kes(a.last_balance_cents) : `${kes(a.total_in_cents)} in`}</Text>
                </View>
              ))}
              <View style={{ height: 1, backgroundColor: C.line, marginVertical: 10 }} />
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={text(11, C.muted)}>Off-radar outflow (6m)</Text>
                <Text style={text(11, C.amber, "700")}>{kes(offRadar.offRadarCents)} · {Math.round(offRadar.share * 100)}% of outflow</Text>
              </View>
              <Text style={[text(10, C.dim), { marginTop: 4, lineHeight: 15 }]}>Visible-wallet transfers to banks/SACCOs/vaults are expensed here and tracked on the destination account.</Text>
            </Card>
          </>
        )}

        {fuliza && (fuliza.availableCents != null || (fuliza.outstandingCents ?? 0) > 0) && (
          <>
            <SectionTitle>FULIZA</SectionTitle>
            <Card style={{ marginBottom: 10, borderColor: fuliza.outstandingCents ? C.amber : C.line }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={text(14, C.text, "700")}>
                  {fuliza.availableCents != null ? `${kes(fuliza.availableCents)} available` : "Credit line found"}
                </Text>
                <View style={{ flex: 1 }} />
                {fuliza.outstandingCents != null && fuliza.outstandingCents > 0 && <Pill label={`${kes(fuliza.outstandingCents)} used`} tone="amber" />}
              </View>
              {fuliza.limitCents != null && <Text style={[text(11, C.muted), { marginTop: 5 }]}>Limit {kes(fuliza.limitCents)}{fuliza.availableCents != null ? ` · ${Math.round((fuliza.availableCents / Math.max(1, fuliza.limitCents)) * 100)}% left` : ""}</Text>}
              {fuliza.stale && <Text style={[text(11, C.amber), { marginTop: 5 }]}>Last Fuliza message {fuliza.asOf ? new Date(fuliza.asOf).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "a while ago"}; open M-PESA to confirm before drawing again.</Text>}
              {fuliza.availableCents != null && <Text style={[text(11, C.muted), { marginTop: 4, lineHeight: 16 }]}>The next draw can be up to {kes(fuliza.availableCents)}. A draw above KES 1,000 can cost more; check the current Fuliza terms before you tap.</Text>}
              {fuliza.dueAt != null && fuliza.outstandingCents != null && fuliza.outstandingCents > 0 && <Text style={[text(11, fuliza.dueAt < Date.now() ? C.red : C.amber), { marginTop: 5 }]}>{fuliza.dueAt < Date.now() ? "Was due" : "Outstanding is due"} {new Date(fuliza.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}. Daily fees can continue until it is cleared.</Text>}
              <Text style={[text(10, C.dim), { marginTop: 6 }]}>Read from your Fuliza messages. No balance is guessed.</Text>
            </Card>
          </>
        )}

        {questions.length > 0 && (
          <>
            <SectionTitle>A QUICK QUESTION</SectionTitle>
            {questions.map((q) => <QuestionCard key={q.id} db={db} q={q} onAnswered={() => setLocal((n) => n + 1)} />)}
          </>
        )}

        <MergeCard db={db} refreshKey={refreshKey + local} onChanged={() => setLocal((n) => n + 1)} />

        {debts && debts.active > 0 && (
          <>
            <SectionTitle right={<TouchableOpacity onPress={onMore}><Text style={text(11, C.blue, "600")}>Manage</Text></TouchableOpacity>}>DEBT</SectionTitle>
            <Card style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={text(14, C.text, "700")}>{kes(debts.outstandingCents)} outstanding</Text>
                <View style={{ flex: 1 }} />
                <Text style={text(11, C.muted)}>{debts.active} active</Text>
              </View>
              <Text style={[text(11, C.muted), { marginTop: 5, lineHeight: 16 }]}>
                {debts.monthlyCents ? `${kes(debts.monthlyCents)} scheduled each month. ` : ""}
                {debts.nextDueAt ? `Next payment ${new Date(debts.nextDueAt + 3 * 3_600_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}. ` : ""}
                {debts.linkedRepayments} repayment{debts.linkedRepayments === 1 ? "" : "s"} linked to the ledger.
              </Text>
            </Card>
          </>
        )}

        {shownFindings.length > 0 && (
          <>
            <SectionTitle>WHAT WE NOTICED</SectionTitle>
            {shownFindings.slice(0, 5).map((f) => (
              <InsightCard key={f.id} f={f} db={db} profile={profile} autoNarrate={f.id === autoNarrateId} onChanged={() => setLocal((n) => n + 1)} onSetupModels={onSetupModels} onOpenTx={onOpenTx} />
            ))}
          </>
        )}

        <TouchableOpacity onPress={onWeekly} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Open your weekly review">
          <Card style={{ marginTop: 10, marginBottom: 10 }}>
            <Text style={text(11, C.muted, "700")}>YOUR WEEK</Text>
            <Text style={[text(15, C.text, "700"), { marginTop: 4 }]}>See habits, patterns and credit use from the last seven days.</Text>
            <Text style={[text(12, C.blue, "600"), { marginTop: 7 }]}>Open weekly review ›</Text>
          </Card>
        </TouchableOpacity>

        <SectionTitle>MONEY OVER TIME</SectionTitle>
        {chartOf("month_flow") ? <AnalysisCard r={chartOf("month_flow")!} /> : <Empty title="Not enough history" body="A few more payments will make the trend meaningful." />}
        {chartOf("category_trend") && <AnalysisCard r={chartOf("category_trend")!} />}

        <SectionTitle>PEOPLE & PLACES</SectionTitle>
        {chartOf("top_counterparties") && <AnalysisCard r={chartOf("top_counterparties")!} />}
        {chartOf("heatmap") && <AnalysisCard r={chartOf("heatmap")!} />}

        <SectionTitle>COSTS & INCOME</SectionTitle>
        {chartOf("fees") && <AnalysisCard r={chartOf("fees")!} />}
        {chartOf("income_mix") && <AnalysisCard r={chartOf("income_mix")!} />}
        {chartOf("recurring") && (chartOf("recurring")!.findings.length > 0
          ? <AnalysisCard r={chartOf("recurring")!} />
          : <Card style={{ marginBottom: 10 }}><Text style={text(13, C.text, "600")}>No recurring pattern yet</Text><Text style={[text(11, C.muted), { marginTop: 4 }]}>Three or more similar payments are needed.</Text></Card>)}

        {(chartOf("anomalies")?.findings.length ?? 0) > 0 && (
          <>
            <SectionTitle>WORTH A LOOK</SectionTitle>
            <AnalysisCard r={chartOf("anomalies")!} />
          </>
        )}

        <SectionTitle>PROJECTS & BALANCE</SectionTitle>
        {chartOf("ventures") && <AnalysisCard r={chartOf("ventures")!} />}
        {chartOf("balance") && <AnalysisCard r={chartOf("balance")!} />}

        <View style={{ alignItems: "center", marginTop: 14 }}>
          <Text style={text(10, C.dim)}>Every number above came from SQL over your ledger.</Text>
          <Text style={[text(10, C.dim), { marginTop: 3 }]}>No cloud model. No bank connection.</Text>
        </View>
      </ScrollView>
      <AskScreen visible={ask} onClose={() => setAsk(false)} db={db} onOpenTx={onOpenTx} />
      <IdentityWizard visible={wizard} db={db} onClose={() => setWizard(false)} onSaved={() => setLocal((n) => n + 1)} />
    </Screen>
  );
}
