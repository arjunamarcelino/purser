---
title: "`compile_project` not found in near-workspaces (gated behind the `unstable` feature)"
category: build-errors
date: 2026-11-03
tags: [near-workspaces, integration-tests, rust, wasm, cargo-features, unstable, compile-project, contract, tokio]
module: contract integration tests
symptom: "`error[E0425]: cannot find function `compile_project` in crate `near_workspaces`` — with a note `found an item that was configured out` / `the item is gated behind the `unstable` feature`"
root_cause: "near-workspaces 0.24 gates `compile_project` (and the rest of its `cargo` module) behind the `unstable` cargo feature; a default `near-workspaces` dev-dependency does not expose it"
status: resolved
verified: true
---

# `compile_project` not found in near-workspaces (needs the `unstable` feature)

## Symptom

Standing up the first `near-workspaces` integration test (`contract/tests/delegates.rs`), the test
target fails to compile:

```
error[E0425]: cannot find function `compile_project` in crate `near_workspaces`
  --> tests/delegates.rs:26:26
   |
26 |         near_workspaces::compile_project(".")
   |                          ^^^^^^^^^^^^^^^ not found in `near_workspaces`
   |
note: found an item that was configured out
  --> .../near-workspaces-0.24.0/src/lib.rs:12:16
   |
11 | #[cfg(feature = "unstable")]
   |       -------------------- the item is gated behind the `unstable` feature
12 | pub use cargo::compile_project;
```

The function is documented and the version is correct, yet the symbol "doesn't exist." The
`configured out` / `gated behind the `unstable` feature` note is the tell.

## Investigation (what was ruled out)

- **Not a wrong version.** `near-workspaces = "=0.24.0"` is the current max release and *does* ship
  `compile_project` — the `note` points right at it in the installed source.
- **Not a typo / wrong path.** `near_workspaces::compile_project` is the correct path; it is simply
  `#[cfg(feature = "unstable")]`-gated and therefore absent from a default build.
- **Not a missing `wasm32` target.** `compile_project` itself is what *produces* the wasm; the
  target is installed and unrelated to the symbol being missing.

## Root cause

In `near-workspaces 0.24`, the `cargo` helper module — including `compile_project` (compile the
current crate to wasm in-process) — is behind the **`unstable`** cargo feature:

```rust
// near-workspaces-0.24.0/src/lib.rs
#[cfg(feature = "unstable")]
pub use cargo::compile_project;
```

A plain `near-workspaces = "=0.24.0"` dev-dependency does not enable `unstable`, so the re-export is
compiled out and the call fails to resolve.

## Solution (verified)

Enable the `unstable` feature on the **dev**-dependency:

```toml
# contract/Cargo.toml
[dev-dependencies]
near-workspaces = { version = "=0.24.0", features = ["unstable"] }  # exposes compile_project
tokio = { version = "1", features = ["full"] }
anyhow = "1"
serde_json = "1"
```

Then `near_workspaces::compile_project(".")` resolves and the suite compiles. Verified with
`cargo test --test delegates` (contract compiled to wasm in-process, sandbox span, all cases green).

Idiomatic usage — compile the wasm **once** and share it across every `#[tokio::test]` (Rust has no
`beforeAll`), via a process-global `tokio::sync::OnceCell`:

```rust
use tokio::sync::OnceCell;
static WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn wasm() -> &'static Vec<u8> {
    WASM.get_or_init(|| async {
        near_workspaces::compile_project(".").await.expect("compile contract to wasm")
    })
    .await
}
// each test: let contract = worker.dev_deploy(wasm().await).await?;
```

> Why this doesn't hit near-sdk's host-build guard: `compile_project` builds with
> `--target wasm32-unknown-unknown`, so `cfg(target_family = "wasm")` is set and near-sdk's
> `compile_error!` (see sibling doc) is satisfied. The *test harness* crate itself compiles under
> `cfg(test)`, also valid.

## Alternatives (if you don't want `unstable`)

- Pre-build the wasm with `cargo near build non-reproducible-wasm` and `std::fs::read` the artifact
  from `contract/target/near/…wasm` in the test, instead of `compile_project`. This avoids the
  feature but adds a required build step before `cargo test` (less hermetic for CI).

## Prevention

- When a near-workspaces symbol resolves in the docs but not in your build, read the compiler
  `note:` — `configured out` almost always means a cargo feature gate (`unstable` here), not a
  missing/renamed item.
- Keep the `unstable` feature pinned alongside the exact `=0.24.0` version pin, and note in
  `BUILD-START-VERIFICATION.md` that the integration suite depends on it.

## Cross-references

- Sibling learning: `docs/solutions/build-errors/cargo-build-vs-cargo-near-build-guard.md`
  (why `cargo clippy --lib` / `cargo build` trip near-sdk's cfg guard, and why `--all-targets`/
  `cargo test` do not — relevant because the same suite exercises both).
- `docs/solutions/build-errors/cargo-near-install-libudev-ci-failure.md` (installing `cargo-near`).
- near-workspaces 0.24 source: `near-workspaces-0.24.0/src/lib.rs` (the `#[cfg(feature = "unstable")]` re-exports).

> Note: this repo keeps `docs/` untracked (per the scaffold-only commit policy), so this solution
> file is uncommitted like the other `docs/solutions/` entries. Commit it if/when `docs/` is tracked.
