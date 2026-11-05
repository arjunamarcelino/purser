#!/usr/bin/env bash
# Reproduce the EVM sighash feasibility spike's numbers (docs/EVM-SPIKE.md). Local and sandbox only: no
# network, no testnet. The spike wasm is a measurement build and is refused by scripts/check-wasm-clean.sh.
#
#   make evm-spike
#
# Builds use `--no-abi` and isolated target dirs so nothing here can touch target/near/purser_contract*.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/contract"
# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PURSER_ALLOW_EVM_SPIKE=1   # build.rs refuses the feature without this explicit opt-in

echo "== 1. host tests: 36 chainsig.js/viem vectors, rlp-crate + sha3 oracles, 2000 random transactions"
cargo test --features evm-spike --lib evm_spike

echo
echo "== 2. wasm size: same toolchain, same cargo-near step, --no-abi, isolated target dirs"
base_dir="$PWD/target/baseline-noabi"
spike_dir="$PWD/target/evm-spike"
CARGO_TARGET_DIR="$base_dir" cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1
CARGO_TARGET_DIR="$spike_dir" cargo near build non-reproducible-wasm --features evm-spike --no-abi >/dev/null 2>&1
base="$base_dir/near/purser_contract.wasm"
spike="$spike_dir/near/purser_contract.wasm"
b=$(wc -c < "$base"); s=$(wc -c < "$spike")
bz=$(gzip -9 -c "$base" | wc -c); sz=$(gzip -9 -c "$spike" | wc -c)
printf '%-22s raw %8d  gz %8d  sha256 %s\n' "default (no ABI)" "$b" "$bz" "$(shasum -a 256 "$base" | cut -c1-16)"
printf '%-22s raw %8d  gz %8d  sha256 %s\n' "evm-spike (no ABI)" "$s" "$sz" "$(shasum -a 256 "$spike" | cut -c1-16)"
# Single-quoted awk program with -v: an unquoted BEGIN{...,...} is brace-expanded by bash and awk then hangs on stdin.
pct="$(awk -v s="$s" -v b="$b" 'BEGIN { printf "%.2f", (s - b) * 100 / b }')"
printf 'delta                  raw %+8d  gz %+8d  (%s%% raw)\n' "$((s - b))" "$((sz - bz))" "$pct"

echo
echo "== 3. wasm gate: the default build is clean, the spike build must be refused"
../scripts/check-wasm-clean.sh "$base"
if ../scripts/check-wasm-clean.sh "$spike" 2>/dev/null; then
  echo "FAIL: scripts/check-wasm-clean.sh accepted the spike wasm" >&2
  exit 1
fi
echo "✓ the spike wasm is refused"

echo
echo "== 4. sandbox gas (nearcore from scripts/sandbox-bin.sh): per-sighash gas and the load tax on existing methods"
NEAR_SANDBOX_BIN_PATH="$(../scripts/sandbox-bin.sh)" \
  cargo test --features evm-spike --test evm_spike -- --nocapture --test-threads=1 2>&1 \
  | grep -vE '^\s*(Compiling|Downloaded|Downloading|Finished|Running)|^$|^running '
