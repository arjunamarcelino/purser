---
title: "cargo-near install fails in CI: libudev/hidapi source build"
category: build-errors
date: 2026-11-02
tags: [ci, github-actions, cargo-near, near-sdk, rust, wasm, libudev, hidapi, pkg-config, taiki-e, cargo-binstall]
module: ci / contract toolchain
symptom: "GitHub Actions 'contract' job fails installing cargo-near: 'Unable to find libudev' / 'hidapi ... libudev not found' -> cargo install cargo-near exit 101"
root_cause: "taiki-e/install-action had no prebuilt cargo-near, fell back to a source build whose hidapi dependency needs the system lib libudev, absent on ubuntu-latest"
status: resolved
resolved_in: 15332dd
verified: true
---

# cargo-near install fails in CI: libudev / hidapi source build

## Symptom

The GitHub Actions `contract` job fails at the cargo-near install step (`taiki-e/install-action@v2`
with `tool: cargo-near@0.22.0`). The `secrets`/gitleaks job passes; only the contract job is red.
Tail of the failing log:

```
thread 'main' panicked at .../hidapi-2.6.6/build.rs:59:50:
Unable to find libudev:
pkg-config exited with status code 1
  > ... pkg-config --libs --cflags libudev
  Package libudev was not found in the pkg-config search path.
  Package 'libudev', required by 'virtual:world', not found
The system library `libudev` required by crate `hidapi` was not found.
...
error: failed to compile `cargo-near v0.22.0` ...
cargo-binstall: ERROR Cargo errored! ...
  × For crate cargo-near: subprocess cargo install cargo-near --version 0.22.0 ... exit status: 101
##[error]Process completed with exit code 70.
```

Locally the same `cargo near build` works fine — the failure is CI-only.

## Investigation (what was ruled out)

- **Not the contract code.** `cargo near build` / `cargo clippy` / `cargo test` all pass locally and
  the earlier CI steps (`fmt`, `clippy`, `test`) succeeded. The failure is purely in *installing* the
  `cargo-near` tool, before our contract is built.
- **Not gitleaks / secrets.** The `secrets` job (gitleaks-action) completed green — no license issue on
  a personal (non-org) repo.
- **Not a flaky network.** The error is a deterministic missing system library during a *source* compile.

## Root cause

`taiki-e/install-action` did not have a prebuilt `cargo-near@0.22.0` in its registry, so it delegated to
`cargo-binstall`, which also found no prebuilt artifact and fell back to `cargo install cargo-near`
(**building from source**). cargo-near depends on `hidapi` (hardware-wallet HID support), whose `build.rs`
requires the system library **`libudev`** via `pkg-config`. GitHub's `ubuntu-latest` runner does not ship
`libudev-dev`, so the source build panics and the whole install fails.

In short: *installing cargo-near from source drags in a Linux system dependency the runner lacks.* The fix
is to not build it from source.

## Solution (verified, commit `15332dd`)

Install cargo-near from its **official prebuilt release binary** (the cargo-dist installer), which is
self-contained — no `hidapi`/`libudev`, no source compile, and much faster.

In `.github/workflows/ci.yml`, replace the taiki-e step:

```yaml
# BEFORE — falls back to a source build that needs libudev
- uses: taiki-e/install-action@<sha> # v2
  with:
    tool: cargo-near@0.22.0
- run: cargo near build non-reproducible-wasm
```

```yaml
# AFTER — official prebuilt binary, version-pinned
- name: Install cargo-near (official prebuilt binary — avoids a source build of hidapi/libudev)
  run: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh
- run: cargo near build non-reproducible-wasm   # also emits target/near/*_abi.json
```

Result: both CI jobs (`contract`, `secrets`) pass. The installer URL is pinned to the
`cargo-near-v0.22.0` release tag, so the version stays reproducible.

## Alternative fixes (and why the prebuilt binary won)

| Option | Works? | Downside |
|---|---|---|
| **Official prebuilt installer** (chosen) | ✅ | curl-pipe-sh is slightly less auditable than a SHA-pinned action, but it's the vendor's versioned release asset over TLS. |
| `sudo apt-get install -y libudev-dev pkg-config` then keep the source build | ✅ | ~9-minute cargo-near source compile on every CI run; wasteful. |
| Force cargo-binstall to prefer prebuilt | ⚠️ | No prebuilt was found for 0.22.0 via binstall, so it still fell through to source. |

## Prevention

- For NEAR Rust CI, **install `cargo-near` from its official prebuilt binary** (or `cargo near`'s own
  GitHub Action if/when it's the recommended path), not a generic installer that may compile from source.
- Be aware that `taiki-e/install-action` / `cargo-binstall` **silently fall back to a source build** for
  tools without a prebuilt entry — which can pull system libraries (here `libudev` via `hidapi`) absent on
  CI runners. If a source build is unavoidable, add the system deps explicitly
  (`libudev-dev`, `pkg-config`).
- Pin the installer to a release tag (`cargo-near-v<version>`) so the toolchain stays reproducible.
- Smoke-test CI on the very first push of a new workflow — this failure only surfaced on the runner, never
  locally (macOS has the HID libs; `cargo near build` never installs cargo-near).

## Cross-references

- Fix commit: `15332dd` — "ci: install cargo-near from its prebuilt release binary"
- Workflow: `.github/workflows/ci.yml`
- Review that surfaced it: `docs/reviews/2026-11-02-scaffold-code-review.md` (Resolution section)
- Scaffold plan: `docs/plans/2026-11-02-chore-purser-monorepo-scaffold-plan.md`
- Upstream: near/cargo-near releases (`cargo-near-v0.22.0`), `hidapi` crate build.rs (libudev requirement)

> Note: this repo keeps `docs/` untracked (scaffold-only commit policy), so this solution file is
> uncommitted like the plan and review docs. Commit it if/when `docs/` is tracked.
