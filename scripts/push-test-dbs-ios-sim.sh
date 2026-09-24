#!/usr/bin/env bash
# Copies every file in test-data/ into the sample app's Library/LocalDatabase (where the
# OutSystems / cordova-sqlite-storage plugins keep their files) on the booted simulator.
# Usage: scripts/push-test-dbs-ios-sim.sh [bundle-id]
set -euo pipefail
BUNDLE="${1:-com.hfps.dbinspector.sample}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/test-data"
DATA="$(xcrun simctl get_app_container booted "$BUNDLE" data)"
mkdir -p "$DATA/Library/LocalDatabase"
cp -v "$DIR"/* "$DATA/Library/LocalDatabase/"
