---
title: "Verifiable NEAR-native payload_hash: construct a tamper-evident audit anchor that off-chain verifiers re-derive without the Rust source"
category: integration-issues
date: 2026-11-04
tags: [near-sdk, 5.30, payload-hash, sha256, borsh, domain-separation, chain-signatures, never-blind-sign, audit-anchor, re-derivation, indexer, pure-core, env-boundary, payload-scheme, borsh-determinism, contract, verifier-parity]
module: contract payload construction (payload.rs / propose_payment / open_reservation) + off-chain verifier (indexer/dashboard)
symptom: "You need a NEAR contract to prove exactly which transaction it authorized (Rule 5, 'never blind-sign') AND let an off-chain verifier (TS indexer, dashboard, judge) independently reconstruct that proof. Naive attempts fail in subtle ways: env::sha256_array can't live in the pure core; a bare client-supplied hash defeats the whole point; an unframed domain tag collides across versions; borsh non-determinism / AccountId-vs-String encoding makes the off-chain re-derivation silently diverge; and exposing only {domain,version,hash,encoding} is STILL insufficient to re-derive because the composition rule (field order + that the domain is a raw prefix, not borsh) stays source-only."
root_cause: "A NEAR-native transfer is authorized by issuing a Promise, not by signing a hash — so payload_hash is an INTEGRITY/AUDIT anchor, not a signature. Making it genuinely verifiable requires (a) deriving it only from contract-validated fields (never a client hash), (b) a deterministic, re-derivable encoding, and (c) publishing the full composition rule on-chain. Each of those has a specific SDK/borsh pitfall that is easy to get subtly wrong."
status: resolved
verified: true
---

# Verifiable NEAR-native `payload_hash` (tamper-evident, off-chain re-derivable)

**One-line:** record a per-spend, domain-separated `sha256` over a borsh-canonical preimage built
from the fields the contract itself validated and executes; expose the *entire* re-derivation
contract through a view so any language can reconstruct it. Shipped in PR #4 (Purser `contract/`).

## Problem

Two coupled requirements:

1. **Never blind-sign (Rule 5).** The contract must authorize only a transaction it constructed from
   a structured `PaymentIntent` — never a client-supplied raw hash. (TRD **S1**.)
2. **Independently verifiable.** An off-chain verifier (indexer, dashboard, hackathon judge) must be
   able to reconstruct the exact 32-byte anchor and confirm it matches the on-chain `Commitment` —
   *without reading the Rust source.*

The naive "just `sha256` the intent" has ~6 distinct failure modes (below), each of which silently
breaks either the architecture, determinism, or the "no source needed" goal.

## Solution

### Final hash definition (per-spend, domain-separated, length-framed)

```
payload_hash = sha256( PAYLOAD_DOMAIN(32B, fixed) || borsh(version:u16, task, commitment_id:u64, recipient:&AccountId, amount_yocto:u128) )
```

- **Per-spend binding** (`task` + `commitment_id`) makes each anchor unique and a safe template for a
  future real signing digest (EVM) — a `recipient+amount`-only preimage would be replayable.
- **Hash the PARSED recipient + `intent.amount`** — the exact values handed to
  `Promise::new(recipient).transfer(amount)`. "Hashed == executed" is then structural.
- **Exclude `token`/`delegate`/`memo`** — `token` is a validated constant on this path, a native
  transfer carries no `memo`, and both are already stored on the `Commitment`. Hashing them buys no
  integrity and forces caveats.

### Architecture: pure core builds bytes, `#[near]` layer hashes

`env::sha256_array` is an `env` host call, so it CANNOT live in the pure, env-free core. Split it:

```rust
// payload.rs (pure, env-free) — builds the canonical bytes
pub fn canonical_payload_bytes(task: &TaskId, commitment_id: CommitmentId, recipient: &AccountId, amount_yocto: u128) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(PAYLOAD_DOMAIN.len() + 162); // 162 = worst-case body
    bytes.extend_from_slice(&PAYLOAD_DOMAIN);
    near_sdk::borsh::to_writer(&mut bytes, &(PAYLOAD_VERSION, task, commitment_id, recipient, amount_yocto))
        .expect("borsh serialize to Vec is infallible"); // single allocation, no intermediate Vec
    bytes
}

// lib.rs (#[near] boundary) — hashes inside open_reservation, AFTER try_reserve admits + cid assigned
let payload_hash = match intent.chain {
    Chain::NearNative => env::sha256_array(&canonical_payload_bytes(task, cid, recipient, intent.amount.as_yoctonear())),
    Chain::Evm { .. } => env::panic_str(MSG_UNSUPPORTED_CHAIN), // Prompt 12 adds its own scheme HERE
};
commitment.payload_hash = Some(payload_hash);
commitment.payload_version = Some(PAYLOAD_VERSION); // both set together
```

### Make it re-derivable off-chain: the `payload_scheme()` view

Exposing `{domain_hex, version, hash, encoding}` is NOT enough — a non-Rust client still can't learn
the field order, that `AccountId` encodes as a borsh `String`, which fields are excluded, or that the
domain is a *raw prefix* (not borsh). The complete, self-describing DTO:

```jsonc
payload_scheme() -> {
  "chain": "near-native",                 // branch key; EVM is a sibling scheme
  "version": 1,
  "hash_algorithm": "sha256",             // NOT "hash" (that reads like a digest value)
  "encoding": "borsh",
  "domain_hex": "7075...",                // 32-byte RAW PREFIX
  "preimage": "sha256( domain32 || borsh(version:u16, task:string, commitment_id:u64, recipient:string, amount_yocto:u128) )"
}
```

Plus **`Commitment.payload_version`** (appended, Borsh append-only) so a verifier re-derives a
historical anchor under *its* recorded version after a future bump. Both `payload_hash` and
`payload_version` also ride the `PaymentReserved` event, so an event-only indexer hydrates without a
`get_commitment` round-trip.

## The pitfalls (each cost real debugging / review rounds)

| Pitfall | Fix |
|---|---|
| `env::sha256_array` placed in the pure `payload.rs` core | Build bytes in the pure core; hash at the `#[near]` boundary (`env` call stays single-sourced). sha256 is a **host import** → 0 wasm bytes. |
| Accepting a client-supplied hash to sign | Never. Derive from contract-validated fields only. `grep -rE 'payload:\s*\[u8|hash:\s*\[u8|fn +sign' src/` must be empty (TRD S1 tripwire). |
| Unframed domain tag (`"…v1"` is a byte-prefix of `"…v10"`) | Use a **fixed-length** 32-byte domain AND a `version` field as the first borsh element. |
| borsh non-determinism | No `HashMap`/`HashSet` in a preimage (historically insertion-ordered); use primitives + length-prefixed strings. `AccountId` borsh-encodes identically to `String` (u32-LE len + UTF-8) — pin this with a LOAD-BEARING unit test so an SDK change fails CI. |
| Off-chain re-derivation drifts from on-chain | Test with an **independent** oracle: the `sha2` *crate* (not `env::sha256_array`, which reuses the contract's own path) over a hand-assembled preimage. `near_sdk::borsh` 1.x matches an independent `borsh` 1.x byte-for-byte. |
| Scheme reachable only from Rust source | Publish the FULL composition rule via `payload_scheme()` (incl. the `preimage` descriptor + `chain`), sourced from `payload::` consts so the view can't drift from the implementation. |
| Hash computed before `try_reserve` | Hash AFTER admission (inside `open_reservation`), so a zero/over-budget refusal does no hash work and burns no `cid`. |

## Prevention / checklist for the next on-chain audit anchor

- [ ] Preimage = fixed-length domain prefix **outside** borsh + `version` as the first borsh field.
- [ ] Bind identity (`task`, `id`) for per-spend uniqueness + replay-safe-template reuse.
- [ ] Hash only contract-validated fields that equal what's executed; exclude stored/constant fields.
- [ ] Pure core returns bytes; `#[near]` layer calls `env::sha256_array`.
- [ ] `match intent.chain` at the hash site (not a distant validator) so new chains must pick a scheme.
- [ ] Store the scheme `version` per record; carry hash+version on the event too.
- [ ] A `*_scheme()` view returns chain + version + algorithm + encoding + domain + a machine-readable
      `preimage` descriptor — enough to re-derive with zero source access.
- [ ] Independent-oracle test (sha2 crate + hand-assembled layout) + a load-bearing wire-layout test
      pinning `AccountId == String`.
- [ ] S1 grep as a CI tripwire; the real guarantee is the type system (only a structured intent enters).

## Build/verify notes (this repo)

- `make lint` = `cargo clippy --all-targets -- -D warnings` (NOT `--lib` — trips near-sdk's guard).
- `make test` runs `near-workspaces` sandbox tests (real host sha256); `make build` = `cargo near build`.
- Dev-dep `sha2 = "0.11"` is test-only (the independent oracle); never links into the wasm.

## Related

- `docs/solutions/build-errors/cargo-build-vs-cargo-near-build-guard.md` — the lint/build guard.
- `docs/solutions/build-errors/near-sdk-5-30-callback-result-vs-deprecated-promise-result.md`.
- `docs/solutions/build-errors/near-workspaces-compile-project-unstable-feature.md` — the sandbox harness.
- `docs/PURSER-TECHNICAL.md §8`, `docs/PURSER-TRD.md §10 (S1)`, `docs/PURSER-APP-FLOW.md §8 (Flow F)`,
  `docs/PURSER-BACKEND-SCHEMA.md §1.2` — the specs this realizes.
- PR #4 (`feat/near-native-payload-hash`) + `docs/reviews/2026-11-04-pr4-payload-hash-review*.md`.
- Forward: the TS indexer verifier consuming `payload_scheme()` + a shared Rust↔TS golden vector in CI.
