import type { ReactNode } from "react";
import { Modal, ScrollView, Text, TextInput, TouchableOpacity, View, type KeyboardTypeOptions, type ViewStyle } from "react-native";
import { C, text } from "../../ui";

/** Every interactive element here is at least 48dp tall and wide, grows with font scale, and carries role/label/state. */
export const MIN = 48;

export function Button({ label, onPress, kind = "primary", disabled, a11yLabel, style }: {
  label: string; onPress: () => void; kind?: "primary" | "soft" | "ghost" | "danger"; disabled?: boolean; a11yLabel?: string; style?: ViewStyle;
}) {
  const bg = kind === "primary" ? C.blue : kind === "soft" ? C.card2 : "transparent";
  const color = kind === "primary" ? "#fff" : kind === "danger" ? C.red : kind === "soft" ? C.text : C.blue;
  return (
    <TouchableOpacity
      onPress={onPress} disabled={disabled} activeOpacity={0.75}
      accessibilityRole="button" accessibilityLabel={a11yLabel ?? label} accessibilityState={{ disabled: !!disabled }}
      style={[{ minHeight: MIN, minWidth: MIN, backgroundColor: bg, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.5 : 1 }, style]}
    >
      <Text style={[text(14, color, "600"), { textAlign: "center" }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Chip({ label, selected, onPress, a11yLabel }: { label: string; selected: boolean; onPress: () => void; a11yLabel?: string }) {
  return (
    <TouchableOpacity
      onPress={onPress} activeOpacity={0.75}
      accessibilityRole="button" accessibilityLabel={a11yLabel ?? label} accessibilityState={{ selected }}
      style={{ minHeight: MIN, minWidth: MIN, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 24, justifyContent: "center", alignItems: "center", backgroundColor: selected ? `${C.blue}33` : C.card2, borderWidth: 1, borderColor: selected ? C.blue : "transparent" }}
    >
      <Text style={[text(13, selected ? "#7AB8FF" : C.text, selected ? "700" : "500"), { textAlign: "center" }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Wrap({ children, gap = 8, style }: { children: ReactNode; gap?: number; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", flexWrap: "wrap", gap }, style]}>{children}</View>;
}

export function Field({ label, value, onChange, placeholder, keyboard, hint, error }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; keyboard?: KeyboardTypeOptions; hint?: string; error?: string | null;
}) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={text(12, C.muted, "600")}>{label}</Text>
      <TextInput
        value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.dim} keyboardType={keyboard}
        accessibilityLabel={label} accessibilityHint={hint}
        style={{ minHeight: MIN, marginTop: 6, backgroundColor: C.card2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 16, borderWidth: 1, borderColor: error ? C.red : "transparent" }}
      />
      {error ? <Text accessibilityLiveRegion="polite" style={[text(12, C.red), { marginTop: 4 }]}>{error}</Text> : hint ? <Text style={[text(11, C.dim), { marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={[text(12, C.muted, "600"), { marginTop: 16, marginBottom: 8 }]} accessibilityRole="header">{children}</Text>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000A", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: C.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "92%", paddingHorizontal: 18, paddingTop: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={[text(19, C.text, "700"), { flex: 1 }]} accessibilityRole="header" maxFontSizeMultiplier={1.6}>{title}</Text>
            <Button label="Close" kind="ghost" onPress={onClose} a11yLabel={`Close ${title}`} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function Meter({ ratio, mark, color }: { ratio: number; mark?: number; color: string }) {
  const r = Math.max(0, Math.min(1, ratio));
  return (
    <View style={{ height: 10, borderRadius: 5, backgroundColor: C.card2, overflow: "hidden", marginTop: 8 }} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={{ width: `${r * 100}%`, height: 10, backgroundColor: color }} />
      {mark != null && <View style={{ position: "absolute", left: `${Math.max(0, Math.min(1, mark)) * 100}%`, top: 0, width: 2, height: 10, backgroundColor: C.text }} />}
    </View>
  );
}

export function Row({ left, right, style }: { left: ReactNode; right?: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }, style]}>
      <View style={{ flex: 1, minWidth: 0 }}>{left}</View>
      {right}
    </View>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <Text style={[text(12, C.muted), { lineHeight: 18 }]}>{children}</Text>;
}

export function whenLabel(ms: number | null): string {
  if (ms == null) return "never";
  return new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Nairobi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { timeZone: "Africa/Nairobi", day: "numeric", month: "short" });
}
