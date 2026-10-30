#!/usr/bin/env bash
# Reassemble [labjson] logcat chunks emitted by the in-app lab into tools/lab/results/<runId>.json.
# Usage: tools/lab/pull-results.sh [device]   (default <device-ip>:5555)
# The release app is not debuggable, so files/lab/*.json cannot be pulled; logcat is the transport.
# Tip: before a long run:  adb -s $D logcat -G 16M   so the ring buffer does not wrap.
set -euo pipefail
D="${1:-${ANDROID_SERIAL:-<device-ip>:5555}}"
OUT="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$OUT"
adb -s "$D" logcat -d -v raw -s ReactNativeJS:I > "$OUT/.logcat.raw" || true
python3 - "$OUT" <<'PY'
import re, sys, json, os, collections
out = sys.argv[1]
parts = collections.defaultdict(dict)
total = {}
for line in open(os.path.join(out, ".logcat.raw"), errors="replace"):
    m = re.match(r"\[labjson\] (\S+) (\d+)/(\d+) (.*)$", line.rstrip("\n"))
    if m:
        rid, i, n, chunk = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
        parts[rid][i] = chunk; total[rid] = n
ok = bad = 0
for rid, d in sorted(parts.items()):
    if len(d) != total[rid]:
        print(f"INCOMPLETE {rid}: {len(d)}/{total[rid]} chunks (logcat wrapped? raise -G)"); bad += 1; continue
    s = "".join(d[i] for i in range(1, total[rid] + 1))
    try: json.loads(s)
    except Exception as e: print(f"CORRUPT {rid}: {e}"); bad += 1; continue
    open(os.path.join(out, rid + ".json"), "w").write(s); ok += 1
print(f"wrote {ok} result files to {out} ({bad} bad)")
PY
