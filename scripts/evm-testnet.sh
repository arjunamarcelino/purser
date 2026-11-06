#!/usr/bin/env bash
# Stand up and drive the governed EVM payment path on NEAR TESTNET + Sepolia. Never mainnet.
# Idempotent: every step reads chain state first and skips what is already done; re-run freely.
#
#   scripts/evm-testnet.sh deploy                       fresh contract + relayer + delegate, lane key cached, nonce seeded
#   scripts/evm-testnet.sh status                       what exists, the lane address + Sepolia balance, ready checklist
#   scripts/evm-testnet.sh propose [--value-wei N] [--to 0x..]   one payment as the delegate (spends Sepolia ETH)
#   scripts/evm-testnet.sh confirm-release <cid>        owner: release an Unknown commitment that has release evidence
#   scripts/evm-testnet.sh set-ceiling <maxFeeWei> <tipWei>      owner: change the fee ceilings (other cfg kept)
#
# Needs: near-cli-rs 0.30.1 (operator key in the keychain), Node 26, pnpm deps, jq, bc.
# Env (all optional): OPERATOR_ACCOUNT_ID (else .env.testnet), EVM_CONTRACT_ID (default purser2.<op>),
#   EVM_RELAYER_ID (relayer2.<op>), EVM_DELEGATE_ID (evmscout.<op>), EVM_TASK_ID (evm-sepolia),
#   EVM_DERIVATION_PATH (evm-sepolia-1), EVM_CAP_WEI (10000000000000000 = 0.01 ETH),
#   NEAR_RPC_URL (https), EVM_RPC_URL (https; read-only reads here, broadcasts by the relayer).
#
# Writes (0600, gitignored): .near-keys/relayer2.key, .near-keys/evmscout.key, .near-keys/evm-txs.log and, merged into
# .env.testnet WITHOUT touching PURSER_CONTRACT_ID (the demo/board contract): EVM_PURSER_CONTRACT_ID, RELAYER_ACCOUNT_ID,
# RELAYER_PRIVATE_KEY, EVM_DELEGATE_ACCOUNT_ID, EVM_DELEGATE_FC_PRIVATE_KEY, EVM_TASK_ID, EVM_DERIVATION_PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env.testnet"
KEYS="$ROOT/.near-keys"
TXLOG="$KEYS/evm-txs.log"
WASM="$ROOT/contract/target/near/purser_contract.wasm"
OPS=(node "$ROOT/proposer/src/dev/testnet-ops.ts")
SIGNER="v1.signer-prod.testnet"
SEPOLIA_CHAIN_ID=11155111
umask 077

die() { echo "evm-testnet: $*" >&2; exit 1; }
step() { echo "==> $*"; }
# Masks key material AND any URL (a provider URL carries its API key; near-api-js errors embed the request URL).
scrub() { sed -E 's/ed25519:[A-Za-z0-9]{40,}/ed25519:[redacted]/g; s/secp256k1:[A-Za-z0-9]{40,}/secp256k1:[redacted]/g; s#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]"'"'"'<>)]+#[url]#g'; }
scrub_selftest() { # a canary URL (path and query key) and a canary key must not survive scrub()
  local canary_key="CANARYKEY0123456789abcdef" out
  out="$(printf 'POST https://rpc.example.invalid/v3/%s failed; see %s and %s\n' "$canary_key" "http://h.example.invalid:8545/x?k=$canary_key" "ed25519:$(printf 'Q%.0s' {1..50})" | scrub)"
  case "$out" in *CANARY*|*example.invalid*|*QQQQQQQQQQ*) die "scrub() self-test failed (a canary survived): $out" ;; esac
}

# ---- config ----------------------------------------------------------------------------------------
# Read one KEY from .env.testnet without sourcing it (it holds secrets and is not trusted shell).
envval() { { [ -f "$ENVFILE" ] && grep -E "^$1=" "$ENVFILE" | tail -1 | cut -d= -f2-; } || true; }

[ "${NEAR_NETWORK:-testnet}" = "testnet" ] || die "NEAR_NETWORK must be testnet (got '${NEAR_NETWORK:-}'); this never touches mainnet"
OP="${OPERATOR_ACCOUNT_ID:-$(envval OPERATOR_ACCOUNT_ID)}"
RPC="${NEAR_RPC_URL:-$(envval NEAR_RPC_URL)}"; RPC="${RPC:-https://test.rpc.fastnear.com}"
EVM_RPC="${EVM_RPC_URL:-$(envval EVM_RPC_URL)}"; EVM_RPC="${EVM_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
[ -n "$OP" ] || die "set OPERATOR_ACCOUNT_ID=<you>.testnet (or put it in .env.testnet)"
ACCT_RE='^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$'
[[ "$OP" =~ $ACCT_RE ]] || die "OPERATOR_ACCOUNT_ID must be a named .testnet account"
[[ "$RPC" == https://* ]] || die "NEAR_RPC_URL must be https://"
[[ "$EVM_RPC" == https://* ]] || die "EVM_RPC_URL must be https://"

CONTRACT="${EVM_CONTRACT_ID:-purser2.$OP}"
RELAYER="${EVM_RELAYER_ID:-relayer2.$OP}"
DELEGATE="${EVM_DELEGATE_ID:-evmscout.$OP}"
TASK="${EVM_TASK_ID:-evm-sepolia}"
DPATH="${EVM_DERIVATION_PATH:-evm-sepolia-1}"
CAP_WEI="${EVM_CAP_WEI:-10000000000000000}"
FC_ALLOWANCE_NEAR="${FC_ALLOWANCE_NEAR:-0.25}"
for id in "$CONTRACT" "$RELAYER" "$DELEGATE"; do
  [[ "$id" =~ $ACCT_RE ]] || die "'$id' is not a valid .testnet account id"
  [[ "$id" == *".$OP" && "${id%".$OP"}" != *.* ]] || die "'$id' must be a direct subaccount of $OP"
done
[ "$CONTRACT" != "purser.$OP" ] && [ "$CONTRACT" != "$(envval PURSER_CONTRACT_ID)" ] \
  || die "EVM_CONTRACT_ID must not be the existing demo/board contract (purser.$OP / PURSER_CONTRACT_ID)"
[ "$RELAYER" != "$DELEGATE" ] && [ "$RELAYER" != "$CONTRACT" ] && [ "$DELEGATE" != "$CONTRACT" ] || die "contract, relayer and delegate ids must differ"
[[ "$TASK" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "EVM_TASK_ID must be lowercase letters, digits and dashes"
[[ "$DPATH" =~ ^[a-z0-9][a-z0-9-]{0,60}$ ]] || die "EVM_DERIVATION_PATH must be lowercase letters, digits and dashes"
[[ "$CAP_WEI" =~ ^[1-9][0-9]{0,30}$ ]] || die "EVM_CAP_WEI must be a decimal wei amount"
[[ "$FC_ALLOWANCE_NEAR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "FC_ALLOWANCE_NEAR must be a decimal number"

# Desired EVM config (owner-set ceilings; the contract validates them again).
CFG_MAX_FEE=2000000000            # 2 gwei
CFG_TIP=1000000000                # 1 gwei
CFG_MIN_VALUE=1000000000000       # 1e12 wei
CFG_MIN_UNKNOWN_NS=300000000000   # the 5-minute floor

RELAYER_METHODS="attest_external,mark_unknown,request_cancel"
TX=(network-config testnet sign-with-keychain send)

# ---- plumbing --------------------------------------------------------------------------------------
LANDED=()
mkdir -p "$KEYS" && chmod 700 "$KEYS"
ERRF="$(mktemp)"
report_landed() {
  local rc=$?
  rm -f "$ERRF"
  if [ "$rc" -ne 0 ] && [ "${#LANDED[@]}" -gt 0 ]; then
    echo "evm-testnet: stopped with exit $rc. Transactions that landed (verified on chain) in this run:" >&2
    local l; for l in "${LANDED[@]}"; do echo "    $l" >&2; done
    echo "    (full history: $TXLOG; re-run the same subcommand to continue)" >&2
  fi
  if [ "$rc" -ne 0 ] && [ "${#UNVERIFIED[@]}" -gt 0 ]; then
    echo "evm-testnet: transactions SENT but NOT verified on chain (check each before re-running):" >&2
    local u; for u in "${UNVERIFIED[@]}"; do echo "    $u" >&2; done
  fi
}
trap report_landed EXIT

link() { echo "https://testnet.nearblocks.io/txns/$1"; }
# A hash parsed from near's output is only a claim until testnet-ops re-read it from the chain (it then prints
# `TX <hash>`). "landed" is logged ONLY for a verified hash; otherwise "sent, unverified".
UNVERIFIED=()
record_tx() { # <label> <hash> <verified: yes|no>
  local line; line="$1: $(link "$2")"
  if [ "${3:-no}" = yes ]; then
    LANDED+=("$line")
    echo "    tx landed $line"
    printf '%s landed %s\n' "$(date -u +%FT%TZ)" "$line" >> "$TXLOG"
  else
    UNVERIFIED+=("$line")
    echo "    tx sent, unverified (check it before re-running) $line"
    printf '%s sent-unverified %s\n' "$(date -u +%FT%TZ)" "$line" >> "$TXLOG"
  fi
}

# Read-only call with backoff (public RPCs answer 429). Reads are idempotent; writes never go through here.
ro() {
  local i=0 out
  while :; do
    if out="$("$@" 2>"$ERRF")"; then printf '%s\n' "$out"; return 0; fi
    i=$((i + 1))
    if [ "$i" -ge 5 ]; then scrub < "$ERRF" >&2; return 1; fi
    sleep $((2 ** i))
  done
}
view() { ro "${OPS[@]}" view "$RPC" "$CONTRACT" "$1" "$2"; }
exists() { [ "$(ro "${OPS[@]}" account-exists "$RPC" "$1")" = "yes" ]; }

# One near-cli send: spawned with a timeout and scrubbed env inside testnet-ops, the tx id parsed from stderr and
# re-read from the chain. A failure after a parsed hash still records that hash (it may have landed).
ntx() { # <label> <signer> <near args...>
  local label="$1" signer="$2" out rc=0 h v
  shift 2
  out="$("${OPS[@]}" near-tx "$RPC" "$signer" "$label" -- "$@" 2>"$ERRF")" || rc=$?
  h="$(printf '%s\n' "$out" | sed -n 's/^TXHASH //p' | head -1)"
  v="$(printf '%s\n' "$out" | sed -n 's/^TX //p' | head -1)"
  if [ -n "$h" ]; then
    if [ "$rc" -eq 0 ] && [ "$v" = "$h" ]; then record_tx "$label" "$h" yes; else record_tx "$label" "$h" no; fi
  fi
  if [ "$rc" -ne 0 ]; then
    scrub < "$ERRF" >&2
    die "$label failed (see above); do not blind-retry: re-run this script, it reads chain state first"
  fi
}
ocall() { # <method> <json-args> [gas]   (as the owner/operator)
  ntx "owner $1" "$OP" contract call-function as-transaction "$CONTRACT" "$1" json-args "$2" \
    prepaid-gas "${3:-30 Tgas}" attached-deposit '0 NEAR' sign-as "$OP" "${TX[@]}"
}
subaccount() { # <id> <near>
  if exists "$1"; then echo "    $1 exists"; return; fi
  ntx "create $1" "$OP" account create-account fund-myself "$1" "$2 NEAR" autogenerate-new-keypair save-to-keychain sign-as "$OP" "${TX[@]}"
}
chk_tools() {
  local t
  for t in node pnpm near jq bc; do command -v "$t" >/dev/null 2>&1 || die "missing $t"; done
  case "$(node -v)" in v26.*) ;; *) die "Node 26.x required (found $(node -v))" ;; esac
  scrub_selftest
  "${OPS[@]}" selftest >/dev/null || die "testnet-ops self-test failed"
  "${OPS[@]}" chain-id "$RPC" >/dev/null || die "NEAR RPC does not report testnet"
}
fmt_eth() { echo "scale=6; $1 / 1000000000000000000" | bc; }
fmt_near() { echo "scale=3; $1 / 1000000000000000000000000" | bc; }
lane_json() { view evm_lane "{\"path\":\"$DPATH\"}"; }

# A fresh function-call key for <account>, restricted to $CONTRACT + exactly these methods. Idempotent via the key file.
fckey() { # <account> <keyfile> <csv-methods>
  local acct="$1" file="$2" methods="$3" pk
  if [ -f "$file" ]; then pk="$("${OPS[@]}" pubkey "$file")"; else pk="$("${OPS[@]}" keygen "$file")"; fi
  if ! "${OPS[@]}" verify-fc-methods "$RPC" "$acct" "$pk" "$CONTRACT" 0.01 "$methods" >/dev/null 2>&1; then
    ntx "add-key $acct" "$acct" account add-key "$acct" grant-function-call-access \
      --allowance "$FC_ALLOWANCE_NEAR NEAR" --contract-account-id "$CONTRACT" --function-names "$methods" \
      use-manually-provided-public-key "$pk" "${TX[@]}"
  fi
  ro "${OPS[@]}" verify-fc-methods "$RPC" "$acct" "$pk" "$CONTRACT" 0.01 "$methods" >/dev/null || die "key for $acct failed on-chain scope verification"
  echo "    $acct: key scoped to $CONTRACT.{$methods}, allowance >= 0.01 NEAR ✓"
}

# ---- deploy ----------------------------------------------------------------------------------------
cmd_deploy() {
  chk_tools
  step "operator $OP, contract $CONTRACT, relayer $RELAYER, delegate $DELEGATE (testnet; Sepolia chain $SEPOLIA_CHAIN_ID)"
  exists "$OP" || die "$OP does not exist on testnet"

  step "build the wasm (make build; never bare cargo build)"
  make -C "$ROOT" build >/dev/null 2>"$ERRF" || { scrub < "$ERRF" | tail -20 >&2; die "make build failed"; }
  [ -f "$WASM" ] || die "missing $WASM after make build"
  "$ROOT/scripts/check-wasm-clean.sh" "$WASM" >/dev/null || die "wasm failed the fault-injection gate"
  local size; size="$(wc -c < "$WASM" | tr -d ' ')"

  # Funding: the contract keeps size*1e19 yocto locked as storage stake, plus 1.5 NEAR for state, signer deposits and
  # callbacks. Relayer and delegate need gas money (a function-call key's allowance is a cap, not a deposit).
  local stake_cent=$((size / 1000 + 1)) contract_cent contract_fund
  contract_cent=$((stake_cent + 150))
  contract_fund="$(printf '%d.%02d' $((contract_cent / 100)) $((contract_cent % 100)))"
  local acct_fund="0.4" need_cent=0
  exists "$CONTRACT" || need_cent=$((need_cent + contract_cent))
  exists "$RELAYER" || need_cent=$((need_cent + 40))
  exists "$DELEGATE" || need_cent=$((need_cent + 40))
  if [ "$need_cent" -gt 0 ]; then need_cent=$((need_cent + 50)); fi   # operator gas margin
  local spend have_cent
  spend="$(ro "${OPS[@]}" spendable "$RPC" "$OP")"
  have_cent="$(echo "$spend / 10000000000000000000000" | bc)"
  echo "    wasm $size bytes (storage stake ~$(echo "scale=2; $stake_cent / 100" | bc) NEAR); contract would be funded with $contract_fund NEAR"
  echo "    operator spendable ~$(fmt_near "$spend") NEAR; this run needs ~$(echo "scale=2; $need_cent / 100" | bc) NEAR"
  if [ "$have_cent" -lt "$need_cent" ]; then
    die "operator $OP has insufficient spendable NEAR (have ~$(fmt_near "$spend"), need ~$(echo "scale=2; $need_cent / 100" | bc)). Nothing was created. Fund it from the testnet faucet, then re-run."
  fi

  step "accounts"
  subaccount "$CONTRACT" "$contract_fund"
  subaccount "$RELAYER" "$acct_fund"
  subaccount "$DELEGATE" "$acct_fund"

  step "contract code"
  if [ "$(ro "${OPS[@]}" code-matches "$RPC" "$CONTRACT" "$WASM")" = "yes" ]; then
    echo "    code already deployed (sha256 matches)"
  else
    if [ "$(ro "${OPS[@]}" has-code "$RPC" "$CONTRACT")" = "yes" ]; then
      die "$CONTRACT already has DIFFERENT code; refusing to upgrade a state-bearing EVM contract from this script"
    fi
    "$ROOT/scripts/check-wasm-clean.sh" "$WASM" >/dev/null || die "wasm failed the fault-injection gate; refusing to deploy"
    local init_args="{\"owner\":\"$OP\",\"signer_id\":\"$SIGNER\"}"
    ntx "deploy+new $CONTRACT" "$CONTRACT" contract deploy "$CONTRACT" use-file "$WASM" with-init-call new \
      json-args "$init_args" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${TX[@]}"
    [ "$(ro "${OPS[@]}" code-matches "$RPC" "$CONTRACT" "$WASM")" = "yes" ] || die "deployed code hash does not match $WASM"
  fi
  echo "    on-chain code hash == sha256($WASM) = $(shasum -a 256 "$WASM" | cut -d' ' -f1) ✓"
  view get_evm_cfg '{}' >/dev/null || die "$CONTRACT does not answer get_evm_cfg: not the EVM build"

  step "function-call keys (fresh, scoped; private keys only in $KEYS and .env.testnet)"
  fckey "$RELAYER" "$KEYS/relayer2.key" "$RELAYER_METHODS"
  fckey "$DELEGATE" "$KEYS/evmscout.key" "propose_payment"

  step "owner setup"
  local cur
  cur="$(view get_relayer '{}')"
  if [ "$cur" != "\"$RELAYER\"" ]; then ocall set_relayer "{\"relayer\":\"$RELAYER\"}"; else echo "    relayer already $RELAYER"; fi

  local want_cfg got_cfg
  got_cfg="$(view get_evm_cfg '{}')"
  want_cfg="$(jq -nc --arg c "$SEPOLIA_CHAIN_ID" --arg f "$CFG_MAX_FEE" --arg t "$CFG_TIP" --arg m "$CFG_MIN_VALUE" --arg a "$CFG_MIN_UNKNOWN_NS" \
    '{chain_id:$c,max_fee_ceiling:$f,max_priority_ceiling:$t,min_value:$m,min_unknown_age_ns:$a}')"
  if [ "$got_cfg" != "null" ] && [ "$(printf '%s' "$got_cfg" | jq -c '{chain_id,max_fee_ceiling,max_priority_ceiling,min_value,min_unknown_age_ns}')" = "$want_cfg" ]; then
    echo "    evm cfg already set"
  else
    ocall set_evm_cfg "{\"chain_id\":\"$SEPOLIA_CHAIN_ID\",\"max_fee_ceiling\":\"$CFG_MAX_FEE\",\"max_priority_ceiling\":\"$CFG_TIP\",\"min_value\":\"$CFG_MIN_VALUE\",\"min_unknown_age_ns\":\"$CFG_MIN_UNKNOWN_NS\"}"
  fi

  local targs="{\"task_id\":\"$TASK\"}"
  local dargs="{\"task_id\":\"$TASK\",\"account_id\":\"$DELEGATE\"}"
  if [ "$(view get_task "$targs")" = "null" ]; then
    ocall create_task "{\"task_id\":\"$TASK\",\"cap\":\"$CAP_WEI\",\"token\":\"NearNative\",\"crew_cap\":1}"
  else echo "    task $TASK exists"; fi
  if [ "$(view task_unit "$targs")" != "\"wei\"" ]; then
    [ "$(view is_delegate_authorized "$dargs")" != "true" ] || die "task $TASK has a delegate but is not an EVM task"
    ocall enable_evm_task "$targs"
  else echo "    task $TASK is already an EVM task (unit wei)"; fi
  if [ "$(view is_delegate_authorized "$dargs")" != "true" ]; then
    ocall add_delegate "{\"task_id\":\"$TASK\",\"account_id\":\"$DELEGATE\",\"derivation_path\":\"$DPATH\"}"
  else echo "    delegate $DELEGATE already authorized"; fi

  step "cache the derived key (async callback; polling the lane view)"
  if [ "$(lane_json)" = "null" ]; then
    ocall cache_derived_key "$dargs" '100 Tgas'
    local i=0 wait=2
    while [ "$(lane_json)" = "null" ]; do
      i=$((i + 1))
      [ "$i" -le 12 ] || die "lane for path $DPATH still not cached after ~2 min; the callback may have rejected the key (see the DerivedKeyCached event of the tx above); the owner can retry cache_derived_key"
      sleep "$wait"; [ "$wait" -ge 10 ] || wait=$((wait + 2))
    done
  else echo "    lane already cached"; fi
  local addr
  addr="$(ro "${OPS[@]}" evm-verify-lane "$RPC" "$CONTRACT" "$SIGNER" "$DPATH")" || die "cached key does not match the signer's derived_public_key view"
  echo "    cached key == $SIGNER derived_public_key($CONTRACT, $DPATH); address recomputed independently: $addr ✓"

  step "seed the lane nonce (finalized count from Sepolia, read-only)"
  local seeded
  seeded="$(lane_json | jq -r '.next_nonce // "null"')"
  if [ "$seeded" = "null" ]; then
    local n
    n="$(ro "${OPS[@]}" eth-nonce "$EVM_RPC" "$addr")" || die "could not read the Sepolia nonce (or a tx is pending)"
    ocall seed_evm_nonce "{\"path\":\"$DPATH\",\"nonce\":\"$n\"}"
    seeded="$n"
  fi
  echo "    next_nonce = $seeded"

  step "write .env.testnet (merge; PURSER_CONTRACT_ID untouched)"
  ro "${OPS[@]}" env-merge "$ENVFILE" \
    "EVM_PURSER_CONTRACT_ID=$CONTRACT" "RELAYER_ACCOUNT_ID=$RELAYER" "RELAYER_PRIVATE""_KEY=@$KEYS/relayer2.key" \
    "EVM_DELEGATE_ACCOUNT_ID=$DELEGATE" "EVM_DELEGATE_FC_PRIVATE_KEY=@$KEYS/evmscout.key" \
    "EVM_TASK_ID=$TASK" "EVM_DERIVATION_PATH=$DPATH" >/dev/null
  chmod 600 "$ENVFILE"

  echo
  echo "================================================================================"
  echo " FUND THIS SEPOLIA ADDRESS: $addr"
  echo " It needs ~0.002 Sepolia ETH (one payment of 1e12 wei plus a 21000 x 2 gwei fee reserve)."
  echo " Faucets: https://sepoliafaucet.com  https://www.alchemy.com/faucets/ethereum-sepolia"
  echo "          https://cloud.google.com/application/web3/faucet/ethereum/sepolia  https://faucets.chain.link/sepolia"
  echo " Explorer: https://sepolia.etherscan.io/address/$addr"
  echo " Then:  scripts/evm-testnet.sh status     and     scripts/evm-testnet.sh propose"
  echo "================================================================================"
}

# ---- status ----------------------------------------------------------------------------------------
READY=1
mark() { if [ "$1" = ok ]; then echo "  [ok]   $2"; else echo "  [TODO] $2"; READY=0; fi; }
cmd_status() {
  chk_tools
  echo "contract:  $CONTRACT   (relayer account $RELAYER, delegate $DELEGATE, task $TASK, path $DPATH)"
  if ! exists "$CONTRACT" || [ "$(ro "${OPS[@]}" has-code "$RPC" "$CONTRACT")" != "yes" ]; then
    mark no "contract deployed (run: scripts/evm-testnet.sh deploy)"; echo; echo "NOT READY"; return 0
  fi
  local code="no"
  if [ -f "$WASM" ] && [ "$(ro "${OPS[@]}" code-matches "$RPC" "$CONTRACT" "$WASM")" = "yes" ]; then code="yes"; fi
  local relayer cfg task unit lane
  relayer="$(view get_relayer '{}')"; cfg="$(view get_evm_cfg '{}')"
  task="$(view get_task "{\"task_id\":\"$TASK\"}")"; unit="$(view task_unit "{\"task_id\":\"$TASK\"}")"
  lane="$(lane_json)"
  echo "owner:     $(printf '%s' "$task" | jq -r '.owner // "n/a (no task yet; operator is '"$OP"')"')"
  echo "relayer:   $relayer"
  echo "cfg:       $cfg"
  echo "task:      $(printf '%s' "$task" | jq -c '. // "none"') unit=$unit"
  local addr="" nonce="" inflight="" bal=""
  if [ "$lane" != "null" ]; then
    addr="$(printf '%s' "$lane" | jq -r .address)"; nonce="$(printf '%s' "$lane" | jq -r '.next_nonce // "unseeded"')"
    inflight="$(printf '%s' "$lane" | jq -r '.in_flight // "none"')"
    bal="$(ro "${OPS[@]}" eth-balance "$EVM_RPC" "$addr" || true)"
    echo "lane:      address $addr  next_nonce $nonce  in_flight $inflight"
    if [ -n "$bal" ]; then echo "sepolia:   balance $bal wei (~$(fmt_eth "$bal") ETH)  https://sepolia.etherscan.io/address/$addr"; fi
  else
    echo "lane:      not cached yet"
  fi
  echo "checklist:"
  if [ "$code" = yes ]; then mark ok "on-chain code hash equals the built wasm"; else mark no "on-chain code hash equals the built wasm (wasm missing or different)"; fi
  if [ "$relayer" = "\"$RELAYER\"" ]; then mark ok "relayer set to $RELAYER"; else mark no "relayer set to $RELAYER"; fi
  if [ "$cfg" != "null" ] && [ "$(printf '%s' "$cfg" | jq -r .chain_id)" = "$SEPOLIA_CHAIN_ID" ]; then mark ok "evm cfg set for chain $SEPOLIA_CHAIN_ID"; else mark no "evm cfg set for chain $SEPOLIA_CHAIN_ID"; fi
  if [ "$unit" = "\"wei\"" ]; then mark ok "task $TASK exists and is an EVM task"; else mark no "task $TASK exists and is an EVM task"; fi
  local dargs dres
  dargs="{\"task_id\":\"$TASK\",\"account_id\":\"$DELEGATE\"}"
  dres="$(view is_delegate_authorized "$dargs" || true)"
  if [ "$dres" = "true" ]; then mark ok "delegate $DELEGATE authorized"; else mark no "delegate $DELEGATE authorized"; fi
  if [ "$lane" != "null" ]; then mark ok "lane key cached"; else mark no "lane key cached"; fi
  if [ -n "$nonce" ] && [ "$nonce" != "unseeded" ]; then mark ok "lane nonce seeded ($nonce)"; else mark no "lane nonce seeded"; fi
  if [ -z "$inflight" ] || [ "$inflight" = "none" ]; then mark ok "lane free (no in-flight commitment)"; else mark no "lane free (in flight: $inflight)"; fi
  if [ -n "$bal" ] && [ "$(echo "$bal >= 2000000000000000" | bc)" = 1 ]; then mark ok "lane funded (>= 0.002 Sepolia ETH)"; else mark no "lane funded (>= 0.002 Sepolia ETH): FUND ${addr:-the lane address}"; fi
  echo
  if [ "$READY" = 1 ]; then echo "READY"; else echo "NOT READY"; fi
}

# ---- propose ---------------------------------------------------------------------------------------
cmd_propose() {
  local value="1000000000000" to="0x000000000000000000000000000000000000dEaD"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --value-wei) [ "$#" -ge 2 ] || die "--value-wei needs a value"; value="$2"; shift 2 ;;
      --to) [ "$#" -ge 2 ] || die "--to needs an address"; to="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [[ "$value" =~ ^[1-9][0-9]{0,30}$ ]] || die "--value-wei must be a positive integer"
  [[ "$to" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--to must be a 0x + 40 hex address"
  chk_tools
  [ -f "$KEYS/evmscout.key" ] || die "no delegate key at $KEYS/evmscout.key (run deploy first)"
  local lane cfg addr bal maxfee need
  lane="$(lane_json)"; [ "$lane" != "null" ] || die "lane not cached; run deploy"
  [ "$(printf '%s' "$lane" | jq -r '.next_nonce // "null"')" != "null" ] || die "lane nonce not seeded"
  [ "$(printf '%s' "$lane" | jq -r '.in_flight // "none"')" = "none" ] || die "lane has an in-flight commitment ($(printf '%s' "$lane" | jq -r .in_flight)); resolve it first"
  cfg="$(view get_evm_cfg '{}')"; [ "$cfg" != "null" ] || die "evm cfg not set"
  maxfee="$(printf '%s' "$cfg" | jq -r .max_fee_ceiling)"
  [ "$(echo "$value >= $(printf '%s' "$cfg" | jq -r .min_value)" | bc)" = 1 ] || die "value below cfg.min_value"
  addr="$(printf '%s' "$lane" | jq -r .address)"
  bal="$(ro "${OPS[@]}" eth-balance "$EVM_RPC" "$addr")" || die "cannot read the lane balance"
  need="$(echo "$value + 21000 * $maxfee" | bc)"
  [ "$(echo "$bal >= $need" | bc)" = 1 ] || die "lane balance $bal wei < value + 21000 x max_fee = $need wei; fund $addr first. Nothing was sent."

  local rid
  rid="evm-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  step "propose_payment as $DELEGATE: $value wei -> $to (request_id $rid, 150 Tgas)"
  local out rc=0 h cid idem_args
  idem_args="{\"account_id\":\"$DELEGATE\",\"request_id\":\"$rid\"}"
  out="$("${OPS[@]}" evm-propose "$RPC" "$CONTRACT" "$DELEGATE" "$KEYS/evmscout.key" "$TASK" "$to" "$value" "$rid" 2>"$ERRF")" || rc=$?
  h="$(printf '%s\n' "$out" | sed -n 's/^TXHASH //p' | head -1)"
  if [ -n "$h" ]; then
    if [ "$rc" -eq 0 ] && [ "$(printf '%s\n' "$out" | sed -n 's/^TX //p' | head -1)" = "$h" ]; then record_tx "propose_payment" "$h" yes; else record_tx "propose_payment" "$h" no; fi
  fi
  if [ "$rc" -ne 0 ]; then
    scrub < "$ERRF" >&2
    echo "evm-testnet: propose did not finish cleanly. Do NOT resend before reading get_idempotency for request_id $rid:" >&2
    printf '    idempotency now: %s\n' "$(view get_idempotency "$idem_args" 2>/dev/null || echo unreadable)" >&2
    exit 1
  fi
  cid="$(printf '%s\n' "$out" | sed -n 's/^CID //p' | head -1)"
  echo "    NEAR tx (re-read from chain: signer, receiver, method): $(link "$h")"
  echo "    idempotency: $(view get_idempotency "$idem_args")"
  if [[ "$cid" =~ ^[0-9]+$ ]]; then
    echo "    commitment id: $cid"
    echo "    state: $(view get_commitment "{\"commitment_id\":$cid}" | jq -r .state)"
    echo "    signed tx: $(view get_signed_tx "{\"commitment_id\":$cid}" | jq -c '{state, nonce, from, tx_hash: .original.tx_hash, has_raw_tx: (.original.raw_tx != null)}')"
  else
    echo "    commitment id not in the receipt ($(printf '%s\n' "$out" | sed -n 's/^STATUS //p' | head -1)); read get_idempotency / list_commitments for task $TASK"
  fi
  echo "    the relayer broadcasts the raw tx and attests the outcome; this script does not."
}

# ---- owner helpers ---------------------------------------------------------------------------------
cmd_confirm_release() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || die "usage: confirm-release <commitment-id>"
  chk_tools
  ocall confirm_release "{\"commitment_id\":$1}"
  echo "    state now: $(view get_commitment "{\"commitment_id\":$1}" | jq -r .state)"
}
cmd_set_ceiling() {
  [[ "${1:-}" =~ ^[1-9][0-9]{0,30}$ ]] && [[ "${2:-}" =~ ^[1-9][0-9]{0,30}$ ]] || die "usage: set-ceiling <maxFeeWei> <tipWei>"
  [ "$(echo "$2 <= $1" | bc)" = 1 ] || die "tip must be <= max fee"
  chk_tools
  local cfg args
  cfg="$(view get_evm_cfg '{}')"; [ "$cfg" != "null" ] || die "evm cfg not set; run deploy"
  args="$(printf '%s' "$cfg" | jq -c --arg f "$1" --arg t "$2" '{chain_id, max_fee_ceiling:$f, max_priority_ceiling:$t, min_value, min_unknown_age_ns}')"
  ocall set_evm_cfg "$args"
}

case "${1:-}" in
  deploy) shift; cmd_deploy "$@" ;;
  status) shift; cmd_status "$@" ;;
  propose) shift; cmd_propose "$@" ;;
  confirm-release) shift; cmd_confirm_release "$@" ;;
  set-ceiling) shift; cmd_set_ceiling "$@" ;;
  *) die "usage: $0 deploy | status | propose [--value-wei N] [--to 0x..] | confirm-release <cid> | set-ceiling <maxFeeWei> <tipWei>" ;;
esac
