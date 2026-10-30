import { useEffect, useRef, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { C, Btn, text } from "../ui";
import { attemptPin, lockedUntil } from "./settings";

/**
 * Full-screen lock. Content behind is not rendered while locked (C2). Biometrics use the device's own
 * enrolled credential; the PIN exists for devices without biometrics and as a fallback.
 */
export function AppLock({ onUnlock, strict }: { onUnlock: () => void; strict: boolean }) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [waitMs, setWaitMs] = useState(0);
  const [bio, setBio] = useState(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const until = await lockedUntil();
      if (alive) setWaitMs(Math.max(0, until - Date.now()));
      try {
        const hw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (alive && hw && enrolled) { setBio(true); void tryBio(); }
      } catch { /* no biometrics */ }
    })();
    tick.current = setInterval(() => setWaitMs((w) => Math.max(0, w - 1000)), 1000);
    return () => { alive = false; if (tick.current) clearInterval(tick.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tryBio = async () => {
    try {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Pesanalysis", cancelLabel: "Use PIN", disableDeviceFallback: true });
      if (r.success) onUnlock();
    } catch { /* fall back to PIN */ }
  };

  const submit = async () => {
    const r = await attemptPin(pin);
    setPin("");
    if (r.ok) { onUnlock(); return; }
    if (r.waitMs > 0) { setWaitMs(r.waitMs); setMsg("Too many attempts. Wait before trying again."); return; }
    setMsg(r.remaining > 0 ? `Wrong PIN. ${r.remaining} attempts left before a pause.` : "Wrong PIN.");
  };

  const waiting = waitMs > 0;
  return (
    <View style={{ ...StyleSheetAbsolute, backgroundColor: C.bg }} accessibilityViewIsModal accessibilityLabel="App locked">
      <Text style={text(26, C.text, "700")} maxFontSizeMultiplier={1.4} accessibilityRole="header">Pesanalysis is locked</Text>
      <Text style={[text(13, C.muted), { marginTop: 6, textAlign: "center", maxWidth: 320 }]}>
        {strict ? "Strict vault is on: new messages are held on this phone until you unlock." : "Your ledger stays encrypted on this phone."}
      </Text>
      {!waiting && (
        <TextInput
          value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={12}
          placeholder="PIN" placeholderTextColor={C.dim} accessibilityLabel="PIN"
          style={[text(22, C.text), { backgroundColor: C.card, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, marginTop: 22, width: 220, textAlign: "center", letterSpacing: 6 }]}
          onSubmitEditing={() => void submit()}
        />
      )}
      {msg && <Text accessibilityLiveRegion="polite" style={[text(12, C.amber), { marginTop: 10, textAlign: "center", maxWidth: 300 }]}>{msg}</Text>}
      {waiting && <Text accessibilityLiveRegion="polite" style={[text(13, C.muted), { marginTop: 10 }]}>Try again in {Math.ceil(waitMs / 1000)}s</Text>}
      <View style={{ marginTop: 18, width: 220 }}>
        <Btn label={waiting ? "Locked" : "Unlock"} kind="primary" disabled={waiting || pin.length < 4} onPress={() => void submit()} style={{ minHeight: 52 }} />
      </View>
      {bio && !waiting && (
        <TouchableOpacity onPress={() => void tryBio()} style={{ marginTop: 16, minHeight: 48, justifyContent: "center" }} accessibilityRole="button" accessibilityLabel="Unlock with biometrics">
          <Text style={text(13, C.blue, "600")}>Use fingerprint or face</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const StyleSheetAbsolute = { position: "absolute" as const, inset: 0, alignItems: "center" as const, justifyContent: "center" as const, padding: 24, zIndex: 100 };
