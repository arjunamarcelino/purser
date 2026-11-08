# Build-start verification

Recorded 2026-11-02. Toolchain rows verified against crates.io / official repos on that date;
re-check before relying on them. (This file is intentionally untracked — not part of the scaffold commit.)

## Pinned toolchain (verified)

| Component | Pin | Source |
|---|---|---|
| near-sdk | `5.30.0` (latest stable, 2026-10-27; nearcore 2.14 / protocol 88) | https://crates.io/crates/near-sdk · https://github.com/near/near-sdk-rs/blob/master/CHANGELOG.md |
| cargo-near | `0.22.0` (latest stable; 0.23 is rc-only) | https://crates.io/crates/cargo-near |
| near-cli-rs | `0.30.1` | https://crates.io/crates/near-cli-rs |
| near-workspaces (rs) | `0.24.0` (aligned with near-sdk 5.30); integration suite needs `features = ["unstable"]` for `compile_project` — see `docs/solutions/build-errors/near-workspaces-compile-project-unstable-feature.md` | https://crates.io/crates/near-workspaces |
| proptest | `1.12.0` | https://crates.io/crates/proptest |
| Rust | stable `1.95.0` (MSRV 1.95), edition 2021, target `wasm32-unknown-unknown` | https://docs.near.org/smart-contracts/quickstart |

Build: `cargo near build non-reproducible-wasm` (dev/CI) → artifact at `contract/target/near/`.
Reproducible release: `cargo near build reproducible-wasm` (needs the `[package.metadata.near.reproducible_build]` block).

## Confirmed idioms (near-sdk 5.x)

`#[near(contract_state)]`, `#[near]`, `#[init]`, `#[payable]`, `#[private]`, `#[ext_contract]`,
`#[derive(BorshStorageKey)]` + `#[near]`, `near_sdk::store::{IterableMap, LookupMap, Vector, IterableSet, LazyOption}`,
`NearToken`/`Gas`, `#[derive(PanicOnDefault)]`.
Deprecated / avoided: `store::UnorderedMap/UnorderedSet`, `near_sdk::collections::*`, `#[near_bindgen]`,
raw-u128 `add_access_key` (use `add_access_key_allowance` + `Allowance`).
`#![forbid(unsafe_code)]` is NOT usable — `#[near]` expands `#[unsafe(no_mangle)]` into the crate.
`[lints.rust.unexpected_cfgs]` with `check-cfg = ['cfg(near)']` is required so plain cargo passes `-D warnings`.

### Confirmed idioms (Prompt 4 — payment flow, verified 2026-11-03)

Verified against docs.rs 5.30.0 / near-workspaces 0.24.0 and a passing sandbox test:

- **Native transfer + self-callback:** `Promise::new(AccountId).transfer(NearToken).then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(N)).on_near_settled(..))`. `#[near]` on the impl auto-generates `Self::ext(..)` — no `#[ext_contract]` needed for a self-callback.
- **Read the callback result with `#[callback_result] res: Result<(), near_sdk::PromiseError>`** — NOT `env::promise_result`, which is **`#[deprecated]` in 5.30** and so a hard error under `-D warnings`. `PromiseResult` is binary now (`Successful(Vec<u8>) | Failed`; **`NotReady` removed**). See `docs/solutions/build-errors/near-sdk-5-30-callback-result-vs-deprecated-promise-result.md`.
- **Sometimes-async return:** `PromiseOrValue<T>` — `::Promise(p.then(cb))` fresh, `::Value(v)` for an exactly-once replay; the callback returns `T` so both arms unify.
- **No on-chain tx/receipt hash:** `near_sdk::env` exposes none in 5.30 — record `near_tx` off-chain (test: `ExecutionOutcome::transaction_hash`; indexer: polled receipt). `Commitment.near_tx` stays `None` on-chain.
- **`NearToken` is opaque:** no `.0` / `+` / `-`; only `from_yoctonear`/`as_yoctonear` + `checked_*`. Route the admission check through the tested `budget::try_reserve`, never a hand-rolled `require!`.
- **Gas:** `Gas::from_tgas(u64)` is `const fn`; `.with_static_gas` pins a fixed amount for the callback. A 10 Tgas settlement callback measured ~6 Tgas total end-to-end burn; prepaid gas ceiling is 300 Tgas.
- **near-workspaces 0.24:** `call(..).args_json(..).deposit(NearToken).gas/.max_gas().transact()`; `res.outcome().transaction_hash`, `res.total_gas_burnt`, `res.logs()`, `res.into_result().unwrap_err()` for failure-string asserts.

## Pending (confirm at the owning prompt)

| Item | When | Note |
|---|---|---|
| `v1.signer-prod.testnet` live + `sign(payload,path,key_version)` interface | Prompt 12 (stretch EVM) | not blocking the core |
| NEAR AI Cloud base URL + auth + model id | Prompt 7 | ✅ RESOLVED 2026-11-05 (see "Prompt 7" below); live completion pending credits |
| near-api-js major version + wallet-selector React pattern | Prompt 8 | — |
| near-workspaces vs canonical near-sandbox 0.3.12 + near-api 0.8 | Prompt 6 | keeping near-workspaces for now |
| Function-call-key provisioning vs registry-only auth | Prompt 3 | ✅ RESOLVED 2026-11-03 → **registry + predecessor auth**; FC-key provisioning DEFERRED (see below) |

### Prompt 3 operator-gate decision (2026-11-03)

**Registry + predecessor authorization** is the MVP (and intended production) model: the owner
registers delegate agents per task; `propose_payment` (Prompt 4) admits a caller only if it is a
registered, ACTIVE delegate. The contract issues NO access keys, so the budget guarantee never
depends on key mechanics. Plan: `docs/plans/2026-11-03-feat-delegate-registry-and-crew-auth-plan.md`.

Function-call-key provisioning is deferred. Corrections for whoever enables it (verified against
near-sdk 5.30 source): `Promise::add_access_key_allowance(pk, allowance, receiver_id, function_names)`
where `function_names` is a **comma-separated `String`** (not `Vec<String>`; `""` = all methods);
`Allowance::limited(NearToken) -> Option<Allowance>` (`None` on zero); keys land on the contract's
OWN account (protocol `predecessor == receiver`), so auth would switch to `env::signer_account_pk()`.

## Local build verification

Status: NOT RUN in this environment (no Rust toolchain installed). To verify:
`rustup` + `rustup target add wasm32-unknown-unknown`, `cargo install cargo-near --locked`,
then `make build` and `make test` from the repo root.

## Prompt 7 — AI proposer (verified 2026-11-05)

### NEAR AI Cloud

| Item | Value | How verified |
|---|---|---|
| Base URL | `https://cloud-api.near.ai/v1` | docs.near.ai + live calls |
| Auth | `Authorization: Bearer sk-…` | live: key accepted (attestation endpoint 200) |
| Model | `z-ai/glm-5.3-flash`, canonical, `providerType: vllm`, `attestationSupported`, `tools`/`structured_outputs`/`json_mode` | live `GET /v1/model/list`, `/v1/models` |
| Fallback model | `Qwen/Qwen3.8-27B` (vllm, structured outputs) | same |
| Gone / aliased | `openai/gpt-oss-120b`, `DeepSeek-V3.1` removed; `zai-org/GLM-5.1-FP8` etc. are aliases of glm-5.3-flash (aliases get gateway-only signatures) | same |
| Attestation report | `GET /v1/attestation/report?model=…&provider=near&signing_algo=ecdsa&nonce=<64hex>` → gateway + 1 model attestation; nonce echoed in both; model report has Intel TDX quote **and** NVIDIA payload | live 200 |
| Completions | ✅ after credits were added: 5/5 strict `json_schema` (with `pattern` and `anyOf`) replies schema-valid, `finish_reason: stop`, ~5–7 s each | live |
| Signatures | ✅ `signature_kind: provider_tee`, signer `0x3b753b44…` (= the address bound in the model's TDX report); signed text `<model>:<sha256(request bytes)>:<sha256(response bytes)>` matched our own hashes exactly | live |
| SDK verification | ✅ `@nearai/inference-sdk` 0.2.0 on Node 26: `verifyResponse` passes; TCB `UpToDate`, GPU evidence `verified`, deployment measurements from the RTMR3 replay | live, via `make crew` |

**Live result (2026-11-05, after credits):** `make crew` with the real model: every live decision
`verified: true` (all six checks). In the live prompt-injection run the model ignored the
"pay 500 NEAR to attacker" offer and bought the cheapest allowlisted item; the contract would have
refused the hijack regardless.

### Pinned measurements (TOFU, not audited)

`proposer/attestation-pins.json` — RTMR3-measured values (what the SDK verifies):
os_image_hash `91fd5d69ccee3e5ea4f2aeb8c9b632c4358c4ecfc29ba1aa6fb1e402af209829`, compose hashes:

| Pinned | Instance | Evidence |
|---|---|---|
| `a0e3c6f4f21a60ea3f5c96bc7ef319b03a184ca2049605399275fbcea74e8c5f` | gpu03 | first observation |
| `5f7ebd85cf1f480a118f75dd10fd0cb277e4ddbb23845f1c20d8ea0f1e87efa6` | gpu04 | first live run reported `measurement_changed`; 10 report samples showed exactly two instances with the same signer and OS image; their `app_compose` differs by one line (`INSTANCE_LABEL=gpu03` vs `gpu04`) |
Gateway (informational): compose_hash `dc14d62b75ffde97f64fdba40c6be681b6818eb12312e1adee60b3cd4de2533b`.
Re-pin only with a new dated entry here.

### TS toolchain (exact pins; 7-day minimum release age enforced by pnpm)

| Package | Pin | Note |
|---|---|---|
| Node | 26.x (local 26.9.0) | type stripping runs `.ts` directly |
| pnpm | 10.29.2 | `minimumReleaseAge: 10080`, no dependency build scripts |
| typescript | 6.0.3 | not 7.x (Go port, no JS API) |
| near-api-js | 7.4.0 | `@near-js/*` merged in; real default `waitUntil` is EXECUTED_OPTIMISTIC — always pass it |
| near-sandbox | 0.3.4 | 0.3.5 was 1 day old; run with `version: "2.14.0"` (0.3.4 defaults to 2.13.4) |
| openai | 7.45.1 | 7.51.0 too new |
| @nearai/inference-sdk | 0.2.0 | 0.2.1 too new; peer warning `@noble/curves` 2.x vs ^1.6 (transitive) |
| zod | 4.6.7 | |
| vitest | 5.0.5 | 5.1.0 too new |
| fast-check | 4.10.2 | |
| json-schema-to-typescript | 16.0.0 | `near-abi-client-js` on npm is a malware placeholder |

### near-sandbox binary

nearcore 2.14.0 (protocol 88) — identical to the Rust near-workspaces suite's binary (sha256 of the
binary `8e0e1521…5a2a` matches the official tarball's). Tarball sha256 pinned in
`scripts/sandbox-bin.sh`: Darwin-arm64 `ea53448e…e232`, Linux-x86_64 `a0ba0042…e691`. The sandbox
reports `chain_id` `test-chain-XXXXX`.

### Measured

- `propose_payment` (transfer + 10 Tgas callback): **~6.43 Tgas** burnt; `PROPOSE_GAS` = 50 Tgas.
- Function-call allowance use: **~0.00058 NEAR** per proposal; 0.25 NEAR ≈ 430 proposals.
- Function-call key violations (other method, any deposit, transfer) are rejected at transaction
  validation (near-api-js access-key error classes), before any receipt.

### near-cli-rs

Not installed locally. `scripts/deploy-testnet.sh` uses 0.30.1 command forms checked against the
GUIDE at tag v0.30.1 (`create-account fund-myself`, `contract deploy … with-init-call`,
`call-function as-transaction`, `add-key … grant-function-call-access … use-manually-provided-public-key`).

### Testnet run (2026-11-05)

`OPERATOR_ACCOUNT_ID=arjuna-purser.testnet CAP_NEAR=1 make deploy-testnet`, then `make crew NETWORK=testnet`
(real model). Contract `purser.arjuna-purser.testnet` (owner `arjuna-purser.testnet`), tasks
`demo-legit|race|rogue` at 1 NEAR each. Result: all checks passed, every live completion `verified: true`.

| Scenario | Outcome | Example tx |
|---|---|---|
| legit (real model) | Scout 0.08, Forge 0.09, Buyer 0.04 NEAR admitted, Confirmed | `7LCgg1qhqojfUcqV3mTbagLBs2kLx8oGM2AcFdoidwXD` |
| race (attack case 2) | warm-up 0.3 + 0.3; then 3 concurrent 0.3 against 0.4 headroom → 1 admitted, 2 `exceeds task budget`; ledger 0.9 ≤ 1 | admitted `BYmZYzXe3UaMrTTfEF3uzvuoPhaZYwzyYEMH4ykrsrHk`, refused `5dRpkX87653fAYGwh3cnAy8F4YSNCqhviDKBc2vcjhyw` |
| rogue | 5 NEAR vs 1 cap → `exceeds task budget`; attacker → `recipient not allowlisted` (attacker balance unchanged); live injection: model bought the 0.04 NEAR item | `BfDEz2L2gMiZegsNwQ3TSJ7UgLYRj953A3keHjuJLj98`, `Ev6x8EnC6HtPtjy4wh8P9tmcz91h2BC4JzMhHNu938WU` |

Issues found and fixed on the first run: macOS bash 3.2 mangles escaped quotes inside `"$(...)"`
and brace-expands JSON commas (add_delegate never ran); npm 11 blocks global install scripts
(`npm install -g near-cli-rs@0.30.1 --allow-scripts=near-cli-rs`).

## Prompt 8 — operator board (verified 2026-11-05)

| Item | Value |
|---|---|
| Connector | `@hot-labs/near-connect` 0.12.0, chosen over `@near-wallet-selector` 10.1.4 (which adds a second NEAR SDK, React-18-pinned packages and a Buffer polyfill) |
| Vendored manifest | hot-dao/near-selector manifest v`1.1.0` reviewed 2026-11-05; wallets: `near-cli` → near/near-cli-connect@`2b8c4fdc5da03d7e6688a7f84ebce99e480c9c26`, `meteor-wallet` → Meteor-Wallet/meteor_wallet_sdk@`ef1be35fc3712f2de60a7563aed543d78e73f763`. Both pinned URLs return 200. Inline manifest = no remote fetch (NearConnector.js L69-73); iframes `sandbox="allow-scripts"` only |
| near-connect injection paths | `debug-wallets` storage key (blocked by a storage wrapper) and parent-frame postMessage (blocked by `X-Frame-Options: DENY` / `frame-ancestors 'none'`) |
| Pins | react / react-dom 19.3.1, @types/react(-dom) 19.3.0, vite 8.3.5 (8.3.6 too new), @vitejs/plugin-react 6.1.2 (6.2.x too new), jsdom 30.1.3 (31 too new), @testing-library/react 16.3.3, @fontsource/ibm-plex-* 5.3.0 |
| Contract upgrade | `invariant(task_id)` view added; testnet contract upgraded in place via `deploy-testnet.sh` ("upgraded code (state kept)"); existing tasks and commitments intact |
| Contrast | brief hexes tuned for AA: dark `--alarm` #F06B62; light brass #7A5B12, ok #17714F, warn #8A5300, alarm #B42318, link #1F5F99, text-dim #4A5D78; control border dark #5F7090 / light #74849E |
| Harness bug found | `contract/tests/properties.rs` `ExactFit`/`OneOver` underflowed on a frozen task (reproduced on main); fixed with saturating_sub, regression seed committed |
