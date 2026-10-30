/**
 * The ONLY QVAC surface in the app (D85). Rules that this file enforces:
 *  - Lazy: nothing here touches @qvac/sdk until a function is called. Importing this module costs nothing
 *    (the SDK is reached through `import()`, and the type import below is erased at build time).
 *  - Offline: models are loaded by LOCAL FILE PATH with modelFitPolicy "off". Registry/hf descriptors are only
 *    used by `fetchModel()` (dev time, network on).
 *  - CPU only: `device: "cpu"` everywhere (Mali-G57 is not a supported QVAC GPU; D26).
 *  - One worker (Bare worklet) per process; `unloadModel()` is unreliable on this SDK/device (Spike 16), so
 *    `unload()` is time-boxed and reports whether it resolved; `shutdown()` terminates the worklet.
 *  - Crash marker (F-QVAC rule 4): `beginInference()` / `endInference()` / `crashState()`.
 */
import { Directory, File, Paths } from "expo-file-system";
import { isAllowed, POLICY_MANIFEST } from "@yako/core";

type Sdk = typeof import("@qvac/sdk");

let sdkPromise: Promise<Sdk> | null = null;
/** First call spins up the SDK JS module (not the worker). The worker starts on the first RPC call. */
export function sdk(): Promise<Sdk> {
  return (sdkPromise ??= import("@qvac/sdk"));
}


export type ModelKind = "completion" | "decision" | "ocr";

export interface ModelSpec {
  /** Stable lab key. */
  key: string;
  kind: ModelKind;
  /** Name of the constant exported by @qvac/sdk (registry descriptor). */
  sdkName: string;
  /** File name inside the registry (the cache stores `<hash>_<file>`). */
  file: string;
  /** Bytes, from the SDK registry (used to verify the cached file). */
  size: number;
  sha256: string;
  licence: string;
  /** Model policy id (packages/core/src/models/policy.json), if different from sdkName. */
  policyId?: string;
  /** Direct download URL when the SDK registry has no constant for this checkpoint (verified from the model card). */
  url?: string;
}

/** Everything the lab may load. Sizes/hashes are the registry's own values (verified again by the lab `verify` suite). */
export const MODELS: Record<string, ModelSpec> = {
  laya_ml_322m: {
    key: "laya_ml_322m", kind: "decision", sdkName: "LAYA_MULTILINGUAL_322M_Q8_0", file: "laya-multilingual-Q8_0.gguf",
    size: 348425664, sha256: "59a61f840e6f125c25037f7cc0363efafee1aeea3394b504d25551b4bda5a219", licence: "see model card (convaiinnovations/laya-multilingual)",
  },
  laya_typed_421m: {
    key: "laya_typed_421m", kind: "decision", sdkName: "LAYA_TYPED_DECISIONS_421M_Q8_0", file: "laya-typed-decisions-Q8_0.gguf",
    size: 449919104, sha256: "72d5e753a4861f5532e0e3e065b9644ff6f6894efef82fa74af0898fa93ba899", licence: "see model card (convaiinnovations/laya-typed-decisions)",
  },
  afri_08b_q4: {
    key: "afri_08b_q4", kind: "completion", sdkName: "TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q4_K_M", file: "TranslatePsy-AfriSLM-0.8B-Q4_K_M-imat.gguf",
    size: 672329792, sha256: "4af8ee1df3ec9008f763ebe95e6f21df3acd8d42c541feeb13314ca22e560afc", licence: "Apache-2.0 (model card; distilled from an NLLB teacher whose synthetic data is CC-BY-NC, see model card)",
  },
  afri_08b_q8: {
    key: "afri_08b_q8", kind: "completion", sdkName: "TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q8_0", file: "TranslatePsy-AfriSLM-0.8B-Q8_0-imat.gguf",
    size: 1082015808, sha256: "b5056635be0c9bb832f0c964dc063bd4b4462e253f9f9d94eebf0aa0960b7798", licence: "Apache-2.0 (see afri_08b_q4)",
  },
  afri_2b_q4: {
    key: "afri_2b_q4", kind: "completion", sdkName: "TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M", file: "TranslatePsy-AfriSLM-2B-Q4_K_M-imat.gguf",
    size: 1560461376, sha256: "fc2a80532e58e0655efd9e68c5b7cb2c4373222e736bcc88de648502a4e30361", licence: "Apache-2.0 (see afri_08b_q4)",
  },
  qwen3_06b: {
    key: "qwen3_06b", kind: "completion", sdkName: "QWEN3_600M_INST_Q4", file: "Qwen3-0.6B-Q4_0.gguf",
    size: 382156480, sha256: "33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb", licence: "Apache-2.0", policyId: "QWEN3_600M_INST_Q4",
  },
  ocr_latin: {
    key: "ocr_latin", kind: "ocr", sdkName: "OCR_LATIN", file: "latin_g2.gguf",
    size: 15396512, sha256: "dd1c7a436e9175904e63683e939635892f45c8c6377d5e14e87cf8b175e10768", licence: "EasyOCR latin_g2 (Apache-2.0 upstream); ggml conversion by QVAC",
  },
  ocr_craft: {
    key: "ocr_craft", kind: "ocr", sdkName: "OCR_CRAFT", file: "craft_mlt_25k.gguf",
    size: 83133856, sha256: "74501993caf4581ce09b280f49a1b3d249c0f5a78496e047718b398457a875aa", licence: "CRAFT text detector (MIT upstream); ggml conversion by QVAC",
  },
};

// ---------------------------------------------------------------------------------------------- local files

export interface LocalFile { path: string; name: string; size: number }

/** All .gguf files the SDK has cached (HOME_DIR/.qvac/models). `path` has no `file://` prefix. */
export function listCachedModels(): LocalFile[] {
  const out: LocalFile[] = [];
  const walk = (dir: Directory, depth: number) => {
    if (depth > 4) return;
    let entries: (File | Directory)[] = [];
    try { if (!dir.exists) return; entries = dir.list(); } catch { return; }
    for (const e of entries) {
      try {
        if (e instanceof File) {
          if (e.name.toLowerCase().endsWith(".gguf")) out.push({ path: e.uri.replace(/^file:\/\//, ""), name: e.name, size: e.size ?? 0 });
        } else if (e instanceof Directory) walk(e, depth + 1);
      } catch { /* unreadable entry */ }
    }
  };
  walk(new Directory(Paths.document, ".qvac", "models"), 0);
  return out;
}

/** Cached file for a spec: `<hash>_<file>`. A size mismatch is never treated as installed. */
export function localPath(spec: ModelSpec): LocalFile | undefined {
  const hits = listCachedModels().filter((f) => f.name === spec.file || f.name.endsWith(`_${spec.file}`));
  if (!hits.length) return undefined;
  if (!spec.size) return hits[0];
  return hits.find((f) => f.size === spec.size);
}

/** Full size + SHA-256 check. Used before declaring a model ready; the digest is computed on-device. */
export async function verifyLocalModel(spec: ModelSpec): Promise<{ ok: boolean; path?: string; size?: number; sha256?: string; reason?: string }> {
  const f = localPath(spec);
  if (!f) return { ok: false, reason: "not installed" };
  if (spec.size && f.size !== spec.size) return { ok: false, path: f.path, size: f.size, reason: `size ${f.size} != ${spec.size}` };
  try {
    const sha256 = await new File(`file://${f.path}`).digest("SHA-256");
    if (spec.sha256 && sha256 !== spec.sha256) return { ok: false, path: f.path, size: f.size, sha256, reason: "sha256 mismatch" };
    return { ok: true, path: f.path, size: f.size, sha256 };
  } catch (e) {
    return { ok: false, path: f.path, size: f.size, reason: `digest failed: ${String(e)}` };
  }
}

// ---------------------------------------------------------------------------------------------- download (dev time)

/** Registry/hf download into the SDK cache. NETWORK REQUIRED. Returns the cached path. Not used at runtime. */
export async function fetchModel(spec: ModelSpec, onProgress?: (pct: number, bytes?: number) => void): Promise<{ path: string; ms: number }> {
  const s = await sdk();
  const src = spec.url ?? (s as unknown as Record<string, unknown>)[spec.sdkName];
  if (!src) throw new Error(`SDK has no registry constant ${spec.sdkName} and no URL for ${spec.key}`);
  const t0 = Date.now();
  const path = await withTimeout(s.downloadAsset({
    assetSrc: src as never,
    requireSecureTransport: true,
    onProgress: (p: { percentage?: number; downloaded?: number }) => onProgress?.(p.percentage ?? 0, p.downloaded),
  } as never), 15 * 60_000, `download ${spec.file}`);
  const clean = String(path).replace(/^file:\/\//, "");
  const check = await verifyLocalModel(spec);
  if (!check.ok) {
    try { new File(`file://${clean}`).delete(); } catch { /* leave it for the user to clear */ }
    throw new Error(`download verification failed for ${spec.file}: ${check.reason ?? "unknown"}`);
  }
  return { path: clean, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------- crash marker

const MARKER = () => new File(Paths.document, "qvac-marker.json");
interface MarkerState { inFlight: string | null; crashes: number }
function readMarker(): MarkerState {
  try { const f = MARKER(); if (f.exists) return JSON.parse(f.textSync()); } catch { /* corrupt marker = treat as clean */ }
  return { inFlight: null, crashes: 0 };
}
function writeMarker(m: MarkerState) { try { const f = MARKER(); if (!f.exists) f.create(); f.write(JSON.stringify(m)); } catch { /* best effort */ } }

/** Call once per feature use, BEFORE loading. If the previous run left the flag set, it crashed natively. */
export function crashState(): { disabled: boolean; crashes: number; lastInFlight: string | null } {
  const m = readMarker();
  const crashes = m.inFlight ? m.crashes + 1 : m.crashes;
  if (m.inFlight) writeMarker({ inFlight: null, crashes });
  return { disabled: crashes >= 2, crashes, lastInFlight: m.inFlight };
}
export function beginInference(what: string) { const m = readMarker(); writeMarker({ ...m, inFlight: what }); }
/** A finished inference proves the native path is stable: clear the consecutive-crash counter. */
export function endInference() { writeMarker({ inFlight: null, crashes: 0 }); }
export function resetCrashMarker() { writeMarker({ inFlight: null, crashes: 0 }); }

// ---------------------------------------------------------------------------------------------- loading

export interface Loaded { key: string; modelId: string; loadMs: number; path: string; policy: string }

function policyNote(spec: ModelSpec): string {
  const id = spec.policyId ?? spec.sdkName;
  try { return isAllowed(POLICY_MANIFEST, id, "inference", "Z0") ? "allowed" : "NOT in policy.json (default-deny, D36): add an entry before shipping"; } catch { return "policy check failed"; }
}

export interface LoadOpts {
  ctxSize?: number;
  threads?: number;
  /** Extra modelConfig keys. */
  config?: Record<string, unknown>;
  onProgress?: (msg: string) => void;
}

/** Cheap RPC round-trip: proves the Bare worklet answers before a model is loaded. */
export async function ping(): Promise<{ ok: true; ms: number }> {
  const s = await sdk();
  const t0 = Date.now();
  await withTimeout(s.getSystemResources({}), 20_000, "worker ping");
  return { ok: true, ms: Date.now() - t0 };
}

/** Raised when a model file has not been downloaded. UI must offer setup, never show the raw error. */
export class ModelMissingError extends Error {
  constructor(public readonly key: string, public readonly file: string) {
    super(`model ${key} (${file}) is not installed`);
    this.name = "ModelMissingError";
  }
}

const loaded = new Map<string, Loaded>();
export function loadedModels(): Loaded[] { return [...loaded.values()]; }

/** Load a model from its cached local path. Never touches the registry. */
export async function loadLocal(spec: ModelSpec, opts: LoadOpts = {}): Promise<Loaded> {
  const existing = loaded.get(spec.key);
  if (existing) return existing;
  const file = localPath(spec);
  if (!file) throw new ModelMissingError(spec.key, spec.file);
  const s = await sdk();
  const t0 = Date.now();
  let modelId: string;
  if (spec.kind === "decision") {
    modelId = await withTimeout(s.loadModel({
      modelSrc: file.path, modelType: "llamacpp-decision",
      modelConfig: { device: "cpu", ...(opts.threads ? { threads: opts.threads } : {}), ...opts.config },
      modelFitPolicy: "off",
    } as never), 180_000, `load ${spec.file}`);
  } else if (spec.kind === "completion") {
    modelId = await withTimeout(s.loadModel({
      modelSrc: file.path, modelType: "llamacpp-completion",
      modelConfig: { device: "cpu", ctx_size: opts.ctxSize ?? 2048, reasoning_budget: 0, ...(opts.threads ? { threads: opts.threads } : {}), ...opts.config },
      modelFitPolicy: "off",
    } as never), 180_000, `load ${spec.file}`);
  } else {
    const detector = localPath(MODELS.ocr_craft);
    if (!detector) throw new ModelMissingError("ocr_craft", "craft_mlt_25k.gguf");
    modelId = await withTimeout(s.loadModel({
      modelSrc: file.path, modelType: "ggml-ocr",
      modelConfig: { langList: ["en"], pipelineType: "easyocr", backendDevice: "cpu", detectorModelSrc: detector.path, ...opts.config },
      modelFitPolicy: "off",
    } as never), 180_000, `load ${spec.file}`);
  }
  const rec = { key: spec.key, modelId, loadMs: Date.now() - t0, path: file.path, policy: policyNote(spec) };
  loaded.set(spec.key, rec);
  return rec;
}

/** Time-boxed unload. Spike 16: unloadModel() never resolved on this SDK/device; we report what happens. */
export async function unload(key: string, timeoutMs = 30_000): Promise<{ resolved: boolean; ms: number; error?: string }> {
  const rec = loaded.get(key);
  if (!rec) return { resolved: true, ms: 0 };
  const s = await sdk();
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      s.unloadModel({ modelId: rec.modelId } as never).then(() => "ok" as const),
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), timeoutMs)),
    ]);
    if (r === "ok") { loaded.delete(key); return { resolved: true, ms: Date.now() - t0 }; }
    return { resolved: false, ms: Date.now() - t0 };
  } catch (e) {
    return { resolved: false, ms: Date.now() - t0, error: String(e) };
  }
}

/** Terminate the Bare worklet (releases every model). Fresh worker on the next call. */
export async function shutdown(timeoutMs = 20_000): Promise<{ resolved: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const s = await sdk();
    const r = await Promise.race([
      s.close().then(() => "ok" as const),
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), timeoutMs)),
    ]);
    if (r === "ok") loaded.clear();
    return { resolved: r === "ok", ms: Date.now() - t0 };
  } catch (e) {
    return { resolved: false, ms: Date.now() - t0, error: String(e) };
  }
}

// ---------------------------------------------------------------------------------------------- inference

/** Reject instead of hanging forever when a native RPC stalls; clears the timer so the app can idle. */
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export interface CompleteOpts {
  system?: string;
  user: string;
  predict?: number;
  temp?: number;
  timeoutMs?: number;
  responseFormat?: unknown;
}
export interface CompleteOut {
  text: string; ms: number; tokPerSec?: number; promptTokens?: number; generatedTokens?: number; ttftMs?: number; raw?: unknown;
}

export async function complete(modelId: string, o: CompleteOpts): Promise<CompleteOut> {
  const s = await sdk();
  const t0 = Date.now();
  const history: Array<{ role: "system" | "user"; content: string }> = [];
  if (o.system) history.push({ role: "system", content: o.system });
  history.push({ role: "user", content: o.user });
  const run = s.completion({
    modelId, history, stream: false,
    generationParams: { predict: o.predict ?? 160, temp: o.temp ?? 0, reasoning_budget: 0 },
    ...(o.responseFormat ? { responseFormat: o.responseFormat } : {}),
  } as never) as unknown as { final: Promise<{ contentText: string; stats?: Record<string, number> }> };
  const final = await withTimeout(run.final, o.timeoutMs ?? 120_000, "completion");
  const st = final.stats ?? {};
  return {
    text: (final.contentText ?? "").trim(), ms: Date.now() - t0,
    tokPerSec: st.tokensPerSecond, promptTokens: st.promptTokens, generatedTokens: st.generatedTokens, ttftMs: st.timeToFirstToken, raw: st,
  };
}

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: string[] | Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DecisionAnswer { type: string; choice?: string | number | boolean; noul?: number; score?: number; probabilities?: Record<string, number>; confidence?: number; answerConfidence?: number }
export interface DecisionResult { answers: Record<string, DecisionAnswer>; usage?: Record<string, unknown> }

/** One state, or a batch through `states` (one RPC, one forward pass per question and state). */
export async function decide(modelId: string, states: string | string[], questions: Record<string, DecisionQuestion>, o: { timeoutMs?: number; maxLen?: number } = {}): Promise<{ results: DecisionResult[]; ms: number }> {
  const s = await sdk();
  const t0 = Date.now();
  const arr = Array.isArray(states);
  const params = arr ? { modelId, states, questions, ...(o.maxLen ? { maxLen: o.maxLen } : {}) } : { modelId, state: states, questions, ...(o.maxLen ? { maxLen: o.maxLen } : {}) };
  const res = await withTimeout(s.decide(params as never) as unknown as Promise<DecisionResult | DecisionResult[]>, o.timeoutMs ?? 120_000, "decide");
  return { results: Array.isArray(res) ? res : [res], ms: Date.now() - t0 };
}

export interface OcrBlock { text: string; bbox?: unknown; confidence?: number }

export async function ocrImage(modelId: string, imagePath: string, o: { timeoutMs?: number } = {}): Promise<{ blocks: OcrBlock[]; stats?: unknown; ms: number }> {
  const s = await sdk();
  const t0 = Date.now();
  const r = s.ocr({ modelId, image: imagePath.replace(/^file:\/\//, "") } as never) as unknown as { blocks: Promise<OcrBlock[]>; stats: Promise<unknown> };
  const blocks = await withTimeout(r.blocks, o.timeoutMs ?? 120_000, "ocr");
  const stats = await r.stats.catch(() => undefined);
  return { blocks, stats, ms: Date.now() - t0 };
}
