#!/usr/bin/env bash
# Refuse to ship a fault-injection build: fail if any given wasm contains the test-only marker.
# Usage: scripts/check-wasm-clean.sh <file.wasm>...
set -euo pipefail

marker='PURSER_FAULT_INJECTION_LOST_CALLBACK'
[ "$#" -gt 0 ] || { echo "usage: $0 <file.wasm>..." >&2; exit 2; }
for wasm in "$@"; do
  [ -f "$wasm" ] || { echo "✋ $wasm: not found" >&2; exit 2; }
  if LC_ALL=C grep -q "$marker" "$wasm"; then
    echo "✋ $wasm is a fault-injection build; refusing to ship it." >&2
    exit 1
  fi
  echo "✓ $wasm is clean"
done
