import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  createHabitCategory, createLabel, createRole, HABIT_CATEGORY_SUGGESTIONS, listHabits, listLabelsFull, listRolesFull,
  renameHabit, renameLabel, renameRole, type HabitRow, type LabelRow, type RoleRow,
} from "@yako/core";
import { asDbAdapter } from "../db/open";
import { Btn, C, Card, Pill, text } from "../ui";

export function TaxonomyEditor({ db, onChanged }: { db: SQLiteDatabase; onChanged: () => void }) {
  const [labels, setLabels] = useState<LabelRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [pickLabel, setPickLabel] = useState<LabelRow | null>(null);
  const [pickRole, setPickRole] = useState<RoleRow | null>(null);
  const [labelName, setLabelName] = useState("");
  const [roleName, setRoleName] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newRole, setNewRole] = useState("");
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [newHabit, setNewHabit] = useState("");

  const load = () => {
    try {
      const a = asDbAdapter(db);
      setLabels(listLabelsFull(a)); setRoles(listRolesFull(a)); setHabits(listHabits(a, "all"));
    } catch { setLabels([]); setRoles([]); }
  };
  useEffect(load, [db]);

  const saveLabel = () => {
    if (!pickLabel || !labelName.trim()) return;
    try {
      renameLabel(asDbAdapter(db), pickLabel.id, labelName);
      setPickLabel(null); setLabelName(""); load(); onChanged();
    } catch (e) { Alert.alert("Could not rename", String(e).slice(0, 160)); }
  };
  const addLabel = () => {
    if (!newLabel.trim()) return;
    try {
      createLabel(asDbAdapter(db), newLabel, "Expenses");
      setNewLabel(""); load(); onChanged();
    } catch (e) { Alert.alert("Could not add category", String(e).slice(0, 160)); }
  };
  const saveRole = () => {
    if (!pickRole || !roleName.trim()) return;
    try {
      renameRole(asDbAdapter(db), pickRole.id, roleName);
      setPickRole(null); setRoleName(""); load(); onChanged();
    } catch (e) { Alert.alert("Could not rename role", String(e).slice(0, 160)); }
  };
  const addHabit = (name: string) => {
    if (!name.trim()) return;
    try {
      createHabitCategory(asDbAdapter(db), name);
      setNewHabit(""); load(); onChanged();
    } catch (e) { Alert.alert("Could not add habit category", String(e).slice(0, 160)); }
  };
  const addRole = () => {
    if (!newRole.trim()) return;
    try {
      createRole(asDbAdapter(db), newRole);
      setNewRole(""); load(); onChanged();
    } catch (e) { Alert.alert("Could not add role", String(e).slice(0, 160)); }
  };

  return (
    <View>
      <Text style={[text(11, C.muted), { lineHeight: 17 }]}>
        Names are yours. Renaming a category or role does not change any past payment. Create one if the list does not fit.
      </Text>

      <Text style={[text(11, C.muted, "700"), { marginTop: 14 }]}>CATEGORIES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 7 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {labels.slice(0, 30).map((l) => (
            <TouchableOpacity key={l.id} onPress={() => { setPickLabel(l); setLabelName(l.name); }}>
              <Pill label={`${l.name} · ${l.txCount}`} tone={pickLabel?.id === l.id ? "blue" : "dim"} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      {pickLabel && (
        <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
          <TextInput value={labelName} onChangeText={setLabelName} placeholder="New category name" placeholderTextColor={C.dim}
            style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
          <Btn label="Save" kind="soft" onPress={saveLabel} style={{ paddingVertical: 7, paddingHorizontal: 12 }} />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
        <TextInput value={newLabel} onChangeText={setNewLabel} placeholder="Add a category" placeholderTextColor={C.dim}
          style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
        <Btn label="Add" kind="soft" onPress={addLabel} style={{ paddingVertical: 7, paddingHorizontal: 12 }} />
      </View>

      <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>HABIT CATEGORIES</Text>
      <Text style={[text(10, C.dim), { marginTop: 3, lineHeight: 15 }]}>
        A habit category groups things you want to watch, like tobacco or takeaway. Accepting one moves matching items without changing any past payment.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 7 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {HABIT_CATEGORY_SUGGESTIONS.filter((s) => !habits.some((h) => h.name.toLowerCase() === s.name.toLowerCase())).map((s) => (
            <TouchableOpacity key={s.name} onPress={() => addHabit(s.name)}>
              <Pill label={`+ ${s.name}`} tone="dim" />
            </TouchableOpacity>
          ))}
          {habits.map((h) => (
            <TouchableOpacity key={h.id} onPress={() => { const n = h.name; renameHabit(asDbAdapter(db), h.id, n); }}>
              <Pill label={`${h.name}${h.status !== "active" ? ` · ${h.status}` : ""}`} tone="blue" />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
        <TextInput value={newHabit} onChangeText={setNewHabit} placeholder="New habit category" placeholderTextColor={C.dim}
          style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
        <Btn label="Add" kind="soft" onPress={() => addHabit(newHabit)} style={{ paddingVertical: 7, paddingHorizontal: 12 }} />
      </View>

      <Text style={[text(11, C.muted, "700"), { marginTop: 18 }]}>PEOPLE ROLES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 7 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {roles.map((r) => (
            <TouchableOpacity key={r.id} onPress={() => { setPickRole(r); setRoleName(r.name); }}>
              <Pill label={`${r.name}${r.people ? ` · ${r.people}` : ""}`} tone={pickRole?.id === r.id ? "blue" : "dim"} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      {pickRole && (
        <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
          <TextInput value={roleName} onChangeText={setRoleName} placeholder="New role name" placeholderTextColor={C.dim}
            style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
          <Btn label="Save" kind="soft" onPress={saveRole} style={{ paddingVertical: 7, paddingHorizontal: 12 }} />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 7, marginTop: 8 }}>
        <TextInput value={newRole} onChangeText={setNewRole} placeholder="Add a role" placeholderTextColor={C.dim}
          style={[text(12, C.text), { flex: 1, backgroundColor: C.card2, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 }]} />
        <Btn label="Add" kind="soft" onPress={addRole} style={{ paddingVertical: 7, paddingHorizontal: 12 }} />
      </View>
    </View>
  );
}
