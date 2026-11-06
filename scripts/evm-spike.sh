#!/usr/bin/env bash
# Reproduce the EVM sighash feasibility spike's numbers (docs/EVM-SPIKE.md). Local and sandbox only: no
# network, no testnet. The spike wasm is a measurement build and is refused by scripts/check-wasm-clean.sh.
#
#   make evm-spike
#
# Builds use `--no-abi` and isolated target dirs so nothing here can touch target/near/purser_contract*.
#
# Since Prompt 12 the default build CARRIES the EVM payment path, so it is deliberately NOT byte-identical to the
# spike-era wasm any more (that claim in docs/EVM-SPIKE.md is retired). What this script still measures:
#   - the spike harness's own cost, as the delta of the spike build over the (EVM-carrying) default build;
#   - the EVM path's cost, as the delta of the default build over the PRE-EVM tree (a temporary git worktree of
#     $PURSER_EVM_BASELINE_REF, default 8c4107b = the merge of the spike, built with the identical command);
#   - that the wasm gate keeps refusing the spike build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/contract"
# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PURSER_ALLOW_EVM_SPIKE=1   # build.rs refuses the feature without this explicit opt-in
# A stale prebuilt wasm in the caller's environment would make step 4 measure the wrong artifact.
unset PURSER_WASM_EVM PURSER_WASM_PROD PURSER_WASM_FAULT

# build <target-dir> [cargo-near args...]: quiet on success, full output kept and shown on failure.
build() {
  local dir="$1" log; shift
  log="$(mktemp)"
  if ! CARGO_TARGET_DIR="$dir" cargo near build non-reproducible-wasm "$@" --no-abi >"$log" 2>&1; then
    echo "FAIL: cargo near build $* failed; output:" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
}

echo "== 1. host tests: 36 chainsig.js/viem vectors, rlp-crate + sha3 oracles, 2000 random transactions (evm_tx), spike harness (evm_spike)"
cargo test --features evm-spike --lib evm_tx
cargo test --features evm-spike --lib evm_spike

echo
echo "== 2. wasm size: same toolchain, same cargo-near step, --no-abi, isolated target dirs"
base_dir="$PWD/target/baseline-noabi"
spike_dir="$PWD/target/evm-spike"
build "$base_dir"
build "$spike_dir" --features evm-spike
base="$base_dir/near/purser_contract.wasm"
spike="$spike_dir/near/purser_contract.wasm"
b=$(wc -c < "$base"); s=$(wc -c < "$spike")
bz=$(gzip -9 -c "$base" | wc -c); sz=$(gzip -9 -c "$spike" | wc -c)
printf '%-26s raw %8d  gz %8d  sha256 %s\n' "default (EVM path, no ABI)" "$b" "$bz" "$(shasum -a 256 "$base" | cut -c1-16)"
printf '%-26s raw %8d  gz %8d  sha256 %s\n' "evm-spike (no ABI)" "$s" "$sz" "$(shasum -a 256 "$spike" | cut -c1-16)"
# Single-quoted awk program with -v: an unquoted BEGIN{...,...} is brace-expanded by bash and awk then hangs on stdin.
pct="$(awk -v s="$s" -v b="$b" 'BEGIN { printf "%.2f", (s - b) * 100 / b }')"
printf 'spike harness delta        raw %+8d  gz %+8d  (%s%% raw)\n' "$((s - b))" "$((sz - bz))" "$pct"

# The EVM path's own cost: the default build vs the pre-EVM tree, built with the identical command. Skipped (loudly)
# if the ref is not in this clone.
ref="${PURSER_EVM_BASELINE_REF:-8c4107b}"
if git -C "$ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
  wt="$ROOT/target/evm-baseline-worktree"
  cleanup_wt() { git -C "$ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true; }
  cleanup_wt
  git -C "$ROOT" worktree add --detach "$wt" "$ref" >/dev/null 2>&1 || { echo "FAIL: cannot create a worktree of $ref" >&2; exit 1; }
  trap cleanup_wt EXIT
  pre_dir="$ROOT/target/pre-evm-noabi"
  ( cd "$wt/contract" && build "$pre_dir" )
  pre="$pre_dir/near/purser_contract.wasm"
  p=$(wc -c < "$pre"); pz=$(gzip -9 -c "$pre" | wc -c)
  printf '%-26s raw %8d  gz %8d  sha256 %s\n' "pre-EVM $ref (no ABI)" "$p" "$pz" "$(shasum -a 256 "$pre" | cut -c1-16)"
  ppct="$(awk -v s="$b" -v b="$p" 'BEGIN { printf "%.2f", (s - b) * 100 / b }')"
  printf 'EVM path delta             raw %+8d  gz %+8d  (%s%% raw)\n' "$((b - p))" "$((bz - pz))" "$ppct"
  cleanup_wt
  trap - EXIT
else
  echo "SKIP: baseline ref $ref not found in this clone; set PURSER_EVM_BASELINE_REF to a pre-EVM commit"
fi

echo
echo "== 3. wasm gate: the default (EVM-carrying) build is clean, the spike build must be refused"
../scripts/check-wasm-clean.sh "$base"
gate_rc=0
../scripts/check-wasm-clean.sh "$spike" || gate_rc=$?
case "$gate_rc" in
  1) ;;   # refused, as required
  0) echo "FAIL: scripts/check-wasm-clean.sh accepted the spike wasm" >&2; exit 1 ;;
  *) echo "FAIL: scripts/check-wasm-clean.sh errored (exit $gate_rc) instead of refusing" >&2; exit 1 ;;
esac
echo "✓ the spike wasm is refused"

echo
echo "== 4. sandbox gas (nearcore from scripts/sandbox-bin.sh): per-sighash gas and the load tax on existing methods"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
NEAR_SANDBOX_BIN_PATH="$(../scripts/sandbox-bin.sh)"
export NEAR_SANDBOX_BIN_PATH
if ! cargo test --features evm-spike --test evm_spike -- --nocapture --test-threads=1 >"$out" 2>&1; then
  cat "$out" >&2
  echo "FAIL: sandbox gas tests failed" >&2
  exit 1
fi
{ grep -vE '^\s*(Compiling|Downloaded|Downloading|Finished|Running)|^$|^running ' "$out" || true; }
# Not an exact count (it would drift whenever a test is added): require at least one passing test and no failures.
if ! grep -qE 'test result: ok\. [1-9][0-9]* passed; 0 failed' "$out"; then
  echo "FAIL: the sandbox run reported no passing tests or a failure (did no tests run?)" >&2
  exit 1
fi
