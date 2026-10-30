import { useState } from "react";
import { Alert, Text } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { type BudgetPeriod, centsToInput, createBudget, dayLabel, deleteBudget, parseKesToCents, updateBudget, dayOf } from "@yako/core";
import { asDbAdapter } from "../../db/open";
import type { BudgetView } from "../../plan/data";
import { C, Card, SectionTitle, kes, text } from "../../ui";
import { Button, Chip, Field, Hint, Label, Meter, Row, Sheet, Wrap } from "./parts";

const PERIOD_WORD: Record<BudgetPeriod, string> = { weekly: "a week", monthly: "a month", custom: "per period" };

export function BudgetsSection({ db, items, labels, onChanged }: { db: SQLiteDatabase; items: BudgetView[]; labels: Array<{ id: number; name: string }>; onChanged: () => void }) {
  const a = asDbAdapter(db);
  const [edit, setEdit] = useState<BudgetView | "new" | null>(null);
  const guard = (fn: () => void) => { try { fn(); onChanged(); setEdit(null); } catch (e) { Alert.alert("Could not save", e instanceof Error ? e.message : "Try again."); } };
  return (
    <>
      <SectionTitle right={<Button label="Add" kind="ghost" a11yLabel="Add a budget" onPress={() => setEdit("new")} />}>Budgets</SectionTitle>
      {items.length === 0 && <Card><Hint>Set a limit for everything, or for one label like Food. Pesanalysis shows if your pace will break it.</Hint></Card>}
      {items.map((v) => {
        const p = v.pace, b = v.budget;
        const tone = p.status === "over" ? C.red : p.status === "at_risk" ? C.amber : C.green;
        const msg = p.status === "over" ? `Over by ${kes(p.spentCents - p.effectiveLimitCents)}`
          : p.status === "at_risk" ? `At this pace you will pass the limit${p.projectedBreachOn ? ` around ${dayLabel(p.projectedBreachOn)}` : ""}`
          : "On track";
        const scope = v.labelName ?? "Everything";
        return (
          <Card key={b.id} style={{ marginBottom: 10 }}>
            <Row
              left={<><Text style={text(15, C.text, "700")}>{b.name}</Text><Text style={[text(12, C.muted), { marginTop: 2 }]}>{scope} · {kes(b.limitCents)} {PERIOD_WORD[b.period]}{b.period === "custom" ? ` (${b.periodDays} days)` : ""}</Text></>}
              right={<Text style={text(13, tone, "700")}>{Math.round((p.spentCents / Math.max(1, p.effectiveLimitCents)) * 100)}%</Text>} />
            <Meter ratio={p.spentCents / Math.max(1, p.effectiveLimitCents)} mark={p.elapsedShare} color={tone} />
            <Text accessibilityLabel={`${b.name}. ${kes(p.spentCents)} spent of ${kes(p.effectiveLimitCents)}. ${msg}. Period ends ${dayLabel(p.bounds.endDay)}.`} style={[text(12, C.muted), { marginTop: 6 }]}>
              {kes(p.spentCents)} spent, {kes(p.remainingCents)} left. The white mark is how far through the period you are.
            </Text>
            <Text style={[text(13, tone, "600"), { marginTop: 4 }]}>{msg}</Text>
            <Wrap style={{ marginTop: 8 }}><Button label="Edit" kind="soft" onPress={() => setEdit(v)} a11yLabel={`Edit budget ${b.name}`} /></Wrap>
          </Card>
        );
      })}
      {edit && <BudgetForm v={edit === "new" ? null : edit} labels={labels} onClose={() => setEdit(null)}
        onSave={(f) => guard(() => { if (edit === "new") createBudget(a, f); else updateBudget(a, edit.budget.id, f); })}
        onDelete={edit !== "new" ? () => Alert.alert("Delete this budget?", "Your spending history is not affected.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => guard(() => deleteBudget(a, (edit as BudgetView).budget.id)) }]) : undefined} />}
    </>
  );
}

function BudgetForm({ v, labels, onClose, onSave, onDelete }: {
  v: BudgetView | null; labels: Array<{ id: number; name: string }>; onClose: () => void;
  onSave: (f: { name: string; period: BudgetPeriod; limitCents: number; labelId: number | null; periodDays: number | null; anchorOn: string | null; rollover: boolean }) => void; onDelete?: () => void;
}) {
  const b = v?.budget;
  const [name, setName] = useState(b?.name ?? "");
  const [limit, setLimit] = useState(centsToInput(b?.limitCents));
  const [period, setPeriod] = useState<BudgetPeriod>(b?.period ?? "monthly");
  const [days, setDays] = useState(String(b?.periodDays ?? 14));
  const [labelId, setLabelId] = useState<number | null>(b?.labelId ?? null);
  const [rollover, setRollover] = useState(!!b?.rollover);
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    const c = parseKesToCents(limit);
    if (!name.trim()) return setErr("Give the budget a name.");
    if (c == null || c <= 0) return setErr("Enter the limit as numbers only.");
    const d = Number(days);
    if (period === "custom" && (!Number.isInteger(d) || d < 1 || d > 365)) return setErr("Days must be 1 to 365.");
    onSave({ name, period, limitCents: c, labelId, periodDays: period === "custom" ? d : null, anchorOn: period === "custom" ? (b?.anchorOn ?? dayOf(Date.now())) : null, rollover });
  };
  return (
    <Sheet title={v ? "Edit budget" : "Add a budget"} onClose={onClose}>
      <Field label="Name" value={name} onChange={setName} placeholder="Food" />
      <Field label="Limit (KES)" value={limit} onChange={setLimit} keyboard="decimal-pad" />
      <Label>Repeats</Label>
      <Wrap>
        <Chip label="Every week" selected={period === "weekly"} onPress={() => setPeriod("weekly")} />
        <Chip label="Every month" selected={period === "monthly"} onPress={() => setPeriod("monthly")} />
        <Chip label="Custom days" selected={period === "custom"} onPress={() => setPeriod("custom")} />
      </Wrap>
      {period === "custom" && <Field label="Days in each period" value={days} onChange={setDays} keyboard="number-pad" />}
      <Label>What it covers</Label>
      <Wrap>
        <Chip label="Everything" selected={labelId == null} onPress={() => setLabelId(null)} />
        {labels.map((l) => <Chip key={l.id} label={l.name} selected={labelId === l.id} onPress={() => setLabelId(l.id)} />)}
      </Wrap>
      <Label>Unused money</Label>
      <Wrap>
        <Chip label="Starts fresh" selected={!rollover} onPress={() => setRollover(false)} />
        <Chip label="Carries over" selected={rollover} onPress={() => setRollover(true)} />
      </Wrap>
      {err && <Text accessibilityLiveRegion="polite" style={[text(13, C.red), { marginTop: 12 }]}>{err}</Text>}
      <Wrap style={{ marginTop: 20 }}>
        <Button label="Save" onPress={go} style={{ minWidth: 120 }} />
        {onDelete && <Button label="Delete" kind="danger" onPress={onDelete} />}
      </Wrap>
    </Sheet>
  );
}
