# Purser — on-chain spending controller for AI agent crews

**One budget. Many agents. Nothing overspent.**

A NEAR smart contract that lets a crew of AI agents draw from one shared, capped
budget and enforces `completed + outstanding ≤ cap` across concurrency, retries,
timeouts, and revocation. The AI only proposes; the contract enforces.

**Tracks:** security (primary) · swarms · agents

**Status:** contract (NEAR-native core, property + attack suites), the untrusted AI proposer crew
(`proposer/`) and the operator board (`app/`) are built and running on testnet; the indexer and the
recorded demo are next. A stretch EVM payment path (MPC-signed Sepolia transfers, a named relayer trust
assumption, nonce-burn reclaim) is built and was exercised end to end on NEAR testnet + Sepolia; see
**EVM path (stretch)**. `./scripts/deploy-testnet.sh && ./scripts/demo.sh` reproduces the demo on testnet (see **Try it**). Specs live in `docs/`.

## Authorization & honest revocation

**Auth model (MVP): registry + predecessor.** The owner registers delegate agents per
task; each agent authorizes from its own NEAR account. A caller is authorized only if it
is a registered, **active** delegate of the task — the contract issues no access keys, so
the budget guarantee is a property of the contract code, never of key mechanics. (The
function-call-key path is a documented, deferred option; see the operator gate in
`docs/BUILD-START-VERIFICATION.md`.)

**Revocation is honest.** `revoke_delegate` marks a crew member inactive, which blocks all
**future** authorizations immediately (the next proposal is refused) and reports whether it
actually changed state. It **cannot** un-issue or recall a signature/transaction already
produced — no on-chain mechanism can — and it does **not** release that delegate's
already-reserved (`outstanding`) budget, which stays reserved until settled or failed by the
normal lifecycle (no reclaim on silence). The dashboard greys out a revoked agent and marks
new proposals BLOCKED, with a caption noting already-issued signatures cannot be recalled.

## Develop

| Command | What it does |
|---|---|
| `make build` | `cargo near build` → wasm + ABI in `contract/target/near/` |
| `make test`  | contract unit + integration tests, TS unit tests |
| `make lint`  | `cargo clippy --all-targets -- -D warnings`, `tsc` typecheck of the TS workspace |
| `make fmt`   | `cargo fmt` |
| `make hooks` | install the pre-commit secret-scan hook |
| `make prove` | the security evidence: property tests + the named attack cases |
| `make evm-spike` | the stretch EVM go/no-go spike (feature-gated, local + sandbox only): sizes, the wasm gate, per-hash gas and the load tax. Verdict: **GO** |
| `make relayer` | the stateless Sepolia relayer loop (needs the `EVM_*` and `RELAYER_*` env names in `.env.example`; see [`relayer/README.md`](relayer/README.md)) |
| `scripts/evm-testnet.sh deploy\|status\|propose\|set-ceiling\|confirm-release` | stand up and drive the EVM path on a fresh `purser2.<operator>` contract beside the demo one (NEAR testnet + Sepolia only; spends testnet NEAR and Sepolia ETH) |
| `make ts-test-sandbox` | the AI proposer on a local chain: attack case 2 through the AI path, rogue proposals, key scope, exactly-once retries, model-independence property |
| `make crew` | run Scout, Forge and Buyer against Purser (`NETWORK=sandbox\|testnet`, `SCENARIO=demo\|legit\|race\|rogue`) |
| `make board` | the operator board at http://127.0.0.1:5173: live invariant, manifest, Revoke, demo buttons (see [`app/README.md`](app/README.md)) |
| `make types-gen` | regenerate `@purser/types` from the contract ABI |
| `make deploy-testnet` | deploy to testnet and provision the crew (`OPERATOR_ACCOUNT_ID=<you>.testnet`) |
| `make demo` | replay the 7 enforcement outcomes: 1-6 live on testnet with tx refs, 7 as a labeled sandbox replay |

## Try it

```sh
OPERATOR_ACCOUNT_ID=<you>.testnet ./scripts/deploy-testnet.sh && ./scripts/demo.sh
```

Testnet only: both scripts refuse any other network and check that the RPC itself reports `testnet`.

| Do | See |
|---|---|
| Install Node 26, pnpm 10, `near-cli-rs` 0.30.1, `cargo-near`, then `make ts-install build` | the toolchain check passes (a missing tool prints its install command) |
| Have a funded testnet account in the near-cli keychain. In this session: `! near account import-account ...` | `deploy-testnet.sh` finds the operator and its balance |
| `OPERATOR_ACCOUNT_ID=<you>.testnet ./scripts/deploy-testnet.sh` (safe to re-run) | accounts `purser/scout/forge/buyer/...<you>.testnet`, then `PURSER_CONTRACT_ID=purser.<you>.testnet`, written to `.env.testnet` |
| `./scripts/demo.sh` | a fresh task `demo-<RUN_ID>` with 100 units, then **1.** Remaining 100→70→40; **2.** three agents fire 30 each at 40 left: one admitted (40→10), two refused `exceeds_task_budget`, with the block heights; **3.** the same `request_id` again returns the original result, no new spend; **4.** a non-allowlisted recipient and a reused `request_id` with another recipient are refused; **5.** after Revoke, Buyer is `delegate_not_authorized`; **6.** `completed + outstanding ≤ cap ✓` from the contract's own verdict |
| open any printed `https://testnet.nearblocks.io/txns/<hash>` | the same transaction; the script already re-read each one from the chain and checked its signer, receiver and method |

Every run uses a new task (revocation is permanent), so `demo.sh` can be repeated; a failed run is just
re-run. `RUN_ID` and `DEMO_CAP_NEAR` (default `1`; `0.5` suits a thin wallet) are the only knobs.
A run pays out 90 of the cap's 100 units to the operator's own merchant sub-accounts, so it needs about
`0.9 × DEMO_CAP_NEAR + 0.05` NEAR **spendable** on the contract; its wasm locks ~2.6 NEAR as storage stake,
and `demo.sh` stops early with the exact top-up command if it is short.

**Outcome 7 is a replay, not a testnet transaction.** The shipped wasm cannot be made to lose a settlement
callback, and the test-only fault build is refused by `build.rs` and `scripts/check-wasm-clean.sh`.
`demo.sh` therefore runs attack-suite case 7 on a local sandbox under a `SANDBOX (not testnet)` banner
(reservation retained through silence, retry and revoke; an early `reconcile` refused). The summary
reads **6 live on testnet + 1 sandbox replay**.

**Fresh account.** A brand-new operator needs testnet NEAR first (about `3 × CAP_NEAR + 6`, default 12).
near-cli-rs 0.30.1 offers `near account create-account sponsor-by-faucet-service <you>.testnet
autogenerate-new-keypair save-to-keychain network-config testnet create` (helper
`https://helper.nearprotocol.com/account`); its limits and granted amount are not published and the
route has not been exercised here, so if it fails, fund the account from another testnet account with
`near tokens <funded>.testnet send-near <you>.testnet '12 NEAR' network-config testnet sign-with-keychain send`.

The AI proposer is untrusted by design: it holds one function-call key per persona that can call
only `propose_payment`, and does no client-side policy — every limit is the contract's. See
[`proposer/README.md`](proposer/README.md).

The test-only `fault-injection` feature never builds by accident: `build.rs` refuses it unless
`PURSER_ALLOW_FAULT_INJECTION=1` is set (so `--all-features` fails loudly), and
`scripts/check-wasm-clean.sh <wasm>` refuses a fault build (CI and `make build-release` run it).

## Security evidence

`make prove` runs, over thousands of generated interleavings and on a real sandbox chain:

- **Property tests** (`contract/tests/properties.rs`). Thousands of random operation sequences over
  the pure accounting core and over the real contract entrypoints (callbacks delivered out of
  order or lost, retries, revocation, owner reconcile). After **every** step they check the
  contract against an independent model: `completed + outstanding ≤ cap`, one authorization per
  request, the money that left never exceeds what is accounted, and nothing is released
  without proof.
- **Attack suite** (`contract/tests/attacks.rs`). One named test per demo case (legit spend,
  concurrent over-budget, retry, in-flight retry, tampered recipient, revocation, timeout).
  The concurrency cases put every proposal into **one block** and prove from on-chain receipt
  heights that each admission ran before the first settlement, so the race was actually exercised.

**Operational notes.** A commitment whose settlement callback was lost stays reserved until the
owner reconciles it with the transfer's **observed final outcome** (never on silence), and
`reconcile` refuses until the commitment is 10 minutes old. NEAR does not bound receipt latency,
so the settlement callback stays authoritative even after a reconcile: if it proves a released
payment actually landed, the contract records the spend, emits `reconcile_contradicted`, and, if
that puts the task over its cap, **freezes** the task so it authorizes nothing more. The cap
invariant holds for every task that is not frozen, and only a wrong owner attestation can freeze one.

**Retries.** A retry must repeat the same request: task, recipient, amount and memo (an empty memo
counts as no memo). Reusing a settled `request_id` for anything else is refused with
`request_id reused with a different request`; generate a fresh `request_id` per payment. Never deploy Purser on
the owner's own account: `#[private]` callbacks would then accept the owner as the caller.

## EVM path (stretch)

One governed EVM payment path: the contract builds an EIP-1559 transfer from the stored intent, reserves
budget, asks the NEAR MPC signer (`v1.signer-prod.testnet`, near/mpc 3.18.0) to sign it, and checks the
signature recovers to the lane's cached derived key. A separate relayer broadcasts to Sepolia and reports
what happened. Sepolia only, never mainnet (chain id 11155111 is the only one the contract accepts, and the
relayer checks `eth_chainId` on every RPC).

**Built and proven on real testnets:** a real payment signed through the live MPC signer, broadcast to
Sepolia, and attested at `finalized`; and a stuck payment recovered by nonce-burn cancel and an owner release,
leaving the invariant intact. The contract tests for the same paths run against a mock signer in the
sandbox (with gas budgets); the live runs below used the real one.

### Trust model: the relayer is a named assumption

The contract cannot read Sepolia, so the relayer is the only party that tells it what happened there. What a
lying or compromised relayer can and cannot do:

| Attack | Possible? | Bound |
|---|---|---|
| Report a false "original landed" | Yes | Budget is burned (over-counted) for one lane; no theft; conservative direction |
| Report a false "cancel landed" / "reverted" | Can only record evidence; cannot release budget | Release needs the **owner's** `confirm_release` after the owner checks Sepolia |
| Refuse to report / go offline | Yes | Reservation stays locked (honest, by design); owner can inspect and act |
| Attest a hash the contract did not sign | No | The contract matches reports against hashes it signed |
| Cause an immediate double spend alone | No | Needs the owner key too (two-key release) |

**Two-key release.** The relayer attests; only the owner's `confirm_release` frees budget. If the owner
confirms a release on a false claim, the original can still land afterwards: that is overspend of up to one
in-flight value per lane. The contract records the spend if it is later attested, emits a contradiction, and
freezes the task; freezing is the only recovery, and it is permanent for that task. Anyone can broadcast the
original at any time from the public `get_signed_tx` view, so a strategy must assume it may land before a
cancel is final. `owner != relayer` is a setup check.

**Every callback `Err` goes to `Unknown`, never to released.** A failed signer callback is not proof that no
signature exists: the MPC nodes' `respond` transaction carries the signature in public args even when the
caller's yield timed out. So a commitment whose sign callback fails stays reserved until it is resolved with
Sepolia evidence.

### Honest limits

- **Cap is value, not gas.** Gas is paid in ETH from the derived address and sits outside the cap. The fee
  ceiling and `min_value` (both owner-set) and the dedicated task's cap bound the exposure.
- **One in-flight payment per derived address (lane).** The relayer attests only at Sepolia `finalized`,
  which lags head by about 19 minutes (observed 14 to 15 minutes from broadcast to attestation on both live runs), so throughput is about one payment per 15 minutes per delegate.
- **Safe finality never changes state.** Only `Finalized` attestations move a commitment.
- **EOA recipients only in v1.** A 21000-gas send to a contract can revert. A reverted receipt is attested
  `success=false`, moves nothing, and releases only through the owner. The relayer warns when `eth_getCode(to)`
  is non-empty.
- **No EVM recipient allowlist in v1.** Exposure is bounded by the task cap, `min_value` and the fee ceiling.
- **`derivation_path` is still public** in `list_delegates` in v1 (the derived address is public anyway).
- **A single cancel.** Escalation is roadmap. A cancel that is itself stuck leaves the commitment `Unknown`
  with its budget locked.
- **Late originals after a cancel are not watched.** The relayer does not watch `Cancelled` commitments for a
  late original. The contract has the edge (`Cancelled -> Confirmed` records the spend and freezes the task if
  over cap) and it is tested in the sandbox, but it was not demonstrated live.
- **Size.** The default no-ABI wasm grew 248,081 to 353,741 bytes (+105,660, +42.6%); the deployed wasm with its
  embedded ABI is about 366 KB.
- Gas figures (`docs/EVM-PROBES.md`) come from a sandbox with a mock signer; the real signer's yield/resume
  cost is not in that table.

### Live evidence (NEAR testnet + Sepolia)

Contract `purser2.arjuna-purser.testnet`, relayer `relayer2.arjuna-purser.testnet`, delegate
`evmscout.arjuna-purser.testnet`, lane address `0x7f6f3d4b8c67acd84e05df8fc74bb115154e64ac`.

| Step | Reference |
|---|---|
| Payment 1 (settled): NEAR `propose_payment` | [testnet tx](https://testnet.nearblocks.io/txns/523rR74zoyjFDKCKeeWNXUPTvKKmw8SBbunVoPuCj915) |
| Payment 1: Sepolia transfer (nonce 0, block 12071752) | [Sepolia tx](https://sepolia.etherscan.io/tx/0xbf264ff1f43e37336d09f92304785047f67af9f9bedefc32e5ed93e9b818eb12) |
| Payment 1: `attest_external` (Confirmed) | [testnet tx](https://testnet.nearblocks.io/txns/6G9HeGbTD4LGyYDBtTj7uhcMCquJzhgpacX2GraxC91y) |
| Payment 2 (stuck, cancelled, released): `set_evm_cfg`, fee ceiling set to 1 wei | [testnet tx](https://testnet.nearblocks.io/txns/5qx3BdfwR2LTKQFYcVLvphGp8f33EVhvZh4tntHizb2b) |
| Payment 2: `propose_payment` (nonce 1, unminable at that fee, rejected by both RPCs, never mined) | [testnet tx](https://testnet.nearblocks.io/txns/2n8eifrbKzgahkxK5yoWwK6TzgEHEejqbgY2yu6NR5iE) |
| Payment 2: original hash (never on Sepolia) | `0x8434936e9abcadb5d36aad62156c58589dc49ad6f7d3851321d6a0cfa1203b84` |
| Payment 2: `set_evm_cfg`, fee ceiling raised to 2 gwei | [testnet tx](https://testnet.nearblocks.io/txns/2kiFJK6yvSMbLWgYSLXQq5sW4zYaEtaCvrfifJPAbiPy) |
| Payment 2: cancel (0-value self-send, nonce 1, block 12073381) | [Sepolia tx](https://sepolia.etherscan.io/tx/0x4455c91e7861588aa5663d25ca729fb277cdded585fcb11cd952a5723e34aa46) |
| Payment 2: owner `confirm_release` (Unknown to Cancelled) | [testnet tx](https://testnet.nearblocks.io/txns/J36miiF5cmmPpUiQGNZucdi62L7dWgTmqoBCEZzTUFDV) |

Payments 1 and 2 ran on the first deployed wasm (code hash `398d9ed6…364dd`). Code review then changed the
contract (a retryable cancel slot, idempotency set on `mark_unknown` from `Reserved`, tests), so `purser2` was
upgraded in place to code hash `9d46e69d…a44b` (state kept; no storage layout change) and the stuck-cancel-release
path was run again as payment 3. The `mark_unknown` and `request_cancel` hashes of payment 2 were not captured.

| Step (payment 3, on the fixed code) | Reference |
|---|---|
| `set_evm_cfg`, fee ceiling set to 1 wei | [testnet tx](https://testnet.nearblocks.io/txns/3XkG41Zu23DiT5K1rSHperxBW5mxnbNYPQqqc6HivoGs) |
| `propose_payment` (commitment 2, nonce 2, unminable, rejected by both RPCs on every retry, never mined) | [testnet tx](https://testnet.nearblocks.io/txns/7q9VXWcMUDSeMqUUNJ7wkU9623SaPT2zB1PkuaCHcj91) |
| Original hash (never on Sepolia) | `0x5d8f4b3c2c4ea28339639bd76fc030b5e6c86df552ae2dfaf899eb3335105e2e` |
| Relayer `mark_unknown` (Signed to Unknown; reservation held) | [testnet tx](https://testnet.nearblocks.io/txns/ZJmD1LkfbMPHpbQkzQ1NAxkVu35T8G3PTUcVZY8fRtK) |
| `set_evm_cfg`, fee ceiling raised to 2 gwei / 1 gwei | [testnet tx](https://testnet.nearblocks.io/txns/GJ4MsCu8APedg8dKbeBVKH1tEiSTajATAa6cm3Qo52xe) |
| `request_cancel` | [testnet tx](https://testnet.nearblocks.io/txns/5JA75B9unGETX6pVSLiqbdAi5sZGg6XqNFVmnUME2bHG) |
| Cancel (0-value self-send, nonce 2, block 12074022) | [Sepolia tx](https://sepolia.etherscan.io/tx/0x4ab1bca17946f38ada9f9c277414b203447e8982f3e9d432ad512fc56ee96b35) |
| Relayer `attest_external` (cancel landed, finalized; evidence only, nothing released) | [testnet tx](https://testnet.nearblocks.io/txns/BkB7V6Z5pAb8k8iz7kTw2CD7NojWXH8tkFr7yNkywEdH) |
| Owner `confirm_release` (Unknown to Cancelled) | [testnet tx](https://testnet.nearblocks.io/txns/1RmTRskeFaeQFhK1hU5Hhv7MvVSSAeFoW4szz1ymd8B) |

Final state: commitment 0 Confirmed, commitments 1 and 2 Cancelled; completed 1e12, outstanding 0, the
invariant holds, lane nonce 3. While each stuck payment waited, the contract kept its reservation
(`outstanding` 1e12) and the cancel attestation released nothing; only the owner's `confirm_release` did.
Both cancel receipts report `gasUsed` 12000 with status success; that figure is unexplained and is reported
as observed (a plain 21000-gas self-send would normally report 21000).

To reproduce: `scripts/evm-testnet.sh deploy`, fund the printed Sepolia address from a faucet by hand,
`status`, `make relayer`, then `propose`. For the stuck path use `set-ceiling` to set a ceiling below the base
fee, `propose`, then raise the ceiling, ask the relayer for the cancel (`pnpm --filter @purser/relayer run cli
cancel <cid> ...`) and finish with `confirm-release <cid>`. The relayer needs `EVM_RPC_URL` (https; for
example `https://rpc.example.invalid`, a placeholder), optionally `EVM_RPC_URL_2`, `EVM_PURSER_CONTRACT_ID`,
`RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY`. The deploy script writes the last three into the gitignored
`.env.testnet`. Details: [`relayer/README.md`](relayer/README.md), `.env.example`.

## Toolchain

- Rust (via rustup) with the `wasm32-unknown-unknown` target
- [`cargo-near`](https://github.com/near/cargo-near) and [`near-cli-rs`](https://github.com/near/near-cli-rs)
- Node 26 and pnpm 10 (`corepack enable`); TS runs directly on Node's type stripping

Target network: **NEAR testnet** only (the EVM stretch path adds Sepolia, also a testnet).
