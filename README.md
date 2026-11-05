# Purser — on-chain spending controller for AI agent crews

**One budget. Many agents. Nothing overspent.**

A NEAR smart contract that lets a crew of AI agents draw from one shared, capped
budget and enforces `completed + outstanding ≤ cap` across concurrency, retries,
timeouts, and revocation. The AI only proposes; the contract enforces.

**Tracks:** security (primary) · swarms · agents

**Status:** contract (NEAR-native core, property + attack suites), the untrusted AI proposer crew
(`proposer/`) and the operator board (`app/`) are built and running on testnet; the indexer and the
recorded demo are next. `./scripts/deploy-testnet.sh && ./scripts/demo.sh` reproduces the demo on testnet (see **Try it**). Specs live in `docs/`.

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

### Toolchain

- Rust (via rustup) with the `wasm32-unknown-unknown` target
- [`cargo-near`](https://github.com/near/cargo-near) and [`near-cli-rs`](https://github.com/near/near-cli-rs)
- Node 26 and pnpm 10 (`corepack enable`); TS runs directly on Node's type stripping

Target network: **NEAR testnet** only.
