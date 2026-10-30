import { useState } from "react";
import { Alert, Text, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  type SavingsGoal, type SavingsLocation, type SavingsRail, adjustGoal, adjustLocation, centsToInput, closeSavingsLocation, createSavingsGoal,
  createSavingsLocation, dayLabel, goalProgressFor, parseKesToCents, setLocationBalance,
} from "@yako/core";
import { asDbAdapter } from "../../db/open";
import { C, Card, Empty, Pill, SectionTitle, kes, text } from "../../ui";
import { Button, Chip, Field, Hint, Label, Meter, Row, Sheet, Wrap, dateLabel } from "./parts";

const RAILS: Array<[SavingsRail, string]> = [
  ["mshwari", "M-Shwari"], ["kcb_mpesa", "KCB M-Pesa"], ["bank", "Bank"], ["mmf", "Money market fund (Ziidi)"],
  ["sacco", "SACCO"], ["mpesa_pot", "Pot inside M-Pesa"], ["cash", "Cash"], ["other", "Other"],
];
const railName = (r: SavingsRail) => RAILS.find(([k]) => k === r)?.[1] ?? r;

export function SavingsSection({ db, locations, goals, now, onChanged }: { db: SQLiteDatabase; locations: SavingsLocation[]; goals: SavingsGoal[]; now: number; onChanged: () => void }) {
  const a = asDbAdapter(db);
  const [loc, setLoc] = useState<SavingsLocation | "new" | null>(null);
  const [goal, setGoal] = useState<SavingsGoal | "new" | null>(null);
  const guard = (fn: () => void) => { try { fn(); onChanged(); } catch (e) { Alert.alert("Could not save", e instanceof Error ? e.message : "Try again."); } };
  const total = locations.filter((l) => !l.isVirtual).reduce((s, l) => s + l.balanceCents, 0);

  return (
    <>
      <Card style={{ marginTop: 14 }}>
        <Text style={text(11, C.muted, "700")}>SAVED OUTSIDE YOUR WALLET</Text>
        <Text style={[text(26, C.text, "700"), { marginTop: 4 }]} maxFontSizeMultiplier={1.5}>{kes(total)}</Text>
        <Hint>A pot inside M-Pesa is a note to yourself, not a lock. The money can still be spent, and Fuliza repayment takes from any money you receive.</Hint>
      </Card>

      <SectionTitle right={<Button label="Add" kind="ghost" a11yLabel="Add a savings place" onPress={() => setLoc("new")} />}>Where it is kept</SectionTitle>
      {locations.length === 0 ? <Card><Hint>M-Shwari, KCB M-Pesa, a bank, a fund, a SACCO or a pot inside M-Pesa. Add where you keep savings.</Hint></Card> : locations.map((l) => (
        <Card key={l.id} style={{ marginBottom: 10 }}>
          <Row
            left={<><Text style={text(15, C.text, "700")}>{l.name}</Text><Text style={[text(12, C.muted), { marginTop: 2 }]}>{railName(l.rail)}{l.balanceAt ? ` · updated ${dateLabel(l.balanceAt)}` : ""}</Text></>}
            right={<Text style={text(15, C.text, "700")}>{kes(l.balanceCents)}</Text>} />
          {l.isVirtual && <View style={{ marginTop: 8 }}><Pill label="Bookkeeping only, not locked" tone="amber" /></View>}
          <Wrap style={{ marginTop: 8 }}><Button label="Update balance" kind="soft" onPress={() => setLoc(l)} a11yLabel={`Update balance for ${l.name}`} /></Wrap>
        </Card>
      ))}

      <SectionTitle right={<Button label="Add" kind="ghost" a11yLabel="Add a savings goal" onPress={() => setGoal("new")} />}>Goals</SectionTitle>
      {goals.length === 0 ? <Card><Hint>Pick something to save for, say a target and a date. Pesanalysis shows if you are on pace.</Hint></Card> : goals.map((g) => {
        const p = goalProgressFor(g, now, null);
        const where = locations.find((l) => l.id === g.locationId);
        return (
          <Card key={g.id} style={{ marginBottom: 10 }}>
            <View accessible accessibilityLabel={`${g.name}. ${p.pct} percent. ${kes(g.savedCents)} of ${kes(g.targetCents)}.`}>
              <Row left={<Text style={text(15, C.text, "700")}>{g.name}</Text>} right={<Text style={text(14, p.achieved ? C.green : C.text, "700")}>{p.pct}%</Text>} />
              <Meter ratio={p.pct / 100} color={p.achieved ? C.green : C.blue} />
              <Text style={[text(12, C.muted), { marginTop: 6 }]}>{kes(g.savedCents)} of {kes(g.targetCents)}{where ? ` · in ${where.name}` : ""}</Text>
              {g.targetOn && <Text style={[text(12, p.behindPace ? C.amber : C.muted), { marginTop: 2 }]}>By {dayLabel(g.targetOn)}{p.requiredMonthlyCents != null && !p.achieved ? ` · needs about ${kes(p.requiredMonthlyCents)} a month` : ""}</Text>}
            </View>
            <Wrap style={{ marginTop: 8 }}><Button label="Set aside or take out" kind="soft" onPress={() => setGoal(g)} a11yLabel={`Change money set aside for ${g.name}`} /></Wrap>
          </Card>
        );
      })}

      {loc && <LocationSheet loc={loc === "new" ? null : loc} onClose={() => setLoc(null)}
        onSave={(f) => { guard(() => { if (loc === "new") createSavingsLocation(a, f); else setLocationBalance(a, loc.id, f.balanceCents ?? 0); }); setLoc(null); }}
        onClose2={loc !== "new" ? () => { guard(() => closeSavingsLocation(a, loc.id)); setLoc(null); } : undefined} />}
      {goal && <GoalSheet goal={goal === "new" ? null : goal} locations={locations} onClose={() => setGoal(null)}
        onCreate={(g) => { guard(() => createSavingsGoal(a, g)); setGoal(null); }}
        onAdjust={(delta) => { guard(() => {
          const g = goal as SavingsGoal;
          if (g.locationId != null) adjustLocation(a, g.locationId, delta);
          adjustGoal(a, g.id, delta);
        }); setGoal(null); }} />}
    </>
  );
}

function LocationSheet({ loc, onClose, onSave, onClose2 }: { loc: SavingsLocation | null; onClose: () => void; onSave: (f: { name: string; rail: SavingsRail; balanceCents: number }) => void; onClose2?: () => void }) {
  const [name, setName] = useState(loc?.name ?? "");
  const [rail, setRail] = useState<SavingsRail>(loc?.rail ?? "mshwari");
  const [bal, setBal] = useState(centsToInput(loc?.balanceCents));
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    const c = bal.trim() === "" ? 0 : parseKesToCents(bal);
    if (!name.trim()) return setErr("Give it a name.");
    if (c == null) return setErr("Enter the balance as numbers only.");
    onSave({ name, rail, balanceCents: c });
  };
  return (
    <Sheet title={loc ? loc.name : "Add a savings place"} onClose={onClose}>
      {!loc && (
        <>
          <Label>Type</Label>
          <Wrap>{RAILS.map(([k, l]) => <Chip key={k} label={l} selected={rail === k} onPress={() => { setRail(k); if (!name.trim() || RAILS.some(([, n]) => n === name)) setName(l); }} />)}</Wrap>
          {rail === "mpesa_pot" && <Hint>This is a note to yourself. The money stays in your wallet and can be spent.</Hint>}
          <Field label="Name" value={name} onChange={setName} />
        </>
      )}
      <Field label="Balance (KES)" value={bal} onChange={setBal} keyboard="decimal-pad" hint="Copy it from the latest statement or message." />
      {err && <Text accessibilityLiveRegion="polite" style={[text(13, C.red), { marginTop: 12 }]}>{err}</Text>}
      <Wrap style={{ marginTop: 20 }}>
        <Button label="Save" onPress={go} style={{ minWidth: 120 }} />
        {onClose2 && <Button label="Remove" kind="danger" onPress={onClose2} a11yLabel={`Remove ${loc?.name}`} />}
      </Wrap>
    </Sheet>
  );
}

function GoalSheet({ goal, locations, onClose, onCreate, onAdjust }: {
  goal: SavingsGoal | null; locations: SavingsLocation[]; onClose: () => void;
  onCreate: (g: { name: string; targetCents: number; locationId: number | null; horizon: "short" | "long"; targetOn: string | null }) => void; onAdjust: (deltaCents: number) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [on, setOn] = useState("");
  const [locId, setLocId] = useState<number | null>(null);
  const [horizon, setHorizon] = useState<"short" | "long">("short");
  const [amt, setAmt] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (goal) {
    const c = parseKesToCents(amt);
    const linked = locations.find((l) => l.id === goal.locationId);
    return (
      <Sheet title={goal.name} onClose={onClose}>
        <Text style={[text(13, C.muted), { marginTop: 8 }]}>{kes(goal.savedCents)} of {kes(goal.targetCents)}</Text>
        <Field label="Amount (KES)" value={amt} onChange={setAmt} keyboard="decimal-pad"
          hint={linked ? `Also changes the balance of ${linked.name}.${linked.isVirtual ? " It stays in your wallet and can be spent." : ""}` : "This only changes the goal, not any balance."} />
        {err && <Text accessibilityLiveRegion="polite" style={[text(13, C.red), { marginTop: 12 }]}>{err}</Text>}
        <Wrap style={{ marginTop: 16 }}>
          <Button label="Set aside" disabled={c == null || c <= 0} onPress={() => c && onAdjust(c)} />
          <Button label="Take out" kind="soft" disabled={c == null || c <= 0} onPress={() => { if (c) { if (c > goal.savedCents) return setErr("That is more than is set aside."); onAdjust(-c); } }} />
        </Wrap>
      </Sheet>
    );
  }
  const go = () => {
    const t = parseKesToCents(target);
    if (!name.trim()) return setErr("Give the goal a name.");
    if (t == null || t <= 0) return setErr("Enter the target as numbers only.");
    if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) return setErr("Enter the date as year-month-day, like 2027-03-31, or leave it empty.");
    onCreate({ name, targetCents: t, locationId: locId, horizon, targetOn: on || null });
  };
  return (
    <Sheet title="Add a goal" onClose={onClose}>
      <Field label="Name" value={name} onChange={setName} placeholder="School fees" />
      <Field label="Target (KES)" value={target} onChange={setTarget} keyboard="decimal-pad" />
      <Field label="Target date (optional)" value={on} onChange={setOn} placeholder="2027-03-31" keyboard="numbers-and-punctuation" hint="Year-month-day." />
      <Label>Time frame</Label>
      <Wrap><Chip label="Short term" selected={horizon === "short"} onPress={() => setHorizon("short")} /><Chip label="Long term" selected={horizon === "long"} onPress={() => setHorizon("long")} /></Wrap>
      {locations.length > 0 && (
        <>
          <Label>Kept in (optional)</Label>
          <Wrap>
            <Chip label="Not linked" selected={locId == null} onPress={() => setLocId(null)} />
            {locations.map((l) => <Chip key={l.id} label={l.name} selected={locId === l.id} onPress={() => setLocId(l.id)} />)}
          </Wrap>
        </>
      )}
      {err && <Text accessibilityLiveRegion="polite" style={[text(13, C.red), { marginTop: 12 }]}>{err}</Text>}
      <Wrap style={{ marginTop: 20 }}><Button label="Save goal" onPress={go} /></Wrap>
    </Sheet>
  );
}
