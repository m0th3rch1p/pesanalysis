/**
 * Hidden Model lab. Rendered by App.tsx ONLY when the build-time dev flag EXPO_PUBLIC_YAKO_LAB=1 is set
 * (the flag is inlined by Metro, so a normal build contains neither this file nor QVAC).
 * Opens from a tiny "LAB" chip, or by deep link, which lets a host script drive suites without touching the screen:
 *   adb shell am start -a android.intent.action.VIEW -d 'yako://lab?suite=laya,translate&models=laya_ml_322m'
 */
import { useEffect, useRef, useState } from "react";
import { Linking, Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";

type Log = string[];

function parse(url: string): { suite: string; params: Record<string, string> } | null {
  const m = /^yako:\/\/lab\/?\??(.*)$/.exec(url);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const kv of m[1].split("&").filter(Boolean)) {
    const i = kv.indexOf("=");
    params[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? "1" : decodeURIComponent(kv.slice(i + 1));
  }
  const suite = params.suite ?? "";
  delete params.suite;
  return { suite, params };
}

export default function LabGate() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Log>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const push = (s: string) => { console.log(`[lab] ${s}`); setLog((l) => [...l.slice(-60), s]); };

  const go = async (suite: string, params: Record<string, string>) => {
    if (running.current) { push("busy: a suite is already running"); return; }
    running.current = true; setBusy(true); setOpen(true);
    try {
      const { runSuites } = await import("./suites");
      await runSuites(suite, params, push);
    } catch (e) { push(`ERROR ${String(e)}`); }
    finally { running.current = false; setBusy(false); }
  };

  useEffect(() => {
    const handle = (url: string | null | undefined) => { const p = url && parse(url); if (p && p.suite) void go(p.suite, p.params); else if (p) setOpen(true); };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  const quick: Array<[string, string, Record<string, string>]> = [
    ["sys", "sys", {}], ["verify", "verify", {}], ["laya 322M", "laya", { models: "laya_ml_322m" }],
    ["translate Q4 (3 items)", "translate", { models: "afri_08b_q4", limit: "3", variants: "plain,sq" }], ["qwen", "qwen", {}],
  ];

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} style={{ position: "absolute", right: 6, top: 40, backgroundColor: "#552", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, opacity: 0.6 }}>
        <Text style={{ color: "#fd6", fontSize: 9 }}>LAB</Text>
      </TouchableOpacity>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: "#0B0B0F", paddingTop: 40, padding: 12 }}>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>Model lab (developer)</Text>
          <Text style={{ color: "#9aa", fontSize: 11, marginBottom: 8 }}>CPU only. Local-path loads. {busy ? "RUNNING..." : "idle"}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {quick.map(([label, s, p]) => (
              <TouchableOpacity key={label} disabled={busy} onPress={() => void go(s, p)} style={{ backgroundColor: busy ? "#333" : "#1f3a5f", padding: 8, borderRadius: 6 }}>
                <Text style={{ color: "#fff", fontSize: 12 }}>{label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setOpen(false)} style={{ backgroundColor: "#444", padding: 8, borderRadius: 6 }}><Text style={{ color: "#fff", fontSize: 12 }}>Close</Text></TouchableOpacity>
          </View>
          <ScrollView style={{ marginTop: 10 }}>
            {log.map((l, i) => <Text key={i} style={{ color: "#cdd", fontSize: 10, fontFamily: "monospace" }}>{l}</Text>)}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
