import Svg, { Path, Circle } from "react-native-svg";

export type TabIconName = "today" | "feed" | "plan" | "analyse" | "more";

/** Small stroke icon set drawn with react-native-svg (no extra icon dependency). */
export function TabIcon({ name, color, size = 22 }: { name: TabIconName; color: string; size?: number }) {
  const common = { stroke: color, strokeWidth: 1.8, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === "today" && <><Path d="M4 11.5 12 5l8 6.5" {...common} /><Path d="M6.5 10.5V19h11v-8.5" {...common} /><Path d="M10 19v-4.5h4V19" {...common} /></>}
      {name === "feed" && <><Path d="M5 6h14M5 12h14M5 18h9" {...common} /><Circle cx="18" cy="18" r="1.4" fill={color} stroke="none" /></>}
      {name === "plan" && <><Path d="M6 4.5h12v15H6z" {...common} /><Path d="M9 9h6M9 13h6M9 17h4" {...common} /></>}
      {name === "analyse" && <><Path d="M5 19V5" {...common} /><Path d="M5 19h14" {...common} /><Path d="M8 16v-5M12 16V8M16 16v-3M20 16V6" {...common} /></>}
      {name === "more" && <><Circle cx="6" cy="12" r="1.4" fill={color} stroke="none" /><Circle cx="12" cy="12" r="1.4" fill={color} stroke="none" /><Circle cx="18" cy="12" r="1.4" fill={color} stroke="none" /></>}
    </Svg>
  );
}
