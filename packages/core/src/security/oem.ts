/**
 * OEM background-restriction guidance (A13, F-CAPTURE 1). Pure tables: the app passes Device brand/manufacturer
 * and gets the exact menu path for that ROM. Paths are best-effort per ROM generation (OEMs rename them), so every
 * entry also carries the stock Android fallback. The app can never grant these exemptions itself.
 */
export type OemFamily =
  | "transsion" | "xiaomi" | "oppo" | "realme" | "vivo" | "huawei" | "honor" | "samsung" | "oneplus" | "motorola" | "nothing" | "stock";

export type OemRisk = "high" | "medium" | "low";

export interface OemGuidance {
  family: OemFamily;
  /** Human label for the ROM, e.g. "Tecno / Infinix / itel (HiOS, XOS, itelOS)". */
  label: string;
  /** How likely the ROM is to kill a closed app's SMS receiver. */
  risk: OemRisk;
  /** Ordered, imperative steps. First step always starts from the phone's own Settings app. */
  steps: string[];
  /** One sentence on why this matters for capture. */
  why: string;
  /** Which system screen the app can open for the user. */
  settingsTarget: "battery_optimization" | "app_details";
}

const STOCK_STEPS = [
  "Open Settings, then Apps, then Pesanalysis, then Battery.",
  "Choose Unrestricted (also shown as 'Don't optimise' or 'No restrictions').",
  "Leave 'Pause app activity if unused' switched off.",
];

const TABLE: Record<OemFamily, Omit<OemGuidance, "family">> = {
  transsion: {
    label: "Tecno / Infinix / itel (HiOS, XOS, itelOS)",
    risk: "high",
    why: "These ROMs freeze apps that are not in the foreground, which stops text messages from reaching Pesanalysis while it is closed.",
    settingsTarget: "battery_optimization",
    steps: [
      "Open Settings, then Apps, then Pesanalysis, then Battery usage (or 'Power consumption').",
      "Choose No restrictions (or 'Unrestricted').",
      "Open the Phone Master / Phone Manager app, then Auto-start management (or 'Autostart'), and switch Pesanalysis on.",
      "Open Settings, then Battery, then Hiber / App freeze (name varies), and make sure Pesanalysis is NOT in the list.",
      "In the recent-apps screen, pull the Pesanalysis card down (or tap the lock icon) so 'clear all' does not kill it.",
    ],
  },
  xiaomi: {
    label: "Xiaomi / Redmi / POCO (MIUI, HyperOS)",
    risk: "high",
    why: "MIUI and HyperOS block autostart and aggressively stop background apps, so captures can be missed while Pesanalysis is closed.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Apps, then Manage apps, then Pesanalysis.",
      "Switch Autostart on.",
      "Tap Battery saver and choose No restrictions.",
      "In the recent-apps screen, long-press the Pesanalysis card and tap the lock icon.",
    ],
  },
  oppo: {
    label: "OPPO (ColorOS)",
    risk: "high",
    why: "ColorOS kills background apps unless they are allowed to auto-launch and run in the background.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Apps, then App management, then Pesanalysis.",
      "Under Battery usage switch Allow background activity on, and Allow auto-launch on.",
      "In the recent-apps screen, pull down on the Pesanalysis card to lock it.",
    ],
  },
  realme: {
    label: "realme (realme UI)",
    risk: "high",
    why: "realme UI restricts background apps and auto-launch the same way ColorOS does.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Apps, then App management, then Pesanalysis.",
      "Under Battery usage choose Allow background activity, and switch Allow auto-launch on.",
      "In the recent-apps screen, lock the Pesanalysis card.",
    ],
  },
  vivo: {
    label: "vivo / iQOO (Funtouch OS, OriginOS)",
    risk: "high",
    why: "Funtouch and OriginOS stop background apps unless they are allowed high background power consumption and autostart.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Battery, then Background power consumption, then Pesanalysis, and choose Allow.",
      "Open i Manager (or Settings, then Apps), then Autostart, and switch Pesanalysis on.",
      "In the recent-apps screen, lock the Pesanalysis card.",
    ],
  },
  huawei: {
    label: "Huawei (EMUI, HarmonyOS)",
    risk: "high",
    why: "EMUI closes apps when the screen turns off unless launch is managed manually.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Battery, then App launch.",
      "Switch Pesanalysis from Automatic to Manage manually.",
      "In the dialog switch on Auto-launch, Secondary launch and Run in background.",
    ],
  },
  honor: {
    label: "Honor (MagicOS)",
    risk: "high",
    why: "MagicOS limits background apps like EMUI.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Battery, then App launch.",
      "Switch Pesanalysis to Manage manually, then allow Auto-launch and Run in background.",
    ],
  },
  samsung: {
    label: "Samsung (One UI)",
    risk: "medium",
    why: "One UI puts rarely opened apps to sleep, which can delay captures.",
    settingsTarget: "battery_optimization",
    steps: [
      "Open Settings, then Battery, then Background usage limits.",
      "Make sure Pesanalysis is not under Sleeping apps or Deep sleeping apps.",
      "Open Settings, then Apps, then Pesanalysis, then Battery, and choose Unrestricted.",
    ],
  },
  oneplus: {
    label: "OnePlus (OxygenOS)",
    risk: "medium",
    why: "OxygenOS can optimise battery use of apps that are not opened often.",
    settingsTarget: "app_details",
    steps: [
      "Open Settings, then Apps, then Pesanalysis, then Battery usage.",
      "Choose Allow background activity (or Unrestricted).",
      "In the recent-apps screen, lock the Pesanalysis card.",
    ],
  },
  motorola: {
    label: "Motorola",
    risk: "low",
    why: "Near-stock Android; the standard battery setting is enough.",
    settingsTarget: "battery_optimization",
    steps: STOCK_STEPS,
  },
  nothing: {
    label: "Nothing (Nothing OS)",
    risk: "low",
    why: "Near-stock Android; the standard battery setting is enough.",
    settingsTarget: "battery_optimization",
    steps: STOCK_STEPS,
  },
  stock: {
    label: "Android",
    risk: "low",
    why: "Standard Android rarely blocks SMS receivers, but an unrestricted battery setting makes capture more dependable.",
    settingsTarget: "battery_optimization",
    steps: STOCK_STEPS,
  },
};

const MATCHERS: Array<[OemFamily, RegExp]> = [
  ["transsion", /\b(tecno|infinix|itel|transsion|spice|hot)\b/],
  ["xiaomi", /\b(xiaomi|redmi|poco|blackshark)\b/],
  ["realme", /\brealme\b/],
  ["oppo", /\b(oppo)\b/],
  ["oneplus", /\boneplus\b/],
  ["vivo", /\b(vivo|iqoo)\b/],
  ["honor", /\bhonor\b/],
  ["huawei", /\bhuawei\b/],
  ["samsung", /\bsamsung\b/],
  ["motorola", /\b(motorola|lenovo)\b/],
  ["nothing", /\bnothing\b/],
];

/** Maps Device.brand / Device.manufacturer (any case) to a ROM family. Unknown brands fall back to stock Android. */
export function detectOem(brand: string | null | undefined, manufacturer?: string | null): OemFamily {
  const hay = `${brand ?? ""} ${manufacturer ?? ""}`.toLowerCase();
  for (const [family, re] of MATCHERS) if (re.test(hay)) return family;
  return "stock";
}

export function oemGuidance(brand: string | null | undefined, manufacturer?: string | null): OemGuidance {
  const family = detectOem(brand, manufacturer);
  return { family, ...TABLE[family] };
}

/** Families for which the app should show the guidance card by default (not just in More). */
export function needsOemGuidance(g: OemGuidance): boolean { return g.risk !== "low"; }

/**
 * Whether to tell the user about "Allow restricted settings". Android 13+ blocks sideloaded apps from receiving
 * the SMS permission until the user allows it in the app's info screen. Play-installed builds are not affected.
 * `installer` is Application.getInstallReferrer-style source: "com.android.vending" for Play, otherwise sideloaded.
 */
export function restrictedSettingsLikely(sdk: number, installer: string | null | undefined): boolean {
  if (sdk < 33) return false;
  return installer !== "com.android.vending";
}

export const RESTRICTED_SETTINGS_STEPS = [
  "Open Settings, then Apps, then Pesanalysis (or long-press the app icon and tap App info).",
  "Tap the three-dot menu in the top right corner.",
  "Tap Allow restricted settings and confirm with your fingerprint or PIN. (The item only appears after Android has blocked a permission once, so try 'Allow SMS' first.)",
  "Go back to Pesanalysis and tap Allow SMS again.",
];
