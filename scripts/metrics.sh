#!/usr/bin/env bash
# Reproducible metrics run: builds the wasms once, runs every attack case alone N times, the
# metrics test N times, the property tests once, then aggregates into docs/METRICS.md.
# Env: N (default 10), QUICK=1 (N=3, PROPTEST_CASES=256), PHASE_TIMEOUT (seconds, default 3600).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK="${QUICK:-0}"
if [ "$QUICK" = "1" ]; then
  N="${N:-3}"
  PROPTEST_CASES="${PROPTEST_CASES:-256}"
  OUT="docs/METRICS.quick.md"
else
  N="${N:-10}"
  PROPTEST_CASES="${PROPTEST_CASES:-}"
  OUT="docs/METRICS.md"
fi
PHASE_TIMEOUT="${PHASE_TIMEOUT:-3600}"
case "$N" in ''|*[!0-9]*) echo "N must be a positive integer" >&2; exit 2;; esac
[ "$N" -ge 1 ] || { echo "N must be >= 1" >&2; exit 2; }

die() { echo "metrics: $*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found (need v26)"
case "$(node -p 'process.versions.node.split(".")[0]')" in
  26) ;;
  *) die "node 26 required, found $(node -v)";;
esac
command -v cargo >/dev/null 2>&1 || die "cargo not found"
command -v cargo-near >/dev/null 2>&1 || die "cargo-near not found"

# hard timeout: use timeout/gtimeout if present, else a bash watchdog
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null ) &
  local wd=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  return "$rc"
}

mkdir -p "$ROOT/target"
WORK="$(mktemp -d "$ROOT/target/metrics.XXXXXX")"
RUNS="$WORK/runs"
mkdir -p "$RUNS"
echo "metrics: work dir $WORK (N=$N, quick=$QUICK)"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# --- build wasms once (mirrors .github/workflows/ci.yml) ------------------------
echo "metrics: building production wasm"
run_with_timeout "$PHASE_TIMEOUT" make contract-build || die "make contract-build failed"

TW="$WORK/wasm"
mkdir -p "$TW"
(
  cd "$ROOT/contract"
  CARGO_TARGET_DIR="$PWD/target/fault-injection" run_with_timeout "$PHASE_TIMEOUT" \
    cargo near build non-reproducible-wasm --locked --no-abi \
    --features fault-injection --env PURSER_ALLOW_FAULT_INJECTION=1
  CARGO_TARGET_DIR="$PWD/target/race-driver" run_with_timeout "$PHASE_TIMEOUT" \
    cargo near build non-reproducible-wasm --locked --no-abi \
    --manifest-path tests/fixtures/race-driver/Cargo.toml
  CARGO_TARGET_DIR="$PWD/target/mock-signer" run_with_timeout "$PHASE_TIMEOUT" \
    cargo near build non-reproducible-wasm --locked --no-abi \
    --manifest-path tests/fixtures/mock-signer/Cargo.toml
) || die "test-artifact build failed"
cp "$ROOT/contract/target/near/purser_contract.wasm" "$TW/prod.wasm"
cp "$ROOT/contract/target/fault-injection/near/purser_contract.wasm" "$TW/fault.wasm"
cp "$ROOT/contract/target/race-driver/near/race_driver.wasm" "$TW/driver.wasm"
cp "$ROOT/contract/target/mock-signer/near/mock_signer.wasm" "$TW/mock-signer.wasm"

export PURSER_WASM_PROD="$TW/prod.wasm"
export PURSER_WASM_FAULT="$TW/fault.wasm"
export PURSER_WASM_DRIVER="$TW/driver.wasm"
export PURSER_WASM_MOCK_SIGNER="$TW/mock-signer.wasm"
WASM_SHA="$(sha256_of "$PURSER_WASM_PROD")"

cd "$ROOT/contract"

# --- enumerate attack cases ------------------------------------------------------
LIST="$WORK/attacks.list"
run_with_timeout "$PHASE_TIMEOUT" cargo test --test attacks -- --list > "$LIST" 2> "$WORK/list.err" \
  || die "cargo test --list failed (see $WORK/list.err)"
CASES="$WORK/attacks.cases"
grep ': test$' "$LIST" | sed 's/: test$//' > "$CASES" || true
EXPECTED="$(wc -l < "$CASES" | tr -d ' ')"
[ "$EXPECTED" -ge 1 ] || die "no attack cases listed"
echo "metrics: $EXPECTED attack cases"

# --- attack suite: each case alone, N times ---------------------------------------
i=1
while [ "$i" -le "$N" ]; do
  TSV="$RUNS/attacks-$i.tsv"
  : > "$TSV"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    LOG="$WORK/attack-$i-$name.log"
    rc=0
    run_with_timeout "$PHASE_TIMEOUT" cargo test --test attacks -- --exact "$name" --nocapture > "$LOG" 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
      # fail closed: exactly one test must have actually run
      grep -q '^running 1 test$' "$LOG" || die "case $name: running != 1 (filtered or renamed)"
    fi
    printf '%s\t%s\n' "$name" "$rc" >> "$TSV"
    # a case's own METRIC lines (race attempts) ride along with the metrics log of the same repeat
    { grep -h 'METRIC ' "$LOG" || true; } | sed 's/^.*METRIC /METRIC /' >> "$RUNS/attack-metrics-$i.log"
  done < "$CASES"
  RAN="$(wc -l < "$TSV" | tr -d ' ')"
  [ "$RAN" = "$EXPECTED" ] || die "attacks run $i recorded $RAN cases, expected $EXPECTED"
  echo "metrics: attacks repeat $i/$N done"
  i=$((i + 1))
done

# --- metrics test: N times, single-threaded ----------------------------------------
i=1
while [ "$i" -le "$N" ]; do
  run_with_timeout "$PHASE_TIMEOUT" cargo test --test metrics -- --nocapture --test-threads=1 \
    > "$RUNS/metrics-$i.log" 2>&1 || die "metrics test failed in repeat $i (see $RUNS/metrics-$i.log)"
  if [ -f "$RUNS/attack-metrics-$i.log" ]; then cat "$RUNS/attack-metrics-$i.log" >> "$RUNS/metrics-$i.log"; fi
  echo "metrics: metrics repeat $i/$N done"
  i=$((i + 1))
done

# --- properties: once --------------------------------------------------------------
if [ -n "$PROPTEST_CASES" ]; then export PROPTEST_CASES; fi
run_with_timeout "$PHASE_TIMEOUT" cargo test --test properties -- --nocapture --test-threads=1 \
  > "$RUNS/proptest.log" 2>&1 || die "properties test failed (see $RUNS/proptest.log)"

cd "$ROOT"

# --- meta --------------------------------------------------------------------------
GIT_SHA="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then DIRTY=true; else DIRTY=false; fi
NEARCORE="$(sed -n 's/^VERSION=\(.*\)$/\1/p' scripts/sandbox-bin.sh | head -n 1 || true)"
WORKSPACES="$(grep -A1 '^name = "near-workspaces"' contract/Cargo.lock 2>/dev/null | sed -n 's/^version = "\(.*\)"$/\1/p' | head -n 1 || true)"
TOOLCHAIN="$(rustc --version 2>/dev/null || echo unknown); $(cargo near --version 2>/dev/null | head -n 1 || echo cargo-near unknown); node $(node -v)"
QUICK_JSON=false
if [ "$QUICK" = "1" ]; then QUICK_JSON=true; fi
GIT_SHA="$GIT_SHA" DIRTY="$DIRTY" WASM_SHA="$WASM_SHA" NEARCORE="${NEARCORE:-unknown}" WORKSPACES="${WORKSPACES:-unknown}" \
TOOLCHAIN="$TOOLCHAIN" N="$N" QUICK_JSON="$QUICK_JSON" META="$RUNS/meta.json" \
node -e '
const e = process.env;
require("node:fs").writeFileSync(e.META, JSON.stringify({
  git_sha: e.GIT_SHA, dirty: e.DIRTY === "true", wasm_sha256: e.WASM_SHA,
  nearcore_version: "nearcore " + e.NEARCORE + " sandbox (near-workspaces " + e.WORKSPACES + ")", toolchain: e.TOOLCHAIN,
  date: new Date().toISOString(), n: Number(e.N), quick: e.QUICK_JSON === "true",
}, null, 2));
'

# --- aggregate (atomic write, only if every check passes) ------------------------------
node scripts/metrics-report.mjs --in "$WORK" --out "$OUT" || die "aggregation failed; $OUT not written (raw logs in $WORK)"
echo "metrics: wrote $OUT (raw logs kept in $WORK)"
if [ "$QUICK" != "1" ]; then
  node scripts/readme-evidence.mjs || die "README evidence table not updated"
fi
