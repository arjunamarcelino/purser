#!/usr/bin/env bash
# Replay the Purser demo on NEAR TESTNET: outcomes 1-6 live with verified tx refs, then outcome 7
# (timeout, reservation retained) as a labeled SANDBOX replay. Never targets mainnet.
#
#   ./scripts/deploy-testnet.sh && ./scripts/demo.sh
#
# Each run uses a fresh task (`demo-<RUN_ID>`): revocation is permanent, so a task cannot be replayed.
# A failed run is simply re-run (a new RUN_ID is generated). Cost per run: ~90 of 100 units of the
# demo cap (DEMO_CAP_NEAR, default 1 NEAR; e.g. 0.5 for a thin wallet) leave the contract for the operator's own merchant
# sub-accounts, plus a few thousandths of a NEAR in gas.
#
# Env: RUN_ID (default: UTC timestamp), DEMO_CAP_NEAR (default 1). Network, wasm and key paths
# cannot be overridden here; the RPC may be replaced by an https:// URL (its chain_id is checked).

set -euo pipefail

die() { echo "demo: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env.testnet"
[ -z "${WASM:-}" ] || die "WASM cannot be overridden (the demo only uses the built production wasm)"
WASM="$ROOT/contract/target/near/purser_contract.wasm"
OPS=(node "$ROOT/proposer/src/dev/testnet-ops.ts")
umask 077

[ -z "${NEAR_NETWORK:-}" ] || [ "$NEAR_NETWORK" = "testnet" ] || die "NEAR_NETWORK must be testnet (got '$NEAR_NETWORK'); this never touches mainnet"
[ -z "${NEAR_RPC_URL:-}" ] || [[ "$NEAR_RPC_URL" == https://* ]] || die "NEAR_RPC_URL must be https://"
export NEAR_NETWORK=testnet

# Preflight.
case "$(node -v 2>/dev/null || true)" in v26.*) ;; *) die "Node 26.x required (found '$(node -v 2>/dev/null || echo none)')" ;; esac
command -v pnpm >/dev/null || die "pnpm not found (corepack enable)"
command -v near >/dev/null || die "near-cli-rs not found: npm i -g near-cli-rs@0.30.1"
[ -d "$ROOT/node_modules" ] || die "dependencies missing: run 'make ts-install'"
[ -f "$ENVFILE" ] || die "$ENVFILE missing: run ./scripts/deploy-testnet.sh first"
perm="$(stat -c %a "$ENVFILE" 2>/dev/null || stat -f %Lp "$ENVFILE")"   # GNU first: BSD stat rejects -c, GNU stat accepts -f with other meaning
[ "$perm" = "600" ] || die "$ENVFILE must be mode 0600 (is $perm): chmod 600 .env.testnet"

# Non-secret values only; the key lines in .env.testnet are never read or printed by this script.
envval() { grep -E "^$1=" "$ENVFILE" | head -1 | cut -d= -f2- || true; }
OPERATOR_ACCOUNT_ID="$(envval OPERATOR_ACCOUNT_ID)"
CONTRACT="$(envval PURSER_CONTRACT_ID)"
RPC="${NEAR_RPC_URL:-$(envval NEAR_RPC_URL)}"
[[ "$RPC" == https://* ]] || die "NEAR_RPC_URL must be https:// (check NEAR_RPC_URL in .env.testnet)"
[ -n "$CONTRACT" ] || die "PURSER_CONTRACT_ID missing from .env.testnet: re-run ./scripts/deploy-testnet.sh"
[ -n "$OPERATOR_ACCOUNT_ID" ] || die "OPERATOR_ACCOUNT_ID missing from .env.testnet: re-run ./scripts/deploy-testnet.sh"
[[ "$OPERATOR_ACCOUNT_ID" =~ ^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$ ]] && [ "${#OPERATOR_ACCOUNT_ID}" -le 64 ] \
  || die "OPERATOR_ACCOUNT_ID must be a named .testnet account"
[ "$CONTRACT" = "purser.$OPERATOR_ACCOUNT_ID" ] || die "PURSER_CONTRACT_ID '$CONTRACT' is not purser.$OPERATOR_ACCOUNT_ID"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
[[ "$RUN_ID" =~ ^[a-z0-9-]{1,32}$ ]] || die "RUN_ID must match ^[a-z0-9-]{1,32}\$"
DEMO_CAP_NEAR="${DEMO_CAP_NEAR:-1}"
[[ "$DEMO_CAP_NEAR" =~ ^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$ ]] || die "DEMO_CAP_NEAR must be a NEAR amount with up to 3 decimals (e.g. 1 or 0.5)"

"$ROOT/scripts/check-wasm-clean.sh" "$WASM" >/dev/null   # the deployed build must be the production one
"${OPS[@]}" chain-id "$RPC" >/dev/null                  # the RPC itself must report testnet
matches="$("${OPS[@]}" code-matches "$RPC" "$CONTRACT" "$WASM")" || die "could not check the deployed code on $CONTRACT (RPC error above)"
[ "$matches" = "yes" ] \
  || die "the deployed code on $CONTRACT does not match the built wasm: re-run ./scripts/deploy-testnet.sh"
funds="$("${OPS[@]}" can-fund "$RPC" "$CONTRACT" "$DEMO_CAP_NEAR")"
[ "$funds" = "yes" ] || die "${funds#no: } — its wasm locks ~2.6 NEAR as storage stake. Top it up, e.g.: near tokens $OPERATOR_ACCOUNT_ID send-near $CONTRACT '1 NEAR' network-config testnet sign-with-keychain send"

echo "== LIVE on NEAR testnet — outcomes 1-6 =="
RUN_ID="$RUN_ID" OPERATOR_ACCOUNT_ID="$OPERATOR_ACCOUNT_ID" DEMO_CAP_NEAR="$DEMO_CAP_NEAR" \
  pnpm --silent --filter @purser/proposer run demo

echo
echo "== SANDBOX (not testnet) — outcome 7: timeout on an issued payment, reservation retained =="
echo "The shipped wasm cannot be made to lose a callback, so this replays attack-suite case 7 on a"
echo "local chain with the test-only fault build. No transaction below is on testnet."
BIN="$("$ROOT/scripts/sandbox-bin.sh")"
# A scrubbed environment: no testnet key or env file is visible to the cargo process.
replay="$( ( cd "$ROOT/contract" && env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" NEAR_SANDBOX_BIN_PATH="$BIN" \
    cargo test --test attacks case_7_timeout_on_issued_payment_reservation_retained -- --nocapture --test-threads=1 ) 2>&1 )" \
  || { echo "$replay" | { grep -vE 'testnet\.nearblocks|ed25519:' || true; } | tail -40; die "sandbox replay of outcome 7 FAILED"; }
echo "$replay" | { grep -vE 'testnet\.nearblocks|ed25519:' || true; } | tail -40
case "$replay" in
  *"test result: ok. 1 passed"*) ;;
  *) die "sandbox replay of outcome 7 did not run exactly one passing test (no 'test result: ok. 1 passed')" ;;
esac

echo
echo "Done: 6 live outcomes verified on testnet + 1 sandbox replay. Contract: https://testnet.nearblocks.io/address/$CONTRACT"
