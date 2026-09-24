#!/usr/bin/env bash
# Copies every file in test-data/ into the sample app's databases/ dir on a connected device.
# Needs a debuggable build (run-as). Usage: scripts/push-test-dbs-android.sh [package]
set -euo pipefail
ADB="${ADB:-$(command -v adb || echo "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb")}"
PKG="${1:-com.hfps.dbinspector.sample}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/test-data"
"$ADB" shell am force-stop "$PKG" || true
"$ADB" shell run-as "$PKG" mkdir -p databases
for f in "$DIR"/*; do
  name="$(basename "$f")"
  echo "→ $name ($(du -h "$f" | cut -f1))"
  "$ADB" push "$f" "/data/local/tmp/$name" >/dev/null
  "$ADB" shell "run-as $PKG sh -c 'cat /data/local/tmp/$name > databases/$name'"
  "$ADB" shell rm "/data/local/tmp/$name"
done
"$ADB" shell run-as "$PKG" ls -la databases
