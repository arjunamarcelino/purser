# mock-signer (TEST-ONLY)

A stand-in for the NEAR MPC signer `v1.signer-prod.testnet` (near/mpc 3.18.0) so the Purser EVM
payment path can be tested in the near-workspaces sandbox. It really ECDSA-signs, so the contract's
`ecrecover` check runs against genuine signatures.

**Never deploy it outside a sandbox.** Its root key is a public, fake constant (32 x `0x42`).
**Never reference it from `scripts/` or the `Makefile`** (CI guards this with
`! grep -rn mock-signer scripts Makefile`); only the test harness loads it, via `PURSER_WASM_MOCK_SIGNER`.

## Surface

`sign` (payable; needs >= 1 yoctoNEAR and >= 15 Tgas prepaid, `domain_id` 0, payload < n):

```json
{"request":{"path":"<s>","payload_v2":{"Ecdsa":"<64 lowercase hex>"},"domain_id":0}}
```

returns the real shape, signed (prehash) with the derived key `root_sk + tweak`, low-s:

```json
{"scheme":"Secp256k1","big_r":{"affine_point":"02|03 + 64 hex"},"s":{"scalar":"64 hex"},"recovery_id":0}
```

`tweak = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)`, where
predecessor is the account that calls `sign` (so the Purser contract account in tests).

Views: `public_key({"domain_id":0})` and `derived_public_key({"path","predecessor","domain_id"})`, both
returning `"secp256k1:<base58 of the 64-byte uncompressed key>"`.

Init: `new()` (the deployer becomes owner, mode `Ok`). `set_mode({"mode":"<Mode>"})` is owner-only;
`get_mode()` reads it.

| Mode | `sign` does |
|---|---|
| `Ok` | correct signature |
| `Err` | panics (the caller's callback sees `Err`, like a timed-out real signer) |
| `WrongKey` | well-formed signature from a different root, so ecrecover gives the wrong key |
| `Garbled` | right lengths, `recovery_id` 2 |
| `GarbledShort` | `s.scalar` 62 hex chars and `big_r.affine_point` truncated |

Differences from the real signer: `sign` answers synchronously (the real one yields and resumes, and
can time out), there is no MPC and a single fixed domain.

## Build and test

From `contract/` (this crate is its own workspace with its own `Cargo.lock`, like `race-driver`;
never run a bare `cargo build` here):

```sh
CARGO_TARGET_DIR="$PWD/target/mock-signer" cargo near build non-reproducible-wasm --locked --no-abi \
  --manifest-path tests/fixtures/mock-signer/Cargo.toml
# -> target/mock-signer/near/mock_signer.wasm
CARGO_TARGET_DIR="$PWD/target/mock-signer" cargo test --locked --manifest-path tests/fixtures/mock-signer/Cargo.toml
```

The host tests check the derivation against the real signer's published vector (real root public key
in, real derived key out) and that every signature recovers to the derived public key.

Pins stay in lock-step with `contract/` (toolchain file, `near-sdk` version); `Cargo.lock` is seeded
from `race-driver` so `near-sdk-env`/`near-sys` stay on the versions the sandbox runtime accepts.
