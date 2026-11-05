#!/usr/bin/env bash
# Deploy Purser to NEAR TESTNET and provision the proposer crew. Idempotent: re-running skips
# whatever already exists. Never targets mainnet: every step is pinned to `network-config testnet`
# and the RPC's own chain_id is checked first.
#
#   OPERATOR_ACCOUNT_ID=<you>.testnet scripts/deploy-testnet.sh
#
# Needs: near-cli-rs (`near`), pnpm deps installed, the operator's key in the near-cli keychain,
# and enough testnet NEAR on the operator (~3 x CAP_NEAR + 3; get some from the faucet).
#
# Creates (all sub-accounts of the operator):
#   purser.<op>                       the contract; owner = <op> (never the contract account itself)
#   scout|forge|buyer.<op>            delegates; full-access keys stay in the near-cli keychain
#   data|compute|procure|attacker.<op> merchants (attacker is NOT allowlisted)
#   tasks <TASK_PREFIX>-legit|race|rogue, each capped at CAP_NEAR
# Each delegate gets a function-call key (receiver = purser.<op>, method = propose_payment only).
# Its private key is written to .near-keys/<persona>.key (0600, gitignored) and into .env.testnet
# (0600, gitignored) for the proposer — the only secret the proposer ever holds.
#
# Revoking a delegate is two steps: `near account delete-keys <persona> ...` (kills the key) and
# owner `revoke_delegate` (blocks new authorizations). Neither can recall a payment already made.

set -euo pipefail

: "${OPERATOR_ACCOUNT_ID:?set OPERATOR_ACCOUNT_ID=<you>.testnet}"
NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
CAP_NEAR="${CAP_NEAR:-2}"
TASK_PREFIX="${PROPOSER_TASK_ID:-demo}"
FC_ALLOWANCE_NEAR="${FC_ALLOWANCE_NEAR:-0.25}"   # measured use ~0.0006 NEAR per proposal

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$ROOT/contract/target/near/purser_contract.wasm"
OPS=(node "$ROOT/proposer/src/dev/testnet-ops.ts")
KEYS="$ROOT/.near-keys"
OUT_ENV="$ROOT/.env.testnet"

die() { echo "deploy-testnet: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[ "$NEAR_NETWORK" = "testnet" ] || die "NEAR_NETWORK must be testnet (got '$NEAR_NETWORK'); this script never touches mainnet"
[[ "$OPERATOR_ACCOUNT_ID" =~ ^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$ ]] \
  || die "OPERATOR_ACCOUNT_ID must be a named .testnet account (it is spliced into JSON args)"
[[ "$TASK_PREFIX" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "PROPOSER_TASK_ID must be lowercase letters, digits and dashes"
[[ "$CAP_NEAR" =~ ^[1-9][0-9]{0,3}$ ]] || die "CAP_NEAR must be a whole number of NEAR (1-9999)"
[[ "$FC_ALLOWANCE_NEAR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "FC_ALLOWANCE_NEAR must be a decimal number"
# Toolchain: report what is missing with the fix; install nothing that needs a login.
hint_node="Node 26 (https://nodejs.org), then: corepack enable"
hint_pnpm="corepack enable   (pnpm 10 ships with Node's corepack)"
hint_near="npm i -g near-cli-rs@0.30.1   (or: cargo install near-cli-rs --version 0.30.1 --locked)"
hint_cargo_near="curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh"
missing=0
for tool in node pnpm near cargo-near; do
  if ! command -v "$tool" >/dev/null 2>&1 && ! [ -x "$HOME/.cargo/bin/$tool" ]; then
    hint="hint_${tool//-/_}"
    echo "deploy-testnet: missing $tool — ${!hint}" >&2
    missing=1
  fi
done
[ "$missing" = 0 ] || die "install the tools above, then re-run"
case "$(node -v)" in v26.*) ;; *) die "Node 26.x required (found $(node -v)); the .ts helpers run on Node's type stripping" ;; esac
[ -f "$WASM" ] || die "missing $WASM — run: make build   (never bare cargo build: near-sdk blocks it)"
"$ROOT/scripts/check-wasm-clean.sh" "$WASM" >/dev/null   # never deploy a fault-injection build
"${OPS[@]}" chain-id "$RPC" >/dev/null                  # the RPC itself must report testnet

OP="$OPERATOR_ACCOUNT_ID"
CONTRACT="purser.$OP"
TX=(network-config testnet sign-with-keychain send)

# Funding preflight. A brand-new account has no testnet NEAR; the sponsor route is
# `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair
# save-to-keychain network-config testnet create` (faucet limits are not published: see README).
"${OPS[@]}" account-exists "$RPC" "$OP" | grep -qx yes \
  || die "$OP does not exist on testnet — create and fund it first (README, 'Fresh account')"
if [ "$("${OPS[@]}" account-exists "$RPC" "$CONTRACT")" != "yes" ]; then
  need=$((CAP_NEAR * 3 + 6))   # contract float + 7 sub-accounts + gas headroom
  have="$("${OPS[@]}" balance "$RPC" "$OP")"
  [ "$have" -ge "$need" ] || die "$OP has ~$have NEAR, a first deploy needs ~$need (CAP_NEAR=$CAP_NEAR); fund it, then re-run"
fi

# near-cli prints a full transcript (to stderr) for every call; keep it, and show it only on failure.
near_quiet() {
  local out
  if ! out="$(near "$@" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "near $1 $2 failed (transcript above)"
  fi
}
exists() { [ "$("${OPS[@]}" account-exists "$RPC" "$1")" = "yes" ]; }
view() { "${OPS[@]}" view "$RPC" "$CONTRACT" "$1" "$2"; }
call() { # call <method> <json-args>  (as the owner)
  near_quiet contract call-function as-transaction "$CONTRACT" "$1" json-args "$2" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OP" "${TX[@]}"
}
subaccount() { # subaccount <id> <near>  (full-access key into the near-cli keychain)
  if exists "$1"; then echo "    $1 exists"; return; fi
  near_quiet account create-account fund-myself "$1" "$2 NEAR" autogenerate-new-keypair save-to-keychain \
    sign-as "$OP" "${TX[@]}"
  echo "    created $1"
}

step "accounts"
subaccount "$CONTRACT" "$((CAP_NEAR * 3 + 2))"
for m in data compute procure attacker; do subaccount "$m.$OP" 0.1; done
for p in scout forge buyer; do subaccount "$p.$OP" 0.5; done

step "contract"
if [ "$("${OPS[@]}" code-matches "$RPC" "$CONTRACT" "$WASM")" = "yes" ]; then
  echo "    code already deployed (sha256 matches)"
else
  if [ "$("${OPS[@]}" has-code "$RPC" "$CONTRACT")" = "yes" ]; then   # an RPC error aborts (set -e); it never reads as "empty"
    near_quiet contract deploy "$CONTRACT" use-file "$WASM" without-init-call "${TX[@]}"
    echo "    upgraded code (state kept)"
  else
    init_args="{\"owner\":\"$OP\",\"signer_id\":\"v1.signer-prod.testnet\"}"
    near_quiet contract deploy "$CONTRACT" use-file "$WASM" with-init-call new \
      json-args "$init_args" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${TX[@]}"
    echo "    deployed and initialized (owner $OP)"
  fi
fi

step "tasks (cap $CAP_NEAR NEAR each)"
CAP_YOCTO="${CAP_NEAR}$(printf '0%.0s' {1..24})"
for s in legit race rogue; do
  t="$TASK_PREFIX-$s"
  # JSON goes in a variable first: macOS's bash 3.2 mangles escaped quotes inside "$(...)" and then
  # brace-expands the commas, splitting the JSON into separate words.
  args="{\"task_id\":\"$t\"}"
  if [ "$(view get_task "$args")" = "null" ]; then
    call create_task "{\"task_id\":\"$t\",\"cap\":\"$CAP_YOCTO\",\"token\":\"NearNative\",\"crew_cap\":3}"
    echo "    created $t"
  else
    echo "    $t exists"
  fi
  for p in scout forge buyer; do
    args="{\"task_id\":\"$t\",\"account_id\":\"$p.$OP\"}"
    if [ "$(view is_delegate_authorized "$args")" != "true" ]; then
      call add_delegate "{\"task_id\":\"$t\",\"account_id\":\"$p.$OP\",\"derivation_path\":\"purser/$t/$p\"}"
    fi
  done
  call set_recipient_allowlist "{\"task_id\":\"$t\",\"recipients\":[\"data.$OP\",\"compute.$OP\",\"procure.$OP\"]}"
done

step "function-call keys (propose_payment only, allowance $FC_ALLOWANCE_NEAR NEAR)"
mkdir -p "$KEYS" && chmod 700 "$KEYS"
for p in scout forge buyer; do
  keyfile="$KEYS/$p.key"
  if [ -f "$keyfile" ]; then
    pk="$("${OPS[@]}" pubkey "$keyfile")"
  else
    pk="$("${OPS[@]}" keygen "$keyfile")"
  fi
  if ! "${OPS[@]}" verify-fc-key "$RPC" "$p.$OP" "$pk" "$CONTRACT" 0 >/dev/null 2>&1; then
    near_quiet account add-key "$p.$OP" grant-function-call-access \
      --allowance "$FC_ALLOWANCE_NEAR NEAR" --contract-account-id "$CONTRACT" --function-names propose_payment \
      use-manually-provided-public-key "$pk" "${TX[@]}"
    echo "    added key for $p.$OP"
  fi
  # Assert the on-chain scope; fail loudly if the key could do anything but propose_payment.
  "${OPS[@]}" verify-fc-key "$RPC" "$p.$OP" "$pk" "$CONTRACT" 0.01 >/dev/null || die "function-call key for $p.$OP failed verification"
  echo "    $p.$OP: key scoped to $CONTRACT.propose_payment ✓"
done

step "writing $OUT_ENV (0600, gitignored)"
# Write to a fresh 0600 temp file and move it into place: a pre-existing, world-readable
# .env.testnet must not keep its permissions once it holds keys.
umask 077
tmp_env="$(mktemp "$ROOT/.env.testnet.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT
{
  echo "# Written by scripts/deploy-testnet.sh — testnet only. Contains function-call keys; never commit."
  echo "NEAR_NETWORK=testnet"
  echo "NEAR_RPC_URL=$RPC"
  echo "PURSER_CONTRACT_ID=$CONTRACT"
  echo "OPERATOR_ACCOUNT_ID=$OP"
  echo "PROPOSER_TASK_ID=$TASK_PREFIX"
  for p in scout forge buyer; do
    P="$(echo "$p" | tr '[:lower:]' '[:upper:]')"
    echo "PROPOSER_${P}_ACCOUNT_ID=$p.$OP"
    echo "PROPOSER_${P}_FC_PRIVATE_KEY=$(cat "$KEYS/$p.key")"
  done
  echo "PROPOSER_MERCHANT_DATA=data.$OP"
  echo "PROPOSER_MERCHANT_COMPUTE=compute.$OP"
  echo "PROPOSER_MERCHANT_PROCUREMENT=procure.$OP"
  echo "PROPOSER_MERCHANT_ATTACKER=attacker.$OP"
} > "$tmp_env"
chmod 600 "$tmp_env"
mv -f "$tmp_env" "$OUT_ENV"
trap - EXIT

echo
echo "PURSER_CONTRACT_ID=$CONTRACT   (written to .env.testnet)"
echo "Done. Replay the demo:  ./scripts/demo.sh      Run the crew:  make crew NETWORK=testnet"
echo "Explorer: https://testnet.nearblocks.io/address/$CONTRACT"
