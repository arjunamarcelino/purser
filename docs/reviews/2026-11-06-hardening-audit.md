# Hardening audit against TRD §10 (S1-S8)

Date: 2026-11-06. Scope: `contract/src` at the commit that introduces the S8 limits. Method: reading the code,
`scripts/audit-security.sh` (static checks, with a seeded-violation self-test in `scripts/audit-security-selftest.sh`,
both run by `make audit`, `make lint` and CI), and behavior tests that assert the refusal and that state is unchanged.

| Req | Result | Evidence |
|---|---|---|
| **S1** no entrypoint signs a client-supplied hash | Pass | The `"sign"` call exists at one site (`sign_promise`, `evm_api.rs`) with exactly two callers (`propose_evm`, `request_cancel`), both hashing in-contract from stored fields. `attest_external` takes a tx hash and signature but only compares them to stored values or recovers them against the cached key; they never reach `sign`. Audit rule S1 pins both counts. |
| **S2** owner and delegate gating | Pass | Every `&mut self` entrypoint carries an owner, owner-or-relayer or delegate assertion, or is `#[private]`. Audit rule S2 fails on an ungated mutator (fixture `ungated_mut`). New: `set_task_limits` is owner-only (`tests/limits.rs`). |
| **S3** `#[private]` on all callbacks | Pass | `on_near_settled`, `on_derived_key`, `on_signed`, `on_cancel_signed` are private. Audit rule S3 handles multi-line attribute blocks (fixture `missing_private_multiline`). `tests/refusals.rs::on_near_settled_cannot_be_called_directly` calls the callback from the owner and from a delegate and gets a refusal with state unchanged. |
| **S4** reserve before any async boundary | Pass | In `propose_payment` the first `Promise` follows `open_reservation`; in `propose_evm` the sign promise follows it too; `request_cancel` claims the cancel slot before its sign promise. Audit rule S4 fails if a `Promise::new`, `::ext(` or `sign_promise(` precedes `open_reservation` (fixture `promise_before_reserve`) and fails if either function cannot be found. The concurrency tests prove from receipt heights that every admission ran before the first settlement (`tests/attacks.rs`). |
| **S5** conservative settlement | Pass | No path releases on silence. Case 7 and case 8, the lost-callback property tests, and the EVM callback `Err` to `Unknown` tests cover it. The measuring harness repeats the lost-callback scenario and counts releases on silence (`timeout.release_on_silence`, expected 0). |
| **S6** revocation | Pass, with the documented limit | Revocation blocks new authorizations and cannot recall issued signatures (README, Honest limits). The contract issues no access keys. |
| **S7** no secrets | Pass | Audit rule S7 (no key-shaped literals in `contract/src`), the pre-commit hook and gitleaks in CI. |
| **S8** state-growth griefing | **Finding, fixed** | See below. |

## S8 finding

Before this change a registered delegate could loop tiny payments, or payments whose transfer fails, and grow state
at the contract's expense. Each admitted proposal persists a commitment and an idempotency entry (measured:
**375 bytes, about 0.00375 NEAR of stake**); there was no minimum payment and no limit on commitments; and
commitments are never pruned, so a failed transfer releases its budget but leaves its entries behind. A
minimum payment alone would not have closed the failing-transfer loop. A related effect: `set_relayer` scans every
commitment, so bloat could push it past the gas limit and block changing the relayer.

Fix: a per-task limit on commitments **ever created** (`created_count`, never decremented), counted inside
`open_reservation` so one site covers the NEAR and EVM paths, plus an optional owner-set minimum payment for NEAR
tasks. The limits live in a separate map under an appended storage prefix (`StorageKey::TaskLimits`), not in a
struct field, so there is no Borsh layout change and the deployed contract upgrades in place without a migration.
Defaults for a task the owner never configured: no minimum, 1000 commitments. `propose_payment` is no longer
`#[payable]`, so an attached deposit is rejected by the runtime instead of being silently kept.

Tests: `contract/tests/limits.rs` (at-minimum passes, below-minimum refused, the next commitment past the limit
refused, failed transfers still consume the limit, deposit refused, owner-only setter, lower-then-raise).

Residual, documented in the README: growth is bounded per task, not zero; the owner can raise the limit; the storage
stake is paid from the contract's own balance; `set_recipient_allowlist` takes an unbounded list but is owner-only.

## Refusal-path coverage

Every `pub const MSG_*` in `contract/src/error.rs` is now referenced by a behavior test or listed with a
justification and a named unit test. `contract/tests/refusals.rs::every_refusal_message_has_a_test` derives the list
from the source, so a new refusal without a test fails CI. Three refusals cannot be reached through an entrypoint and
are covered by named unit tests: `MSG_SPENT_EXCEEDS` (`budget.rs::settle_rejects_spent_over_reserved`), `MSG_ILLEGAL`
(`budget.rs::settle_rejects_illegal_sources`) and `MSG_EVM_SIGHASH_RANGE` (needs a keccak output outside the curve
order, about 2^-128; `evm_tx.rs::sighash_must_be_a_secp256k1_scalar`).

## Other findings from this pass

- `ProptestConfig::with_cases` ignores `PROPTEST_CASES`, so the documented override (and CI's `256` and `20000`
  settings) did nothing. The property tests now read the variable, and the case count printed in `docs/METRICS.md` is
  emitted by the test itself.
- A fresh proptest seed found an overflow in the property test's reference model (not in the contract): with a cap
  near `u128::MAX / 2`, two contradicted spends push `completed + outstanding` past `u128::MAX`. The contract uses
  checked arithmetic and refuses atomically (`ArithmeticOverflow`); the model now predicts that refusal, and the seed
  is saved in `properties.proptest-regressions`. Real NEAR amounts are far below this range.
