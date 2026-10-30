import { useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  type ExpectCadence, type FlowRow, type FlowSuggestion, type HolidayPolicy, type NewFlow, type OccState, type OccurrenceRow,
  centsToInput, clearTransactionOverride, createFlow, dayLabel, daysPhrase, delayPhrase, diffDays, occStateLabel, parseKesToCents,
  pinTransaction, refreshOccurrences, rejectTransaction, setFlowStatus, unwaiveOccurrence, updateFlow, waiveOccurrence,
} from "@yako/core";
import { asDbAdapter } from "../../db/open";
import { acceptPattern, candidatesFor, type FlowView } from "../../plan/data";
import { C, Card, Empty, Pill, SectionTitle, kes, text } from "../../ui";
import { Button, Chip, Field, Hint, Label, MIN, Row, Sheet, Wrap, dateLabel } from "./parts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TONE: Record<OccState, "dim" | "green" | "blue" | "amber" | "red"> = { upcoming: "blue", matched: "green", late: "amber", partial: "amber", missed: "red", waived: "dim" };

export function amountText(f: Pick<FlowRow, "amountMinCents" | "amountTypCents" | "amountMaxCents">): string {
  const { amountMinCents: lo, amountMaxCents: hi, amountTypCents: t } = f;
  if (lo != null && hi != null && lo !== hi) return `${kes(lo)} to ${kes(hi)}`;
  const v = t ?? lo ?? hi;
  return v == null ? "Amount not set" : kes(v);
}

export function cadenceText(f: FlowRow): string {
  switch (f.cadence) {
    case "once": return f.anchorOn ? `Once, ${dayLabel(f.anchorOn)}` : "Once";
    case "weekly": return `Every ${WEEKDAYS[f.weekday ?? 0]}`;
    case "monthly": return `Monthly on day ${f.dayOfMonth}`;
    case "last_working_day": return "Last working day of the month";
    default: return `Every ${f.intervalDays} days`;
  }
}

function dueText(o: OccurrenceRow, today: string): string {
  const n = diffDays(o.dueOn, today);
  if (o.state === "late" || (n < 0 && o.state !== "matched" && o.state !== "waived")) return `${dayLabel(o.dueOn)} · ${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"} overdue`;
  return `${dayLabel(o.dueOn)} · ${daysPhrase(n)}`;
}

export function ExpectedSection({ db, views, notices, patterns, today, onChanged }: {
  db: SQLiteDatabase; views: FlowView[]; notices: FlowRow[]; patterns: FlowSuggestion[]; today: string; onChanged: () => void;
}) {
  const [edit, setEdit] = useState<{ flow: FlowRow | null; direction: "in" | "out" } | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const a = asDbAdapter(db);
  const guard = (fn: () => void) => { try { fn(); onChanged(); } catch (e) { Alert.alert("Could not save", e instanceof Error ? e.message : "Try again."); } };
  const income = views.filter((v) => v.flow.direction === "in");
  const bills = views.filter((v) => v.flow.direction === "out");
  const open = views.find((v) => v.flow.id === detail);

  const list = (title: string, items: FlowView[], dir: "in" | "out", emptyBody: string) => (
    <>
      <SectionTitle right={<Button label="Add" kind="ghost" a11yLabel={`Add ${dir === "in" ? "expected income" : "bill or obligation"}`} onPress={() => setEdit({ flow: null, direction: dir })} />}>{title}</SectionTitle>
      {items.length === 0 ? <Card><Hint>{emptyBody}</Hint></Card> : items.map((v) => <FlowCard key={v.flow.id} v={v} today={today} onOpen={() => setDetail(v.flow.id)} />)}
    </>
  );

  return (
    <>
      {(notices.length > 0 || patterns.length > 0) && (
        <>
          <SectionTitle>Suggested for you</SectionTitle>
          {notices.map((f) => (
            <Card key={`n${f.id}`} style={{ marginBottom: 10 }}>
              <Text style={text(14, C.text, "700")}>{f.name}</Text>
              <Hint>{amountText(f)} from a message you received{f.anchorOn ? `, due ${dayLabel(f.anchorOn)}` : ""}. Track it so it counts in your plan?</Hint>
              <Wrap style={{ marginTop: 10 }}>
                <Button label="Track it" onPress={() => guard(() => setFlowStatus(a, f.id, "active"))} a11yLabel={`Track ${f.name}`} />
                <Button label="Not now" kind="soft" onPress={() => guard(() => setFlowStatus(a, f.id, "dismissed"))} a11yLabel={`Dismiss suggestion ${f.name}`} />
              </Wrap>
            </Card>
          ))}
          {patterns.map((s) => (
            <Card key={`p${s.direction}${s.key}`} style={{ marginBottom: 10 }}>
              <Text style={text(14, C.text, "700")}>{s.name}</Text>
              <Hint>
                {s.direction === "in" ? "Money in" : "Money out"} of about {kes(s.typCents)} seems to happen {s.cadence === "monthly" ? `around day ${s.dayOfMonth} each month` : `every ${WEEKDAYS[s.weekday ?? 0]}`} ({s.n} times so far). Track it?
              </Hint>
              <Wrap style={{ marginTop: 10 }}>
                <Button label="Track it" onPress={() => guard(() => { acceptPattern(db, s, "active"); refreshOccurrences(a); })} a11yLabel={`Track ${s.name}`} />
                <Button label="No thanks" kind="soft" onPress={() => guard(() => acceptPattern(db, s, "dismissed"))} a11yLabel={`Dismiss suggestion ${s.name}`} />
              </Wrap>
            </Card>
          ))}
        </>
      )}

      {list("Expected income", income, "in", "Salary, dividends, a regular client. Add what you expect and Pesanalysis will watch for it.")}
      {list("Bills and obligations", bills, "out", "Rent, school fees, loan instalments, chama contributions. Add them so your free float is honest.")}
      {views.length === 0 && notices.length === 0 && patterns.length === 0 && (
        <Empty title="Nothing tracked yet" body="Tell Pesanalysis what money you expect and what you owe. It matches real payments to these automatically." />
      )}

      {edit && (
        <FlowForm flow={edit.flow} direction={edit.direction} onClose={() => setEdit(null)}
          onSave={(patch) => { guard(() => { if (edit.flow) updateFlow(a, edit.flow.id, patch); else createFlow(a, patch as NewFlow); refreshOccurrences(a); }); setEdit(null); }}
          onStop={edit.flow ? () => { guard(() => setFlowStatus(a, edit.flow!.id, "ended")); setEdit(null); setDetail(null); } : undefined} />
      )}
      {open && <FlowDetail db={db} v={open} today={today} onClose={() => setDetail(null)} onChanged={onChanged} onEdit={() => { setEdit({ flow: open.flow, direction: open.flow.direction }); }} />}
    </>
  );
}

function FlowCard({ v, today, onOpen }: { v: FlowView; today: string; onOpen: () => void }) {
  const f = v.flow, n = v.next;
  const delay = delayPhrase(v.stats, f.direction);
  const label = `${f.name}. ${f.direction === "in" ? "Money in" : "Money out"}. ${amountText(f)}. ${cadenceText(f)}.${n ? ` ${occStateLabel(n.state, f.direction)}, ${dueText(n, today)}.` : ""}${delay ? ` ${delay}.` : ""}`;
  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens details" style={{ marginBottom: 10 }}>
      <Card>
        <Row
          left={<><Text style={text(15, C.text, "700")}>{f.name}</Text><Text style={[text(12, C.muted), { marginTop: 2 }]}>{cadenceText(f)}</Text></>}
          right={<Text style={text(15, f.direction === "in" ? C.green : C.text, "700")}>{amountText(f)}</Text>} />
        <Wrap gap={6} style={{ marginTop: 10, alignItems: "center" }}>
          {n && <Pill label={occStateLabel(n.state, f.direction)} tone={TONE[n.state]} />}
          {n && <Text style={text(12, n.state === "late" ? C.amber : C.muted)}>{dueText(n, today)}</Text>}
        </Wrap>
        {delay && <Text style={[text(12, C.muted), { marginTop: 8 }]}>{delay}</Text>}
      </Card>
    </TouchableOpacity>
  );
}

function FlowDetail({ db, v, today, onClose, onChanged, onEdit }: { db: SQLiteDatabase; v: FlowView; today: string; onClose: () => void; onChanged: () => void; onEdit: () => void }) {
  const f = v.flow;
  const a = asDbAdapter(db);
  const [sel, setSel] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const act = (fn: () => void) => { try { fn(); refreshOccurrences(a); setTick((t) => t + 1); onChanged(); } catch (e) { Alert.alert("Could not update", e instanceof Error ? e.message : "Try again."); } };
  const s = v.stats;
  const occs = [...v.occurrences].filter((o) => diffDays(o.dueOn, today) <= 45).sort((x, y) => (x.dueOn < y.dueOn ? 1 : -1));
  const chosen = occs.find((o) => o.id === sel);
  void tick;
  return (
    <Sheet title={f.name} onClose={onClose}>
      <Text style={[text(13, C.muted), { marginTop: 8 }]}>{f.direction === "in" ? "Money in" : "Money out"} · {amountText(f)} · {cadenceText(f)}</Text>
      {s.decided >= 1 && (
        <Card tone="card2" style={{ marginTop: 12 }}>
          <Text style={text(13, C.text, "700")}>{delayPhrase(s, f.direction) ?? "Not enough history yet to say when it usually comes"}</Text>
          <Hint>
            {s.counts.matched + s.counts.partial} of {s.decided} so far {f.direction === "in" ? "arrived" : "were paid"}
            {s.onTimeRate != null ? `, ${Math.round(s.onTimeRate * 100)}% on time` : ""}.
            {s.counts.missed > 0 ? ` ${s.counts.missed} missed.` : ""}
          </Hint>
        </Card>
      )}
      <Wrap style={{ marginTop: 12 }}><Button label="Edit" kind="soft" onPress={onEdit} a11yLabel={`Edit ${f.name}`} /></Wrap>

      <Label>Each time</Label>
      {occs.length === 0 && <Hint>No dates yet.</Hint>}
      {occs.map((o) => (
        <View key={o.id} style={{ marginBottom: 10, backgroundColor: C.card2, borderRadius: 14, padding: 12 }}>
          <Row
            left={<><Text style={text(14, C.text, "600")}>{dayLabel(o.dueOn)}</Text><Text style={[text(12, C.muted), { marginTop: 2 }]}>
              {o.receivedCents > 0 ? `${kes(o.receivedCents)} ${f.direction === "in" ? "received" : "paid"}${o.delayDays != null && o.delayDays !== 0 ? `, ${Math.abs(o.delayDays)} day${Math.abs(o.delayDays) === 1 ? "" : "s"} ${o.delayDays > 0 ? "late" : "early"}` : ""}` : o.expectedCents ? `Expecting ${kes(o.expectedCents)}` : ""}
            </Text></>}
            right={<Pill label={occStateLabel(o.state, f.direction)} tone={TONE[o.state]} />} />
          <Wrap style={{ marginTop: 8 }}>
            {o.state !== "waived" && <Button label={o.state === "matched" ? "Wrong payment?" : "This is it…"} kind="soft" onPress={() => setSel(sel === o.id ? null : o.id)}
              a11yLabel={`${o.state === "matched" ? "Review matched payment for" : "Pick the payment for"} ${dayLabel(o.dueOn)}`} />}
            {o.state === "waived"
              ? <Button label="Undo skip" kind="soft" onPress={() => act(() => unwaiveOccurrence(a, o.id))} a11yLabel={`Undo skip for ${dayLabel(o.dueOn)}`} />
              : o.state !== "matched" && <Button label="Skip this one" kind="ghost" onPress={() => act(() => waiveOccurrence(a, o.id))} a11yLabel={`Skip ${dayLabel(o.dueOn)}`} />}
          </Wrap>
          {chosen?.id === o.id && <Candidates db={db} flow={f} occ={o} act={act} />}
        </View>
      ))}
    </Sheet>
  );
}

function Candidates({ db, flow, occ, act }: { db: SQLiteDatabase; flow: FlowRow; occ: OccurrenceRow; act: (fn: () => void) => void }) {
  const a = asDbAdapter(db);
  let cands: ReturnType<typeof candidatesFor> = [];
  try { cands = candidatesFor(db, flow, occ); } catch { cands = []; }
  if (!cands.length) return <Hint>No payments found near this date.</Hint>;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={text(12, C.muted, "600")}>Payments near this date</Text>
      {cands.map((c) => {
        const isIt = occ.matchedTxIds.includes(c.id) || occ.pinnedTxIds.includes(c.id);
        return (
          <View key={c.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
            <Row left={<><Text style={text(13, C.text, "600")}>{c.who}</Text><Text style={text(11, C.muted)}>{dateLabel(c.occurredAt)}</Text></>} right={<Text style={text(13, C.text, "700")}>{kes(c.amountCents)}</Text>} />
            <Wrap style={{ marginTop: 6 }}>
              {isIt ? (
                <Button label="Not this" kind="danger" onPress={() => act(() => rejectTransaction(a, occ.id, c.id))} a11yLabel={`Not this: ${kes(c.amountCents)} from ${c.who}`} />
              ) : (
                <Button label="This is it" onPress={() => act(() => pinTransaction(a, occ.id, c.id))} a11yLabel={`This is it: ${kes(c.amountCents)} from ${c.who}`} />
              )}
              {isIt && occ.pinnedTxIds.includes(c.id) && <Button label="Clear" kind="ghost" onPress={() => act(() => clearTransactionOverride(a, occ.id, c.id))} a11yLabel="Clear my choice" />}
            </Wrap>
          </View>
        );
      })}
    </View>
  );
}

const CADENCES: Array<[ExpectCadence, string]> = [["monthly", "Monthly"], ["weekly", "Weekly"], ["last_working_day", "Last working day"], ["once", "Once"]];
const POLICIES: Array<[HolidayPolicy, string]> = [["none", "Keep the date"], ["before", "Move earlier"], ["after", "Move later"]];

function FlowForm({ flow, direction, onClose, onSave, onStop }: {
  flow: FlowRow | null; direction: "in" | "out"; onClose: () => void; onSave: (p: Partial<NewFlow>) => void; onStop?: () => void;
}) {
  const [dir, setDir] = useState(flow?.direction ?? direction);
  const [name, setName] = useState(flow?.name ?? "");
  const ranged = !!flow && flow.amountMinCents != null && flow.amountMaxCents != null && flow.amountMinCents !== flow.amountMaxCents;
  const [range, setRange] = useState(ranged);
  const [amt, setAmt] = useState(centsToInput(flow?.amountTypCents));
  const [lo, setLo] = useState(centsToInput(flow?.amountMinCents));
  const [hi, setHi] = useState(centsToInput(flow?.amountMaxCents));
  const [cad, setCad] = useState<ExpectCadence>(flow?.cadence === "custom" ? "monthly" : flow?.cadence ?? "monthly");
  const [dom, setDom] = useState(String(flow?.dayOfMonth ?? 28));
  const [wd, setWd] = useState(flow?.weekday ?? 1);
  const [on, setOn] = useState(flow?.anchorOn ?? "");
  const [pol, setPol] = useState<HolidayPolicy>(flow?.holidayPolicy ?? (direction === "in" ? "before" : "none"));
  const [grace, setGrace] = useState(String(flow?.graceDays ?? 1));
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    if (!name.trim()) return setErr("Give it a name.");
    const p: Partial<NewFlow> = { direction: dir, name: name.trim(), cadence: cad, holidayPolicy: cad === "last_working_day" ? "none" : pol };
    if (range) {
      const l = parseKesToCents(lo), h = parseKesToCents(hi);
      if (l == null || h == null || l <= 0) return setErr("Enter the lowest and highest amount, numbers only.");
      if (l > h) return setErr("The lowest amount is higher than the highest.");
      Object.assign(p, { amountMinCents: l, amountMaxCents: h, amountTypCents: Math.round((l + h) / 2) });
    } else {
      const c = parseKesToCents(amt);
      if (c == null || c <= 0) return setErr("Enter the amount, numbers only.");
      Object.assign(p, { amountMinCents: c, amountMaxCents: c, amountTypCents: c });
    }
    if (cad === "monthly") { const d = Number(dom); if (!Number.isInteger(d) || d < 1 || d > 31) return setErr("Day of the month must be 1 to 31."); p.dayOfMonth = d; }
    if (cad === "weekly") p.weekday = wd;
    if (cad === "once") { if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return setErr("Enter the date as year-month-day, like 2026-11-28."); p.anchorOn = on; }
    const g = Number(grace);
    if (!Number.isInteger(g) || g < 0 || g > 14) return setErr("Wait days must be 0 to 14.");
    p.graceDays = g; p.missedAfterDays = Math.max(7, g + 6);
    onSave(p);
  };

  return (
    <Sheet title={flow ? "Edit" : dir === "in" ? "Add expected income" : "Add a bill"} onClose={onClose}>
      <Label>1. What</Label>
      <Wrap>
        <Chip label="Money in" selected={dir === "in"} onPress={() => setDir("in")} />
        <Chip label="Money out" selected={dir === "out"} onPress={() => setDir("out")} />
      </Wrap>
      <Field label="Name" value={name} onChange={setName} placeholder={dir === "in" ? "Salary" : "Rent"} />

      <Label>2. When</Label>
      <Wrap>{CADENCES.map(([k, l]) => <Chip key={k} label={l} selected={cad === k} onPress={() => setCad(k)} />)}</Wrap>
      {cad === "monthly" && <Field label="Day of the month" value={dom} onChange={setDom} keyboard="number-pad" hint="If a month is shorter, the last day is used." />}
      {cad === "weekly" && <><Label>Which day</Label><Wrap>{WEEKDAYS.map((d, i) => <Chip key={d} label={d} selected={wd === i} onPress={() => setWd(i)} />)}</Wrap></>}
      {cad === "once" && <Field label="Date" value={on} onChange={setOn} placeholder="2026-11-28" keyboard="numbers-and-punctuation" hint="Year-month-day." />}
      {cad !== "last_working_day" && (
        <>
          <Label>If it falls on a weekend or public holiday</Label>
          <Wrap>{POLICIES.map(([k, l]) => <Chip key={k} label={l} selected={pol === k} onPress={() => setPol(k)} />)}</Wrap>
        </>
      )}
      <Field label="Days to wait before calling it late" value={grace} onChange={setGrace} keyboard="number-pad" hint="Banks and employers are often a day or two behind." />

      <Label>3. How much (KES)</Label>
      <Wrap>
        <Chip label="One amount" selected={!range} onPress={() => setRange(false)} />
        <Chip label="A range" selected={range} onPress={() => setRange(true)} />
      </Wrap>
      {range ? (
        <>
          <Field label="Lowest amount" value={lo} onChange={setLo} keyboard="decimal-pad" />
          <Field label="Highest amount" value={hi} onChange={setHi} keyboard="decimal-pad" hint="Use a range when it changes, like dividends or a casual wage." />
        </>
      ) : <Field label="Amount" value={amt} onChange={setAmt} keyboard="decimal-pad" />}

      {err && <Text accessibilityLiveRegion="polite" style={[text(13, C.red), { marginTop: 12 }]}>{err}</Text>}
      <Wrap style={{ marginTop: 20 }}>
        <Button label="Save" onPress={submit} style={{ minWidth: 120 }} />
        {onStop && <Button label="Stop tracking" kind="danger" onPress={() => Alert.alert("Stop tracking?", "Past dates stay in your history.", [{ text: "Cancel", style: "cancel" }, { text: "Stop", style: "destructive", onPress: onStop }])} />}
      </Wrap>
    </Sheet>
  );
}
