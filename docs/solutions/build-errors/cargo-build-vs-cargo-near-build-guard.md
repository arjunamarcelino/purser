---
title: "`cargo build` fails with a compile_error inside near-sdk (use `cargo near build`)"
category: build-errors
date: 2026-11-03
tags: [near-sdk, cargo-near, rust, wasm, cargo-build, cargo-check, clippy, cfg-near, compile-error, contract]
module: contract toolchain
symptom: "`cargo build` (or `cargo check`) on the contract errors: 'could not compile `near-sdk` (lib)' with a compile_error! panic in near-sdk-5.30.0/src/lib.rs telling you to use `cargo near build`"
root_cause: "near-sdk 5.27+ emits a deliberate compile_error! when built on the host without the `near`/`wasm`/`test`/`clippy` cfg — i.e. plain `cargo build`/`cargo check` are intentionally blocked for a contract crate"
status: resolved
verified: true
---

# `cargo build` fails with a compile_error inside near-sdk

## Symptom

Running plain `cargo build` (or `cargo check`) in `contract/` fails with what *looks* like a
dependency compile failure:

```
   Compiling near-sdk v5.30.0
error: 1. 🔨️  Use `cargo near build` instead of `cargo build` to compile your contract
       💡  Install cargo-near from https://github.com/near/cargo-near

       2. ✅ Use `cargo check --target wasm32-unknown-unknown` instead of `cargo check` ...

       3. ⚙️ Only following cfg-s are considered VALID for `near-sdk`:
         - `#[cfg(near)]` (set by `cargo-near`...)
         - `#[cfg(target_family = "wasm")]`
         - `#[cfg(feature = "unit-testing")]` (for `[dev-dependencies]`)
         - `#[cfg(test)]`
         - `#[cfg(clippy)]`
         ...
   --> .../near-sdk-5.30.0/src/lib.rs:142:1
    |
142 | / compile_error!(
    ...
error: could not compile `near-sdk` (lib) due to 1 previous error
```

The `could not compile near-sdk` line is misleading — it reads like a broken dependency or a
toolchain problem, but near-sdk compiles fine; the error is **intentional**.

## Investigation (what was ruled out)

- **Not a broken pin / corrupted registry.** `near-sdk 5.30.0` builds correctly via the proper
  command; re-fetching or re-pinning changes nothing.
- **Not the contract code.** The `compile_error!` fires from near-sdk's own `lib.rs:142`, before
  any of our code is type-checked. It happens even on a trivial contract.
- **Not a missing `wasm32` target.** The target is installed; the issue is the *build mode*, not a
  missing target.

## Root cause

near-sdk 5.27+ ships a `compile_error!` that fires whenever the crate is compiled on the **host**
without one of the cfgs it considers valid: `cfg(near)` (set by `cargo-near`),
`cfg(target_family = "wasm")`, `cfg(feature = "unit-testing")`, `cfg(test)`, or `cfg(clippy)`.

Plain `cargo build` / `cargo check` set **none** of these, so the guard trips. This is deliberate:
a contract must be built to wasm via `cargo near build`, and the guard stops you from producing a
host-target artifact that could never run on-chain.

The corollary — and the reason the fix is non-obvious — is that `cargo test` and
`cargo clippy --all-targets` **do** work, because:
- `cargo test` compiles under `cfg(test)` (a valid cfg), and
- `cargo clippy --all-targets` pulls in the test/dev targets, whose `[dev-dependencies]`
  `near-sdk = { features = ["unit-testing"] }` enables `cfg(feature = "unit-testing")`; feature
  unification compiles near-sdk **once** with that feature on, satisfying the guard across the
  whole invocation.

So "build is broken but test and lint pass" is expected, not contradictory.

### Gotcha: `cargo clippy --lib` (no dev-deps) STILL trips the guard

**`cargo clippy --lib` — or any clippy run whose graph excludes the dev-dependencies — fails with
the same `compile_error!`** (observed 2026-11-03). near-sdk the *dependency* is built by plain
rustc without `cfg(clippy)` on it, and without the test targets there is no `unit-testing` feature
to satisfy the guard either. The `cfg(clippy)` in near-sdk's own "valid cfgs" list applies to the
crate clippy lints, not to how the near-sdk dependency is compiled — so do **not** rely on
`cfg(clippy)` alone. Always lint with the repo's `cargo clippy --all-targets -- -D warnings`
(the `Makefile` `lint` target), which brings the dev-dep `unit-testing` feature into the build.

## Solution (the correct commands)

Use the cargo-near build mode (and the test/lint commands, which already work):

```bash
# BUILD the contract → wasm + ABI at contract/target/near/
cargo near build non-reproducible-wasm         # dev / CI
cargo near build reproducible-wasm             # verifiable release (Docker)

# ERROR-CHECK without a full build
cargo check --target wasm32-unknown-unknown    # NOT plain `cargo check`

# LINT (works as-is — clippy sets cfg(clippy))
cargo clippy --all-targets -- -D warnings

# TEST (works as-is — runs under cfg(test))
cargo test

# FORMAT
cargo fmt --all -- --check
```

These are exactly the targets wired into the repo `Makefile` (`make build` → `cargo near build
non-reproducible-wasm`; `make lint`; `make test`). **Never** run bare `cargo build`/`cargo check`
on the contract crate.

Also note: the cargo/rustc toolchain in this environment lives under `~/.cargo` but may not be on
`PATH` in a fresh shell — prefix commands with `. ~/.cargo/env &&` (or add `~/.cargo/bin` to PATH)
before any `cargo`/`cargo near` invocation.

## Prevention

- Treat `cargo near build non-reproducible-wasm` as the canonical build command for the contract;
  keep it as the `Makefile`/CI build step (already the case here).
- When a reviewer or script needs a quick "does it compile" check, use
  `cargo check --target wasm32-unknown-unknown`, not `cargo check`.
- Don't be alarmed by "build fails but test/lint pass" — that pattern is the guard working as
  designed, not a regression.
- If you ever *need* to use near-sdk off-chain (host build), that requires the
  `non-contract-usage` feature / a leaf crate — out of scope for the contract crate itself.

## Cross-references

- Sibling learning: `docs/solutions/build-errors/cargo-near-install-libudev-ci-failure.md`
  (installing `cargo-near` in CI).
- Sibling learning: `docs/solutions/build-errors/near-workspaces-compile-project-unstable-feature.md`
  (the `unstable` feature needed for in-test wasm compilation — same integration-suite setup).
- `docs/BUILD-START-VERIFICATION.md` — pinned toolchain + confirmed 5.x idioms.
- Contract `Makefile` targets (`build`/`test`/`lint`/`fmt`).
- near-sdk `compile_error!` guard: `near-sdk-5.30.0/src/lib.rs` (~line 142).

> Note: this repo keeps `docs/` untracked (per the scaffold-only commit policy), so this solution
> file is uncommitted like the other `docs/solutions/` entries. Commit it if/when `docs/` is tracked.
