---
title: "Proving same-block races in near-workspaces + driving the real contract under the mocked VM"
category: integration-issues
date: 2026-11-05
tags: [build-rs, feature-gate, ci-artifacts, mutation-testing, near-workspaces, near-sdk, 5.30, proptest, concurrency, race, receipts, block-height, transact-async, nonce, testing-env, mocked-blockchain, joint-promise, fault-injection]
module: contract tests (properties.rs, attacks.rs, tests/common, race-driver fixture)
symptom: "Concurrency tests pass without proving anything raced; an external retry test reports two reservations for one request; proptest cases see each other's state; a fan-out contract cannot return its joined promise."
root_cause: "Sandbox scheduling is not observed unless you measure it; concurrent first transactions from one signer share a nonce; testing_env! carries mocked storage across calls (and proptest cases); NEAR forbids returning a joint promise."
status: resolved
verified: true
---

# Proving same-block races + a faithful mocked-VM contract harness

## Pitfalls hit (and fixes)

1. **"Concurrent" tests that never raced.** Fan out through a fixture contract whose `fire` builds
   `Promise::function_call` per call joined with `Promise::and`: the outgoing receipts land at the
   target in ONE block, in creation order. Then prove it: resolve each receipt outcome's
   `block_hash` via `worker.view_block().block_hash(h).await?.height()` and require
   `max(admission) < min(settlement)`. `receipt_outcomes()` order is not guaranteed; sort by height.
2. **A joint promise cannot be a return value.** `fire` must return `()`; read leaf outcomes from
   the transaction's receipt tree.
3. **Two `transact_async` from a fresh signer = ONE transaction.** Both fetch the same nonce, so the
   txs are byte-identical and share a hash; a naive proof then double-counts every receipt. Warm the
   signer with one prior tx, `assert_ne!` the two tx hashes, and dedupe receipts by id
   (`ExecutionOutcome.transaction_hash` is the receipt id for receipt outcomes).
4. **`testing_env!` keeps mocked storage** across calls *and across proptest cases*. Reset per case:
   `near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()))`.
5. **Faithful per-call semantics under the mock:** load with `env::state_read`, call inside
   `catch_unwind` (mock panics unwind), then on success `env::state_write` + `drop` (store
   collections flush on Drop); on panic `std::mem::forget` the dirty struct so storage keeps its
   pre-call bytes (= runtime rollback). Silence expected panics with a thread-local-gated hook.
6. **Mock rejects transfers above the account balance:** set `.account_balance(u128::MAX)` when the
   model doesn't track balance.
7. **Speed:** `[profile.dev.package."*"] opt-level = 2` made the mocked-VM property ~6.6x faster
   without touching the crate's own debug assertions or the release wasm.
8. **Fault builds:** `near_workspaces::compile_project` only builds default features; use the
   re-exported `near_workspaces::cargo_near_build::build_with_cli` with `features` and an absolute
   `override_cargo_target_dir`. Put the cfg'd panic in a helper fn (a bare `panic_str` at the call
   site makes the rest of the fn `unreachable_code` under `-D warnings`), and grep shipped wasm for
   the marker.

9. **Gate test-only features in `build.rs`, not just by convention.** Fail compilation when
   `CARGO_FEATURE_FAULT_INJECTION` is set without `PURSER_ALLOW_FAULT_INJECTION=1`; pass the opt-in from
   the harness via `BuildOpts.env` (forwarded as `cargo near build --env K=V`, which reaches build
   scripts). `--all-features` then fails loudly instead of silently shipping a fault build.
10. **Build each wasm once and fan out.** Give the harness one lazily-built artifact per wasm, serialized
    by a single lock, overridable by `PURSER_WASM_PROD/_FAULT/_DRIVER`; CI builds them in a `wasm`
    job and the `sandbox-tests` job downloads them. near-sandbox (without `global_install`) downloads its
    binary into the crate's `OUT_DIR`, so the target cache already covers it — no `~/.near` cache.
11. **A joined batch is scheduled on drop.** near-sdk promises are lazy: `fire` must let the joined
    `Promise` drop; `mem::forget` or an early return silently sends nothing.
12. **Mutation-check every new property, and read the result before committing.** A planted
    memo-blind replay check passed because no generator produced a memo-only difference (random
    proposals almost never reproduce the same amount); `Retry` needed a memo-swap variant. Generators
    must reach the *difference* the check guards, not just the code path.
13. **Never let the model import the logic under test** (e.g. the contract's time-lock constant or a
    "callbacks arrive within 5 s" assumption): state the spec value and assert equality, or the model
    hides the very bug class (see `security-issues/owner-reconcile-contradicted-by-late-settlement-callback.md`).
