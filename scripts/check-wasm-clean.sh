#!/usr/bin/env bash
# Refuse to ship a measurement build: fail if any given wasm contains a test-only marker.
# Usage: scripts/check-wasm-clean.sh <file.wasm>...
#   - fault-injection build:  marker must equal contract/src/lib.rs FAULT_MARKER
#   - evm-spike build:        marker must equal contract/src/evm_spike.rs EVM_SPIKE_MARKER (a test keeps them equal),
#                             plus the spike's export name, a second, independent signal
set -euo pipefail

fault_marker='PURSER_FAULT_INJECTION_LOST_CALLBACK'
spike_marker='PURSER_EVM_SPIKE_MEASUREMENT_ONLY'
spike_export='evm_spike_sighash'
[ "$#" -gt 0 ] || { echo "usage: $0 <file.wasm>..." >&2; exit 2; }
for wasm in "$@"; do
  [ -f "$wasm" ] || { echo "✋ $wasm: not found" >&2; exit 2; }
  if LC_ALL=C grep -q "$fault_marker" "$wasm"; then
    echo "✋ $wasm is a fault-injection build; refusing to ship it." >&2
    exit 1
  fi
  if LC_ALL=C grep -q "$spike_marker" "$wasm" || LC_ALL=C grep -q "$spike_export" "$wasm"; then
    echo "✋ $wasm is an EVM-spike measurement build; refusing to ship it." >&2
    exit 1
  fi
  echo "✓ $wasm is clean"
done
