#!/usr/bin/env bash
# Drive a lab suite on the phone via deep link and wait for completion.
# Usage: tools/lab/run.sh "<suite[,suite]>" "[k=v&k=v]" [timeoutSec] [device]
# Needs a build made with EXPO_PUBLIC_YAKO_LAB=1. Keeps the screen on, enlarges logcat, then pulls results.
set -euo pipefail
S="${1:?suite}"; P="${2:-}"; T="${3:-1800}"; D="${4:-${ANDROID_SERIAL:-<device-ip>:5555}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
adb -s "$D" shell svc power stayon true >/dev/null 2>&1 || true
adb -s "$D" shell input keyevent KEYCODE_WAKEUP
adb -s "$D" logcat -G 16M >/dev/null 2>&1 || true
adb -s "$D" logcat -c
adb -s "$D" shell am force-stop dev.yako.app
sleep 1
URL="yako://lab?suite=${S}${P:+&$P}"
echo ">> $URL"
adb -s "$D" shell am start -a android.intent.action.VIEW -d "'$URL'" dev.yako.app >/dev/null
end=$(( $(date +%s) + T ))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 5
  if ! adb -s "$D" shell pidof dev.yako.app >/dev/null 2>&1; then echo "!! app process died"; break; fi
  last=$(adb -s "$D" logcat -d -v raw -s ReactNativeJS:I | grep "^\[lab\] " | tail -1 || true)
  printf '\r%s' "${last:0:150}"
  if adb -s "$D" logcat -d -v raw -s ReactNativeJS:I | grep -q "=== suite ${S##*,} \(DONE\|FAILED\)"; then echo; echo "-- done"; break; fi
done
"$HERE/pull-results.sh" "$D"
adb -s "$D" logcat -d -b crash | tail -5 || true
