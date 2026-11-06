---
title: "A Chain Signatures callback Err does not prove no signature exists: never release on it, and never let the relayer release either"
category: security-issues
date: 2026-11-06
tags: [chain-signatures, mpc, reclaim-on-proof, double-spend, relayer, trust-assumption, two-key-release, purser]
module: contract/src/evm_api.rs (on_signed, on_cancel_signed, attest_external, confirm_release)
symptom: "The first design released the reservation (Reserved -> Failed) on a signer Err, and let the relayer's 'cancel landed' attestation release budget. Review found both are double-spend paths."
root_cause: "The signer's sign() is a yield/resume. The MPC nodes publish the signature as the args of a respond() transaction. If the yield already timed out, respond fails to resume it (our callback sees Err), but the signature is still in the public args of that transaction. Separately, a relayer that can release can attest a cancel that never mined and then broadcast the original."
status: resolved
verified: false
---

# Release only on proof, and make the party that attests not the party that releases

`verified: false`: both scenarios come from reading the near/mpc design and the contract code during review. They were not
reproduced on a chain. The fix is in place and covered by sandbox tests; the reasoning is the point of this note.

## Scenario 1: Err is not "no signature"

1. `propose_payment` reserves, calls `sign`, and records nothing signed yet.
2. The MPC network produces the signature and submits `respond(request, response)`.
3. The yield has timed out, so `respond` cannot resume it. Our callback runs with `Err`.
4. The signature is still public in the failed `respond` transaction's args. Anyone can lift it and broadcast.
5. The first design had already freed the budget and the nonce lane, so a new payment re-used the nonce.

The same hole opens if `on_signed` runs out of gas or panics: the state stays `Reserved` and the signature is lost.

**Fix.**

| Situation | Result |
|---|---|
| Any `sign` callback `Err`, or an `Ok` that does not verify | `Reserved -> Unknown` (new edge). Reservation held. |
| Pre-reserve refusal (gas, balance, validation) | reverts, no state |
| `Reserved` older than 1 hour with no callback | `mark_unknown` (owner/relayer), then the cancel path |
| A late valid signature after `Unknown` | recorded in the commitment's metadata, state unchanged, never a panic |

`Failed` is unreachable after a reservation exists. The cancel path needs no signature at all (it is a fresh self-send at the same nonce).

## Scenario 2: the attester must not be the releaser

A compromised relayer holds the original raw tx (public `get_signed_tx` view). It calls `mark_unknown`, `request_cancel`, then
attests "cancel landed" for a cancel that never mined. If that releases the budget, the relayer or anyone else broadcasts the
original and funds leave twice. Absence of a transaction cannot be proven on NEAR.

**Fix: two-key release.** `attest_external` records cancel/reverted evidence only. Only the owner's `confirm_release` moves
`Unknown -> Cancelled` and frees the reservation. The relayer cannot release, cannot attest a hash the contract did not sign,
and a false "original landed" only over-counts one lane (budget burned, no theft).

Residual risk, documented in the README: an owner who confirms a release on a false claim, or a reorg at non-final depth,
can still see the original land after the budget was re-spent. The `Cancelled -> Confirmed` edge records the spend and
**freezes the task**. Evidence therefore requires `Finalized`, two agreeing RPCs, and `Safe` finality changes no state.

## Prevention

- Treat any callback result from a yield/resume callee as "unknown" unless the callee itself proves the negative.
- Name the attesting party in the trust model and bound it in code, not only in prose.
- Test the late-signature path, the reverted-receipt path and a relayer that tries to release; mutation-check each
  (the property model has mutations for "Err releases", "relayer can release", "no freeze on contradiction").

## Related

- [`owner-reconcile-contradicted-by-late-settlement-callback.md`](owner-reconcile-contradicted-by-late-settlement-callback.md) (the NEAR-native analogue: proof beats attestation)
- [`../integration-issues/chain-signatures-v1-signer-prod-testnet-3-18-interface-and-key-check.md`](../integration-issues/chain-signatures-v1-signer-prod-testnet-3-18-interface-and-key-check.md)
- `docs/plans/2026-11-06-feat-evm-governed-payment-path-plan.md` (Trust model, Release rules)
