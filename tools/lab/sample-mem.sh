#!/usr/bin/env bash
# Host-side sampler: every N seconds append PSS/RSS/swap (dumpsys meminfo), system MemAvailable, and LMK/crash log
# counts for dev.yako.app to tools/lab/results/mem-<tag>.csv.   Usage: sample-mem.sh <tag> [intervalSec] [device]
set -uo pipefail
TAG="${1:?tag}"; IV="${2:-10}"; D="${3:-${ANDROID_SERIAL:-<device-ip>:5555}}"
OUT="$(cd "$(dirname "$0")" && pwd)/results/mem-$TAG.csv"
echo "epoch,pid,pss_kb,rss_kb,swap_pss_kb,native_heap_kb,graphics_kb,mem_available_kb,swap_free_kb,lmk_lines,fatal_lines" > "$OUT"
while true; do
  now=$(date +%s)
  pid=$(adb -s "$D" shell pidof dev.yako.app 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "$pid" ]; then
    mi=$(adb -s "$D" shell dumpsys meminfo "$pid" 2>/dev/null | tr -d '\r')
    pss=$(echo "$mi" | awk '/TOTAL PSS:/ {print $3; exit} /^ *TOTAL +[0-9]/ {print $2; exit}')
    rss=$(echo "$mi" | grep -o "TOTAL RSS: *[0-9]*" | head -1 | grep -o "[0-9]*$")
    swp=$(echo "$mi" | grep -o "TOTAL SWAP PSS: *[0-9]*" | head -1 | grep -o "[0-9]*$")
    nat=$(echo "$mi" | awk '/Native Heap/ {print $3; exit}')
    gfx=$(echo "$mi" | awk '/ Graphics:/ {print $2; exit}')
  else pss=; rss=; swp=; nat=; gfx=; fi
  sm=$(adb -s "$D" shell cat /proc/meminfo 2>/dev/null | tr -d '\r')
  av=$(echo "$sm" | awk '/MemAvailable/ {print $2}'); sf=$(echo "$sm" | awk '/SwapFree/ {print $2}')
  lmk=$(adb -s "$D" logcat -d 2>/dev/null | grep -ci "lowmemorykiller\|lmkd.*kill\|Killing 'dev.yako")
  fat=$(adb -s "$D" logcat -d -b crash 2>/dev/null | grep -ci "dev.yako.app")
  echo "$now,${pid:-},${pss:-},${rss:-},${swp:-},${nat:-},${gfx:-},${av:-},${sf:-},${lmk:-},${fat:-}" >> "$OUT"
  sleep "$IV"
done
