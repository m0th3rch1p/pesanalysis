import type { ReactNode } from "react";
import { Text, TouchableOpacity, View, type TextStyle, type ViewStyle } from "react-native";
import { formatKes } from "@yako/core";

export const C = {
  bg: "#0B0B0F",
  card: "#15151C",
  card2: "#1E1E28",
  text: "#F2F2F7",
  muted: "#9A9AA6",
  dim: "#6B6B78",
  line: "#26262F",
  green: "#30D158",
  red: "#FF453A",
  blue: "#0A84FF",
  amber: "#FFD60A",
};

export const text = (size: number, color = C.text, weight: TextStyle["fontWeight"] = "400"): TextStyle => ({
  color, fontSize: size, fontWeight: weight,
});

export function kes(c: number): string {
  return formatKes(c).replace(/\.00$/, "");
}

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flex: 1, backgroundColor: C.bg }, style]}>{children}</View>;
}

export function Card({ children, style, tone }: { children: ReactNode; style?: ViewStyle; tone?: "card" | "card2" }) {
  return (
    <View style={[{ backgroundColor: tone === "card2" ? C.card2 : C.card, borderRadius: 18, padding: 16 }, style]}>
      {children}
    </View>
  );
}

export function Btn({
  label, onPress, kind = "primary", style, disabled,
}: { label: string; onPress: () => void; kind?: "primary" | "ghost" | "soft"; style?: ViewStyle; disabled?: boolean }) {
  const bg = kind === "primary" ? C.blue : kind === "soft" ? C.card2 : "transparent";
  const color = kind === "primary" ? "#fff" : kind === "soft" ? C.text : C.blue;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[{ backgroundColor: bg, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 18, minHeight: 48, justifyContent: "center", alignItems: "center", opacity: disabled ? 0.5 : 1 }, style]}
    >
      <Text style={text(15, color, "600")}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Pill({ label, tone = "dim" }: { label: string; tone?: "dim" | "green" | "blue" | "amber" | "red" }) {
  const color = tone === "green" ? C.green : tone === "blue" ? "#7AB8FF" : tone === "amber" ? C.amber : tone === "red" ? C.red : C.muted;
  return (
    <View style={{ backgroundColor: `${color}1A`, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3, alignSelf: "flex-start" }}>
      <Text style={text(11, color, "600")}>{label}</Text>
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 26, marginBottom: 10 }}>
      <Text style={text(13, C.muted, "600")}>{children}</Text>
      {right}
    </View>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 48, paddingHorizontal: 24 }}>
      <Text style={text(17, C.text, "600")}>{title}</Text>
      <Text style={[text(13, C.muted), { textAlign: "center", marginTop: 6, lineHeight: 19 }]}>{body}</Text>
    </View>
  );
}
