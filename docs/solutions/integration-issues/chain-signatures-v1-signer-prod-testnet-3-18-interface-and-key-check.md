---
title: "Calling v1.signer-prod.testnet 3.18.0 from a Rust contract: the real sign args, response shape, key derivation and the ecrecover check"
category: integration-issues
date: 2026-11-06
tags: [chain-signatures, mpc, near-sdk, ecrecover, key-derivation, secp256k1, evm, testnet, purser]
module: contract/src/evm_api.rs, contract/tests/fixtures/mock-signer
symptom: "The spec said sign(payload: [u8;32], path, key_version) and flagged the response shape as 'from an in-development PR'. A contract that follows that shape cannot be trusted to work against the deployed signer."
root_cause: "The deployed contract (version view returns 3.18.0) takes a wrapped request with a hex payload and a domain_id; the old flat args only survive in a compat layer. The derived key needs the calling contract as predecessor."
status: resolved
verified: true
---

# What `v1.signer-prod.testnet` 3.18.0 actually accepts and returns

Checked against the near/mpc `3.18.0` source and the live testnet views on 2026-11-06, then exercised by a real
payment (`propose_payment` -> `sign` -> `on_signed` -> `Signed`). Source: `crates/contract/src/api/{sign,keys}.rs`.

## Call

```json
{"request":{"path":"<delegate path>","payload_v2":{"Ecdsa":"<64 lowercase hex, no 0x>"},"domain_id":0}}
```

- The args are **wrapped** in `request`. `payload_v2` is an externally tagged enum, not a byte array.
- `domain_id` 0 is secp256k1. Domain 3 (ForeignTx) is rejected by `sign`.
- The payload must be a valid secp256k1 scalar (below the group order).
- The legacy flat `payload` / `key_version` still parse, but are mutually exclusive with the new fields.
- Attach **1 yoctoNEAR** (excess is refunded) and **at least 15 Tgas** prepaid (live `config` view).

## Response

```json
{"scheme":"Secp256k1","big_r":{"affine_point":"02|03 + 64 hex"},"s":{"scalar":"64 hex"},"recovery_id":0}
```

`s` is low-s by construction (the signer's own `respond` verifies with `ecrecover(.., malleability=true)`).
EVM signature: `r = affine_point[1..]`, `s = scalar`, `yParity = recovery_id`. Reject 2 and 3. No 27/28, no EIP-155 offset.

## The check that proves the key

`recovery alone proves nothing`. Compare the recovered key with the key the contract asked for:

```
pk = env::ecrecover(sighash, r || s, recovery_id, true)   // 64-byte uncompressed key, no 0x04
require!(pk == cached_derived_key)
```

`env::ecrecover` is behind near-sdk's **`unstable` feature**. Turning it on changes the dependency line from
`near-sdk = "=5.30.0"` to table form, which broke CI's lock-step `pin()` grep until the regex was widened.

## Derived key (no EC math in wasm)

```
tweak   = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)   // NIST SHA3, not Keccak
derived = root_pk + tweak * G
```

- `predecessor` is the **calling contract** (the Purser account), never an argument.
- The view `derived_public_key({path, predecessor, domain_id})` returns `secp256k1:<base58 of 64 bytes>`. Always pass
  `predecessor`: a view call has none.
- The contract does not recompute it. Owner calls `cache_derived_key(path)` once: a promise to that view, a
  `#[private]` callback that parses exactly 64 bytes and is **write-once**. `propose_payment` then needs no async step before reserving.
- Test vector (path `x`, predecessor `purser.arjuna-purser.testnet`):
  `secp256k1:67756ZjiVxANYvYhQagGaWj2APpo1C1UMq2ebVWoy3GMU3zmYaM9ho6DNyDxRjo1Uzo2UDMkmeutgZFKQhgpnd1W`.
  An independent `@noble/curves` computation matched the live view; the mock signer's public derivation is
  tested against the real root key for the same vector.
- EVM address = last 20 bytes of `keccak256(pubkey64)`. A fresh lane address can be recomputed independently.

## Gas, measured from the live transactions

| Receipt | gas_burnt |
|---|---|
| signer `sign` | 4.27 Tgas |
| signer `return_signature_and_clean_state_on_success` (resume) | 3.46 Tgas |
| purser `on_signed` | 3.15 Tgas |
| purser `propose_payment`, synchronous part | 3.94 Tgas |
| signer `derived_public_key` | 5.37 Tgas |
| purser `on_derived_key` | 1.97 Tgas |

Attached budgets (`SIGN_GAS` 50, `ON_SIGNED_GAS` 30, `EVM_MIN_PREPAID` 100) all keep at least 2x headroom. The sandbox mock
signer answers synchronously and under-measures the real yield/resume, so measure the real one from live receipts.

## Test it without the real signer

`contract/tests/fixtures/mock-signer` mimics the above with a fake root key and modes `Ok | Err | WrongKey | Garbled | GarbledShort`.
Keep it out of scripts, the Makefile and deploy tooling (a CI grep guard enforces this). Never regenerate its `Cargo.lock` from
scratch: a fresh resolve pulls crates that do not compile on the host.

## Related

- [`../security-issues/mpc-signer-err-is-not-proof-of-no-signature.md`](../security-issues/mpc-signer-err-is-not-proof-of-no-signature.md)
- [`chainsig-js-evm-reference-vectors-stub-client-and-number-limits.md`](chainsig-js-evm-reference-vectors-stub-client-and-number-limits.md)
- `docs/EVM-PROBES.md`, `docs/plans/2026-11-06-feat-evm-governed-payment-path-plan.md`
