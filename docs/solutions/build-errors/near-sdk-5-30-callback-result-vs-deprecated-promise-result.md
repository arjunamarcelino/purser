---
title: "near-sdk 5.30 cross-contract callback: use #[callback_result], not the deprecated env::promise_result (fails -D warnings)"
category: build-errors
date: 2026-11-03
tags: [near-sdk, 5.30, cross-contract, callback, promise-result, callback-result, promise-error, deprecated, deny-warnings, clippy, promise-or-value, transfer, receipt-hash, contract]
module: contract payment flow (propose_payment / on_near_settled)
symptom: "A #[private] callback that inspects a Promise result via env::promise_result(0) trips the repo's `cargo clippy --all-targets -- -D warnings` gate: `error: use of deprecated function near_sdk::env::promise_result: use promise_result_checked to prevent out-of-gas errors`. Also: matching on PromiseResult::NotReady no longer compiles (variant removed in 5.30)."
root_cause: "near-sdk 5.30 #[deprecated]s env::promise_result and removed PromiseResult::NotReady (the enum is now binary: Successful(Vec<u8>) | Failed). Under the project's -D warnings lint, the deprecation is promoted to a hard error, and old NotReady match arms fail to compile."
status: resolved
verified: true
---

# near-sdk 5.30 callback: `#[callback_result]`, not the deprecated `env::promise_result`

## Symptom

Writing the settlement callback for a cross-contract / native-transfer `Promise` in near-sdk
**5.30.0**, the "obvious" idiom from older tutorials fails the repo's lint gate:

```rust
#[private]
pub fn on_near_settled(&mut self, cid: CommitmentId, request_id: RequestId) {
    match env::promise_result(0) {
        PromiseResult::Successful(_) => { /* settle */ }
        PromiseResult::Failed        => { /* release */ }
        PromiseResult::NotReady      => { /* ??? */ }   // <- no such variant in 5.30
    }
}
```

Two distinct breakages:

1. `cargo clippy --all-targets -- -D warnings` (the repo's `make lint`) errors:
   ```
   error: use of deprecated function `near_sdk::env::promise_result`:
          use `promise_result_checked` to prevent out-of-gas errors
   ```
   Because `-D warnings` promotes the deprecation **warning** into a hard **error**, the contract
   won't lint (and CI blocks).
2. `error[E0599]/E0004]: no variant named `NotReady`` — the third match arm doesn't compile.

## Investigation (what was ruled out)

- **Not a wrong pin.** `near-sdk = "=5.30.0"` is correct; `env::promise_result` still *exists*, it is
  merely `#[deprecated]`, and `PromiseResult` still exists, it merely lost a variant.
- **Not a missing feature.** No cargo feature re-adds `NotReady`; it was removed from the protocol-level
  result model (an async result is either `Successful(bytes)` or `Failed` at callback time).
- **Not solvable by `#[allow(deprecated)]`.** It would compile, but it is the wrong direction: the SDK
  points you at a better API, and littering `#[allow]` hides a real "use the current idiom" signal.

## Root cause

near-sdk 5.30 made two related changes:

- **`env::promise_result` is `#[deprecated]`** in favor of `promise_result_checked(idx, max_len)` (which
  bounds the copied result size to prevent an out-of-gas on a huge result). Under `-D warnings` the
  deprecation is a hard error.
- **`PromiseResult` is binary** — `Successful(Vec<u8>) | Failed`; `NotReady` was removed.

The modern, lint-clean way to read a callback's result is the **macro-injected `#[callback_result]`
parameter**, which hands you a typed `Result<T, PromiseError>` and never touches the deprecated fn.

## Solution (verified)

Use `#[callback_result]` with the success type the promise actually returns. A native `Promise::new(x)
.transfer(amount)` returns **no value**, so the type is `Result<(), near_sdk::PromiseError>`:

```rust
use near_sdk::{env, near, Gas, Promise, PromiseError, PromiseOrValue};

#[payable]
pub fn propose_payment(&mut self, /* … */) -> PromiseOrValue<CommitmentId> {
    // … synchronous reserve-before-sign prefix (commits before any Promise) …
    PromiseOrValue::Promise(
        Promise::new(recipient)
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_near_settled(cid, request_id),
            ),
    )
}

#[private]
pub fn on_near_settled(
    &mut self,
    cid: CommitmentId,
    request_id: RequestId,
    #[callback_result] res: Result<(), PromiseError>,  // <- macro injects the result
) -> CommitmentId {
    match res {
        Ok(())  => { /* transfer succeeded → settle */ }
        Err(_)  => { /* transfer failed (funds refunded to the contract) → release */ }
    }
    cid
}
```

Verified: with this form the contract passes `cargo clippy --all-targets -- -D warnings`, `cargo near
build non-reproducible-wasm`, and a `near-workspaces` sandbox test that drives the real
`Promise`→callback path and observes the callback settle (`Ok(())` deserializes correctly from the
empty transfer result — the one load-bearing assumption of this shape; the happy-path test is its
validator).

### Three corollaries worth knowing for any 5.30 callback

1. **The native-transfer result is binary and deterministic.** There is no ambiguous/"unknown" arm to
   handle on the NEAR-native path (a `Transfer` fails only if the receiver account does not exist, and
   the funds return to the contract). Model `Ok`/`Err` only; reserve any `Unknown`/timeout state for a
   genuine external-chain (MPC/relayer) path.
2. **A `#[payable]` method that is sometimes async and sometimes immediate** (e.g. an exactly-once
   idempotency replay that returns a prior id without re-transferring) returns
   `PromiseOrValue<T>`: `PromiseOrValue::Promise(p.then(callback))` for the fresh path,
   `PromiseOrValue::Value(v)` for the replay. Make the callback **return `T`** so both arms unify.
3. **The contract cannot observe its own transaction/receipt hash on-chain in 5.30.** `near_sdk::env`
   exposes no `receipt_id`/`transaction_hash` (only `current/predecessor/signer_account_id` and
   `random_seed`). Record the tx hash **off-chain** (`ExecutionOutcome::transaction_hash` in a
   near-workspaces test; the indexer from the polled receipt), not from inside the callback.

If you ever do need the raw result bytes (not applicable to a bare transfer), use the non-deprecated
`env::promise_result_checked(idx, max_len) -> Result<Vec<u8>, PromiseError>`, matching on the `Result`.

## Prevention

- Treat `#[callback_result] res: Result<T, PromiseError>` as the default idiom for every new callback;
  reach for `promise_result_checked` only when you need the raw bytes.
- Keep `make lint` (`-D warnings`) in the loop — it is exactly what surfaces a deprecated-API drift as a
  hard failure before it ships.
- When a callback "should obviously work" but won't lint/compile on a fresh near-sdk, read the compiler
  note: a `#[deprecated]` message or a removed enum variant is an *API-moved* signal, not a bug.

## Cross-references

- Sibling learning: `docs/solutions/build-errors/cargo-build-vs-cargo-near-build-guard.md`
  (why `-D warnings` / `cargo near build` behave as they do — same lint gate surfaces this).
- Sibling learning: `docs/solutions/build-errors/near-workspaces-compile-project-unstable-feature.md`
  (the integration-test harness that validates the `#[callback_result]` path end-to-end).
- `docs/BUILD-START-VERIFICATION.md` — "Confirmed idioms (Prompt 4)" records these 5.30 facts.
- Plan: `docs/plans/2026-11-03-feat-near-native-payment-reserve-before-sign-plan.md` (§A verified SDK facts, P-3/P-4/P-5).
- Review: `docs/reviews/2026-11-03-pr3-near-native-payment-flow-review.md` (confirms the shape merge-safe).
- near-sdk 5.30 docs.rs: `enum.PromiseResult`, `env::fn.promise_result` (deprecated note),
  `env::fn.promise_result_checked`, `struct.PromiseOrValue`.

> Note: this repo keeps `docs/` untracked (scaffold-only commit policy), so this solution file is
> uncommitted like the other `docs/solutions/` entries. Commit it if/when `docs/` is tracked.
