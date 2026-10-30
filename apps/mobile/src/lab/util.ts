import { File, Paths, Directory } from "expo-file-system";

export interface Mem { rssKb?: number; swapKb?: number; hwmKb?: number; pssKb?: number; pssAnonKb?: number; threads?: number }

function kv(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** In-process memory (the Bare worklet is a thread of this process, so models show up here). */
export function readMem(): Mem {
  const m: Mem = {};
  try {
    const s = kv(new File("file:///proc/self/status").textSync());
    m.rssKb = s.VmRSS; m.swapKb = s.VmSwap; m.hwmKb = s.VmHWM; m.threads = s.Threads;
  } catch { /* unreadable */ }
  try {
    const r = kv(new File("file:///proc/self/smaps_rollup").textSync());
    m.pssKb = r.Pss; m.pssAnonKb = r.Pss_Anon;
  } catch { /* unreadable */ }
  return m;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const now = () => Date.now();

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, mean: s.length ? sum / s.length : NaN, p50: pct(s, 50), p95: pct(s, 95), min: s[0], max: s[s.length - 1] };
}

let runId = "";
export function newRun(suite: string): string {
  runId = `${suite}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  return runId;
}

/**
 * Release builds are not debuggable (no run-as), so results leave the app two ways:
 *  1. internal file `files/lab/<runId>.json` (kept for on-device inspection),
 *  2. chunked `[labjson]` lines in logcat, reassembled by tools/lab/pull-results.sh.
 */
export function emitResult(id: string, obj: unknown) {
  const json = JSON.stringify(obj);
  try {
    const dir = new Directory(Paths.document, "lab");
    if (!dir.exists) dir.create({ intermediates: true });
    const f = new File(dir, `${id}.json`);
    f.create({ overwrite: true });
    f.write(json);
  } catch { /* logcat path still works */ }
  const CH = 3000;
  const n = Math.max(1, Math.ceil(json.length / CH));
  for (let i = 0; i < n; i++) console.log(`[labjson] ${id} ${i + 1}/${n} ${json.slice(i * CH, (i + 1) * CH)}`);
  console.log(`[lab] result ${id} bytes=${json.length} chunks=${n}`);
}

export function say(msg: string) { console.log(`[lab] ${msg}`); }
