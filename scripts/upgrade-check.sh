#!/usr/bin/env bash
# Reproduce the "upgrades in place, no migration" claim: build the PREVIOUS release's wasm from a git
# ref, then run contract/tests/upgrade.rs, which deploys it, writes state with it, redeploys the
# current wasm over the same account and checks that state still reads.
#
#   scripts/upgrade-check.sh [GIT_REF]     # default: the merge-base of HEAD and origin/main
#   make upgrade-check [PREV=<ref>]
#
# The old tree is checked out in a temporary `git worktree` under target/ and removed afterwards.
# Needs full history (CI: fetch-depth 0), cargo-near and the sandbox binary (scripts/sandbox-bin.sh).
#
# Scope: history written before the upgrade is NOT counted toward a task's created_count; it reads 0
# after the upgrade, so an old task gets a fresh creation allowance on top of its existing commitments.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

REF="${1:-}"
if [ -z "$REF" ]; then
  base_ref=origin/main
  git -C "$ROOT" rev-parse --verify -q "$base_ref" >/dev/null || base_ref=main
  REF="$(git -C "$ROOT" merge-base HEAD "$base_ref")"
fi
git -C "$ROOT" rev-parse --verify -q "$REF^{commit}" >/dev/null \
  || { echo "upgrade-check: unknown git ref '$REF' (shallow clone? fetch full history)" >&2; exit 1; }
echo "upgrade-check: previous release = $(git -C "$ROOT" rev-parse --short "$REF")"

WT="$ROOT/target/upgrade-prev"
mkdir -p "$ROOT/target"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; git -C "$ROOT" worktree prune; }
cleanup
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$WT" "$REF" >/dev/null

( cd "$WT/contract" && cargo near build non-reproducible-wasm --no-abi )
PREV_WASM="$WT/contract/target/near/purser_contract.wasm"
[ -s "$PREV_WASM" ] || { echo "upgrade-check: previous wasm was not built" >&2; exit 1; }
# keep the wasm outside the worktree, which is deleted on exit
cp "$PREV_WASM" "$ROOT/target/upgrade-prev.wasm"

cd "$ROOT/contract"
export NEAR_SANDBOX_BIN_PATH="${NEAR_SANDBOX_BIN_PATH:-$("$ROOT/scripts/sandbox-bin.sh")}"
PURSER_WASM_PREV="$ROOT/target/upgrade-prev.wasm" cargo test --test upgrade -- --ignored --nocapture
