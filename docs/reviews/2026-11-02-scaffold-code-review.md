---
title: Code review — monorepo & toolchain scaffold (Prompt 1)
date: 2026-11-02
target: commit 8ba108e "chore: scaffold monorepo and toolchain" (branch main)
method: 3 read-only review agents (security / simplicity / architecture) + direct inspection + build verification
status: resolved — all P2/P3 fixed in commits abfdc8e..15332dd (pushed to origin/main; CI green); 1 item (branch protection) blocked by GitHub plan. This file is uncommitted (docs/).
---

# Code review — Purser scaffold (Prompt 1)

> Scope: the 14 files in commit `8ba108e` (the first commit — a logic-free monorepo + toolchain scaffold).
> This is an **advisory** review per the request: nothing in the repo was modified, and this document
> is not committed (it sits under the untracked `docs/` tree). Severities are relative to *a scaffold
> commit* — each finding notes *when it actually bites*.

## Verdict

**Sound scaffold; no merge-blockers.** The build is verified (`cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo near build` → 87 KB wasm + ABI, `cargo test` → 0 tests ok), secrets hygiene is correct, and the one load-bearing safety/lint settings are present. **No P1.** Every finding below is forward-looking hardening or YAGNI — nothing is wrong *for a scaffold*; the items matter at specific later moments (workspace promotion, first funded deploy, public remote, Prompt 2, the 2nd TS service).

The scaffold is unusually well-justified: most non-obvious lines carry a comment explaining why they exist, and all three reviewers independently confirmed the storage-key ordering, gitignore negation, and safety profile are correct.

## Resolution — 2026-11-02 (fixed, pushed, CI green)

All P2/P3 addressed one-commit-per-issue (`abfdc8e..15332dd`), pushed to `origin/main`; CI on `main` is **green** (both `contract` and `secrets` jobs pass).

| Finding | Status | Commit / note |
|---|---|---|
| A1 — release profile lost on workspace promotion | ✅ Resolved | `027d847` (Cargo.toml warning) + `704889b` (rust-toolchain note) |
| A2 — contract↔TS type-boundary owner | ✅ Resolved | `c6e4c0b` — `packages/types` declared canonical owner; all 4 services point to it |
| S1 — SHA-pin CI actions | ✅ Resolved | `abfdc8e` |
| S2 — reproducible build disabled | ✅ Resolved | `2d64296` — metadata populated + `make build-release` |
| M3 — Purser Borsh layout not append-only | ✅ Resolved | `b40bb6b` — warning + "don't stateful-init before full struct" |
| P3 — hook misses URL-embedded creds | ✅ Resolved | `35146b8` — URL-cred branch added (bare-hex/AWS stay in gitleaks by design) |
| P3 — Makefile target namespacing | ✅ Resolved | `863ccd7` — `contract-*` behind aggregating bare targets |
| P3 — proposer key-holder doc | ✅ Resolved | `4115da9` |
| P3 — hook bypassable → require gitleaks in branch protection | ⚠️ **Blocked** | Classic branch protection **and** rulesets are **Pro-gated for private repos** (gh API 403). The `secrets` gitleaks job still runs on every push and reddens on a leak; *enforcement* deferred to when the repo is made public (the reserved human step) or on Pro. |
| P3 — gitleaks license under org | ✅ N/A | Repo is user-owned (not an org) → gitleaks-action needs no license; the `secrets` job ran green. |
| P3 — app↔DB direct coupling | 📝 Acknowledged | Known v1 coupling; revisit post-hackathon. |
| P3 — rust 1.95 pinned in 3 places | 📝 Acknowledged | Intentional (3 distinct purposes); no change. |
| hook bare-hex/AWS branches | ✅ By design | Delegated to gitleaks CI; a local bare-hex rule would false-positive on `Cargo.lock` checksums. |

**New issue found + fixed during this pass (not in the original review):** the CI `contract` job failed — `taiki-e/install-action` had no prebuilt `cargo-near@0.22.0` and built it from source, which needs system `libudev` (hidapi) absent on the runner. Fixed in **`15332dd`** by installing cargo-near from its official prebuilt release binary; CI now green.

**Minor follow-up (non-blocking):** CI warns that `actions/checkout`/`upload-artifact`/`gitleaks-action` at the pinned SHAs still target Node 20; bump to Node 24 releases (e.g. checkout v5) when convenient.

> Per the scaffold-only decision, `docs/` stays untracked — this review doc and the plan were updated in place but are **not** committed.

---

## Findings

### P2 — fix before the milestone named in each (not blocking the scaffold)

| # | Finding | Where | Bites when |
|---|---|---|---|
| A1 | **`[profile.release]` is silently ignored once this becomes a Cargo workspace** — Cargo honors `[profile.*]` only in the *workspace root* manifest. On promotion the wasm rebuilds without `opt-level="z"`/`lto`/`codegen-units=1` and, critically, **`overflow-checks = true`** — a security-relevant setting turned off invisibly. This is the real reason "promotion is non-breaking" is only *mostly* true. | `contract/Cargo.toml:36-37` | On workspace promotion (plan's trigger: a 2nd Rust crate) |
| A2 | **No owner for the contract↔TypeScript type boundary** — CI already emits `target/near/*_abi.json`, and `proposer`/`app`/`indexer` will each consume `TaskBudgetView`/`Commitment`/`PaymentIntent` (schema §1.2). Nothing designates a generated bindings package or an ABI→TS codegen step, so three+ services will hand-roll and drift from the Borsh/JSON source of truth. For a monorepo whose whole value is one language boundary, this is the gap most likely to cause silent bugs. | `.github/workflows/ci.yml` (ABI), service dirs | Before the 2nd TS service (P7+) |
| S1 | **CI actions pinned to mutable tags, not SHAs** — `dtolnay/rust-toolchain@1.95.0`, `Swatinem/rust-cache@v2`, `taiki-e/install-action@v2`, `gitleaks/gitleaks-action@v2` can be force-moved to malicious code. The `ci.yml` comment acknowledges this but ships unpinned. | `ci.yml` (uses: lines) | Before a public remote |
| S2 | **Reproducible build disabled** — the `[package.metadata.near.reproducible_build]` block is commented out, so build/CI use `non-reproducible-wasm`. Fine for a testnet scaffold, but a funds-holding contract must ship a verifiable hash before any deploy with value. | `contract/Cargo.toml:41-45` | Before the first funded/demo deploy |
| M3 | **The `Purser` struct's Borsh field order is NOT append-only-safe, and nothing says so** — unlike `StorageKey`, which carries a loud append-only warning. Schema §1.1 wants collections *between* `owner` and `signer_id`; inserting them later changes the Borsh layout. Harmless only because nothing stateful is deployed. Since CI builds a *deployable* wasm, a stateful `new()` during demo prep would create `migrate`/`ignore_state` debt. Recommend an explicit "do not `new()` this on testnet until the full struct lands" note, and/or decide now to append future fields *after* `signer_id`. | `contract/src/lib.rs:30-35` | Prompt 2 / any early on-chain init |

### P3 — hardening / known limitations

- **Local secret hook misses some key shapes by design** — bare 64-hex keys under a non-secret var name (`DEPLOYER_KEY=<64hex>`), AWS *secret* keys (40-char), and URL-embedded creds (`proto://user:pass@host`) are **delegated to the gitleaks CI job** (the hook's own comment says so). ⚠️ *Adjudication:* the security agent suggested adding a `\b(0x)?[0-9a-fA-F]{64}\b` branch to the local hook — but that would re-introduce the `Cargo.lock` `checksum = "<64hex>"` false-positive the same agent verified is currently avoided. Keeping bare-hex in gitleaks (which allowlists lockfiles) is the correct split; **do not** add it to the local grep. (`scripts/pre-commit`)
- **Hook is client-side, opt-in, bypassable** — needs `make hooks` after each clone and `git commit --no-verify` skips it. Keep the **gitleaks CI job required in branch protection** so bypassed/uninstalled-hook commits still fail. (`Makefile:10`, `ci.yml:38-45`)
- **`gitleaks-action@v2` may silently no-op without a license under an org** — confirm the scan actually runs (not merely "green") once the repo lands under an org (needs `GITLEAKS_LICENSE`). (`ci.yml:44`)
- **Makefile target names are contract-global** — `build`/`test`/`fmt`/`lint` mean "contract" today (`cd contract && …`). When TS services arrive, `make test` should mean "everything," forcing a rename. Cheaper to namespace now (`contract-build`, …) with bare targets aggregating. *(Tension: Prompt-1 spec names the bare targets `build/test/deploy-testnet/demo/metrics` — see Adjudications.)* (`Makefile`)
- **`app` reads the cache DB directly, no API boundary** — TRD §1 shows `APP → DB`; couples React to the indexer's Postgres schema. Acceptable for v1; record as a conscious coupling, not an accident.
- **`rust-toolchain.toml` placement** — correct in `contract/` now (Makefile and CI run from there); move to repo root on workspace promotion so it governs all crates. (`contract/rust-toolchain.toml`)
- **Proposer key-holder undocumented** — `relayer/README` cleanly isolates `RELAYER_PRIVATE_KEY`; `proposer/README` says nothing about who provisions/holds its NEAR fn-call key. Doc-symmetry gap now, a real boundary question later. (`proposer/README.md`)
- **Rust `1.95` pinned in three places** — `rust-toolchain.toml:2`, `Cargo.toml:5` (`rust-version`), `ci.yml:19` (`dtolnay@1.95.0`). Each has a distinct purpose, so defensible, but it's three edit sites per version bump.

### Simplicity (YAGNI) — candidate trims, with adjudication

The simplicity pass flagged several items as premature for commit #1. Some are genuine; several collide with the **Prompt-1 spec** (`docs/PURSER-BUILD-PROMPTS.md`) which *mandates* them. Adjudicated:

| Item | Simplicity verdict | Adjudication |
|---|---|---|
| 7-variant `StorageKey` enum + `#[allow(dead_code)]` | Defer until first use | **KEEP** — the Prompt-1 spec mandates the enum, and architecture confirmed the order is locked correctly in schema order (cheap insurance for Borsh prefix stability). Dissent noted. |
| `[dev-dependencies]` (near-workspaces/tokio/proptest) with zero tests | Defer until a test needs them (biggest YAGNI) | **Optional/soon** — genuinely unused today, but Prompt 2 (unit tests) and Prompt 6 (proptest + near-workspaces) need them next. Low urgency to remove; harmless to leave. |
| `lto` + `codegen-units=1` | Defer (build-time cost, no size to save yet) | **Reasonable minor trim** — but they ship in the canonical `cargo near` template; leaving them matches canonical. Judgment call; low stakes. |
| Commented `[package.metadata.near.reproducible_build]` | Delete | **Keep as documented placeholder** — security (S2) wants it *populated* before a funded deploy; deleting loses the reminder. |
| Makefile `deploy-testnet`/`demo`/`metrics` TODO-echo targets | Defer | **KEEP** — Prompt-1 spec lists exactly these targets as stubs. |
| CI `upload-artifact` of a stub wasm | Defer | **Reasonable minor trim** — pure ceremony until there's an artifact worth keeping. |
| `relayer/` stretch stub dir | Drop until EVM path starts | **Keep (weak)** — architecture favors locking dir names early; it's one file. Judgment call. |

## Verified correct (independently confirmed — no action)

- `.gitignore` negation works (`git check-ignore`: `.env`→ignored, `.env.local`→ignored, `.env.example`→tracked); `.env.*` then `!.env.example` ordering correct.
- `.env.example` is placeholders only; `SIGNER_CONTRACT_ID=v1.signer-prod.testnet` is a public testnet id, not a secret.
- `Cargo.lock` committed (correct for a `publish=false` cdylib contract; `--locked` reproducible path will work); exact `=` pins throughout.
- Safety profile right: `overflow-checks = true` + `panic = "abort"`; `PanicOnDefault` + `#[init]`; no `unsafe`, no raw transfers, no unwrap-on-input.
- `[lints.rust.unexpected_cfgs]` is **necessary** (near-sdk 5.x expands `cfg(near)`; without it `clippy -D warnings` hard-fails) — earns its place.
- CI uses `pull_request` (not `pull_request_target`) + top-level `permissions: contents: read` → no fork secret-exposure path; gitleaks job has `fetch-depth: 0`.
- pre-commit hook does **not** false-positive on `Cargo.lock` checksums and does **not** self-trigger on its own regex text; scans added lines only.
- `StorageKey` order matches schema §1.1; append-only comment accurate, incl. the nested-`Vector` sub-prefix caveat.
- `edition = "2021"` is a deliberate, documented conservative deviation from the template's 2024 — fine.

## Stakeholder / scenario angles (scaffold stage)

- **Developer:** clear, comment-justified, one-command build (`make build`); nothing to debug yet.
- **Operations:** CI is dormant until a remote exists; watch the gitleaks-license caveat under an org; the SHA-pin gap (S1) matters before the repo is public.
- **Security:** no secrets committed; testnet-only is **documentation-only** (`NEAR_NETWORK`/`SIGNER_CONTRACT_ID` defaults) — a hard mainnet-refusal assertion is correctly deferred to the deploy/CLI code (Prompt 10), not relied on here.
- **Scenarios:** no runtime surface yet, so classic input/concurrency/scale scenarios don't apply. The two "scenarios" that *do* bite are structural: workspace-promotion profile loss (A1) and a stateful `new()` before the full struct (M3).

## Recommended actions (advisory — not applied)

Ordered; none block the scaffold. Most are already tracked in the plan's "carry-forward notes" / "doc-sync follow-ups" (`docs/plans/2026-11-02-chore-purser-monorepo-scaffold-plan.md`):

1. **Before a public remote:** SHA-pin all CI `uses:` refs (S1); confirm gitleaks actually scans under the org (P3).
2. **At/with Prompt 2:** add the "do not stateful-`new()` before the full struct" note and decide struct field-append order (M3).
3. **Before any funded/demo deploy:** populate + enable `reproducible_build` (S2).
4. **Before the 2nd TS service (P7+):** stand up ABI→TS bindings / a shared `types` package (A2).
5. **On workspace promotion (if ever):** move `[profile.release]` *and* `rust-toolchain.toml` to the root manifest (A1, LOW-6) — add this to the promotion checklist now so `overflow-checks` can't vanish silently.
6. **Low-stakes, optional:** namespace Makefile targets when TS services land; drop the CI stub-artifact upload; document the proposer key-holder.

---

*No files were modified and no todos were created during this review, per instruction. Reviewed commit `8ba108e` on `main`.*
