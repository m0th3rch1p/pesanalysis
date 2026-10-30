import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import { Btn, C, Card, Pill, text } from "../ui";
import { MODELS, fetchModel, listCachedModels, localPath, verifyLocalModel, ping, loadLocal, complete, ocrImage, shutdown, ModelMissingError, type ModelSpec } from "../qvac";
import { receiptFixturePath } from "../ai/receipt-fixture";

/**
 * One-time model setup (D118). Downloads are network-only and explicit; every model is
 * optional. Verification loads each model once and runs a tiny generation on the phone.
 */
type GroupKey = "explain" | "swahili" | "receipt";

interface Group { key: GroupKey; title: string; why: string; specs: ModelSpec[] }

const GROUPS: Group[] = [
  { key: "explain", title: "Explanations", why: "Rewrites findings and habit results in plain language on the phone.", specs: [MODELS.qwen3_06b!] },
  { key: "swahili", title: "Kiswahili", why: "Translates explanations and answers into Kiswahili.", specs: [MODELS.afri_08b_q4!] },
  { key: "receipt", title: "Receipt reading", why: "Reads printed till receipts into items and checks the total.", specs: [MODELS.ocr_latin!, MODELS.ocr_craft!] },
];

const mb = (n: number) => `${(n / 1_000_000).toFixed(0)} MB`;
const bytesOf = (specs: ModelSpec[]) => specs.reduce((n, s) => n + s.size, 0);

export function Models({ db, onDone, onSkip }: { db: SQLiteDatabase; onDone: () => void; onSkip: () => void }) {
  const [picked, setPicked] = useState<Record<GroupKey, boolean>>({ explain: true, swahili: true, receipt: true });
  const [phase, setPhase] = useState<"choose" | "working" | "verify" | "done">("choose");
  const [line, setLine] = useState("");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [verified, setVerified] = useState<Record<string, "ok" | "failed" | "cached">>({});
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    try { setFree(Paths.availableDiskSpace); } catch { setFree(null); }
  }, []);

  const selected = useMemo(() => GROUPS.filter((g) => picked[g.key]), [picked]);
  const missing = useMemo(() => selected.flatMap((g) => g.specs).filter((s) => !localPath(s)), [selected]);
  const needed = useMemo(() => bytesOf(missing), [missing]);
  const short = free != null && needed * 1.5 > free;

  const run = async () => {
    setError(null); setPhase("working"); setPct(0);
    const failed = new Set<string>();
    try {
      setLine("Starting the on-device engine…");
      await ping().catch(() => undefined);
      for (const g of selected) {
        for (const spec of g.specs) {
          const already = localPath(spec);
          const key = spec.key;
          if (already) {
            setLine(`Checking the installed ${spec.file}…`);
            const check = await verifyLocalModel(spec);
            if (check.ok) { setVerified((v) => ({ ...v, [key]: "cached" })); continue; }
            failed.add(key);
            setVerified((v) => ({ ...v, [key]: "failed" }));
            try { new File(`file://${already.path}`).delete(); } catch { /* re-download below if possible */ }
          }
          setLine(`Downloading ${spec.file} (${mb(spec.size)})…`);
          let last = -1;
          await fetchModel(spec, (p) => {
            const r = Math.round(p);
            if (r !== last) { last = r; setPct(r); }
          });
          const check = localPath(spec);
          if (!check) throw new Error(`the file for ${spec.file} did not arrive`);
          failed.delete(key);
          setVerified((v) => ({ ...v, [key]: "ok" }));
        }
      }
      // Verify a completion model per group. Loading is CPU-bound; keep the UI honest.
      setPhase("verify");
      for (const g of selected) {
        const completion = g.specs.find((s) => s.kind === "completion");
        if (!completion || !localPath(completion)) continue;
        setLine(`Checking ${completion.file} on this phone…`);
        try {
          const loaded = await loadLocal(completion, { ctxSize: 512 });
          await complete(loaded.modelId, { user: "Reply with OK.", predict: 2, temp: 0, timeoutMs: 120_000 });
          setVerified((v) => ({ ...v, [completion.key]: "ok" }));
        } catch {
          failed.add(completion.key);
          setVerified((v) => ({ ...v, [completion.key]: "failed" }));
        }
      }
      if (selected.some((g) => g.key === "receipt") && localPath(MODELS.ocr_latin!) && localPath(MODELS.ocr_craft!)) {
        setLine("Checking receipt reading on a test slip…");
        try {
          const loaded = await loadLocal(MODELS.ocr_latin, {});
          const out = await ocrImage(loaded.modelId, await receiptFixturePath(), { timeoutMs: 180_000 });
          const text = out.blocks.map((b) => b.text).join(" ").toUpperCase();
          if (!/TOTAL|130|NAIVAS/.test(text)) throw new Error("test receipt text not recognised");
          setVerified((v) => ({ ...v, ocr_latin: "ok", ocr_craft: "ok" }));
        } catch {
          failed.add("ocr_latin"); failed.add("ocr_craft");
          setVerified((v) => ({ ...v, ocr_latin: "failed", ocr_craft: "failed" }));
        }
      }
      for (const g of selected) for (const spec of g.specs) {
        if (!localPath(spec) || failed.has(spec.key)) continue;
        db.runSync(`INSERT INTO meta (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'`, [`model_ready_${spec.key}`]);
      }
      // Release the worker so onboarding does not sit on ~1 GB of model memory.
      await shutdown(20_000).catch(() => undefined);
      if (failed.size) {
        setError("Some models downloaded but did not pass the on-device check. Free space, reconnect, and try those models again.");
        setPhase("choose"); setLine("");
      } else { setPhase("done"); setLine(""); }
    } catch (e) {
      await shutdown(10_000).catch(() => undefined);
      setError(e instanceof ModelMissingError ? `Missing ${e.file}. Check your connection and try again.` : "Download failed. Check your connection and free space, then try again.");
      setPhase("choose");
    }
  };

  const toggle = (k: GroupKey) => setPicked((p) => ({ ...p, [k]: !p[k] }));

  if (skipped || phase === "done") {
    return (
      <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
        <Text style={text(24, C.text, "700")} accessibilityRole="header">{skipped ? "Models later" : "On-device models ready"}</Text>
        <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>
          {skipped
            ? "You can download models any time from More → On-device intelligence. Everything except model help works without them."
            : "You can test them offline now. The app will only load a model when you ask for an explanation, translation or receipt."}
        </Text>
        <View style={{ marginTop: 18 }}>
          <Text style={text(11, C.dim)}>Installed on this phone</Text>
          {listCachedModels().slice(0, 12).map((f) => (
            <Text key={f.path} style={[text(11, C.muted), { marginTop: 4 }]}>• {f.name} · {mb(f.size)}</Text>
          ))}
          {listCachedModels().length === 0 && <Text style={[text(11, C.dim), { marginTop: 4 }]}>No models installed yet.</Text>}
        </View>
        <View style={{ marginTop: 20 }}><Btn label="Continue" kind="primary" onPress={onDone} style={{ minHeight: 52 }} /></View>
        {skipped && <TouchableOpacity onPress={() => { setSkipped(false); setPhase("choose"); }} style={{ marginTop: 10, minHeight: 44, justifyContent: "center" }}><Text style={text(12, C.blue)}>Choose models instead</Text></TouchableOpacity>}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
      <Text style={text(24, C.text, "700")} accessibilityRole="header">On-device intelligence</Text>
      <Text style={[text(14, C.muted), { marginTop: 8, lineHeight: 21 }]}>
        These run entirely on this phone. Download once; after that they work with the network off. Nothing is sent anywhere.
      </Text>
      {free != null && <Text style={[text(11, short ? C.amber : C.dim), { marginTop: 8 }]}>{mb(free)} free on this phone · {mb(needed)} selected</Text>}
      <Text style={[text(11, C.dim), { marginTop: 4 }]}>Downloads work on mobile data; Wi-Fi is faster for these files. You can skip and add them later.</Text>

      {GROUPS.map((g) => {
        const on = picked[g.key];
        const done = g.specs.every((s) => verified[s.key] === "ok" || verified[s.key] === "cached");
        const failedGroup = g.specs.some((s) => verified[s.key] === "failed");
        return (
          <Card key={g.key} style={{ marginTop: 12, borderColor: on ? C.blue : C.line }}>
            <TouchableOpacity onPress={() => toggle(g.key)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: "row", alignItems: "center", minHeight: 44 }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: on ? C.blue : C.dim, backgroundColor: on ? C.blue : "transparent", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                {on && <Text style={text(13, "#fff", "700")}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={text(14, C.text, "600")}>{g.title}</Text>
                <Text style={[text(11, C.muted), { marginTop: 2, lineHeight: 16 }]}>{g.why}</Text>
              </View>
              <View style={{ alignItems: "flex-end", marginLeft: 8 }}>
                <Text style={text(10, C.dim)}>{mb(bytesOf(g.specs))}</Text>
                {done ? <Pill label={verified[g.specs[0]!.key] === "cached" ? "installed" : "ready"} tone="green" /> : failedGroup ? <Pill label="check failed" tone="amber" /> : null}
              </View>
            </TouchableOpacity>
          </Card>
        );
      })}

      {phase === "choose" && (
        <>
          {short && <Text style={[text(12, C.amber), { marginTop: 12 }]}>Not enough free space for the selected models. Unselect one, or free space and try again.</Text>}
          {error && <Text style={[text(12, C.amber), { marginTop: 12 }]}>{error}</Text>}
          <View style={{ marginTop: 18 }}>
            <Btn label={selected.length ? (needed ? `Download ${mb(needed)}` : "Check installed models") : "Continue without models"} kind="primary" disabled={short} onPress={() => selected.length ? void run() : onSkip()} style={{ minHeight: 52 }} />
          </View>
          <TouchableOpacity onPress={onSkip} style={{ marginTop: 12, minHeight: 48, justifyContent: "center" }} accessibilityRole="button">
            <Text style={text(12, C.dim)}>Skip for now (everything except model help works)</Text>
          </TouchableOpacity>
        </>
      )}

      {(phase === "working" || phase === "verify") && (
        <Card style={{ marginTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ActivityIndicator color={C.blue} />
            <Text style={[text(12, C.text), { flex: 1 }]}>{line}</Text>
          </View>
          {phase === "working" && (
            <View style={{ marginTop: 10, height: 6, borderRadius: 3, backgroundColor: C.card2, overflow: "hidden" }}>
              <View style={{ width: `${Math.max(1, Math.min(100, pct))}%`, height: 6, backgroundColor: C.blue }} />
            </View>
          )}
          {phase === "verify" && <Text style={[text(10, C.dim), { marginTop: 8 }]}>Loading a model the first time can take a minute on this phone.</Text>}
        </Card>
      )}
    </ScrollView>
  );
}
