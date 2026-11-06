---
title: "Measuring gas for a NEAR contract change in near-workspaces: six ways the number lies"
category: performance-issues
date: 2026-11-06
tags: [gas, near-workspaces, sandbox, measurement, load-tax, receipts, optimizer, purser]
module: contract/tests/evm_spike.rs, contract/tests/common/mod.rs
symptom: "Gas deltas between two wasms moved from run to run (the callback tax read 5.13 Ggas, then 2.85 Ggas), a single-call gas figure was dominated by fixed overhead, and a refactor changed which receipt was being read without any test failing."
root_cause: "The measurements were mixing in things that are not the change: whole-transaction overhead, receipt ordering, random account names that change log sizes, a loop the optimizer could fold, and first-call storage creation."
status: resolved
verified: true
---

# Gas measurement checklist (each item bit us once)

**Measured (sandbox, nearcore 2.14.0):** one EIP-1559 sighash = 0.0233 Tgas; a +2,462-byte wasm adds about
0.0027 Tgas to every call (≈ 1.1 Mgas per added wasm byte), on a `propose_payment` that burns ≈ 3.05 Tgas.

1. **Use the receipt's `gas_burnt`, not `total_gas_burnt`.** The total includes the transaction-to-receipt
   conversion (~0.31 Tgas) and refunds. Take it from `res.receipt_outcomes()`.
2. **Pick the receipt by what it did, not where it sits.** When the contract signs its own call, the refund
   receipt also has `executor_id == contract`. Select the export's receipt by its marker log and
   `propose_payment` / `on_near_settled` by their events (`payment_reserved`, `payment_confirmed`), and assert
   exactly one of each. Positional picks (`own[0]`, `own[1]`) shift silently, and an "identical every round"
   assertion cannot notice because both sides shift together.
3. **Report a slope, not one point.** `per_call = (g(1000) - g(1)) / 999`; the intercept (~1.19 Tgas here) is
   receipt + contract load + argument parsing. Run N in {1, 10, 100, 1000}; slopes over 10..100 and 100..1000
   agreed within 0.5%, which is also the proof the loop was not folded.
4. **Make every loop round a different input.** Under `opt-level = "z"` + LTO a loop of identical inputs can
   be hoisted. Increment the nonce, fold the previous digest into the next input, route inputs through
   `core::hint::black_box`, and return the final digest. A flat gas curve means a folded loop: invalid.
5. **A/B with identical account names.** Events embed account ids and logs are charged per byte, so random
   `dev_create_account` names put name-length noise into the difference being measured (the propose tax varied
   by 1.4 Ggas, the callback tax by 2.3 Ggas between sandboxes). Create fixed sub-accounts of the root
   (`purser.test.near`, `owner.test.near`, ...) in both sandboxes; then the tax is exact and identical every
   round.
6. **Round 0 is not steady state.** The first proposal creates storage entries, so compare round i on one wasm
   with round i on the other, and quote a later round for the steady state.

## The load tax is the real cost of size

Contract-loading gas scales with wasm size and is paid by **every** call to **every** method, not only the new
one. Measure it directly: the same `propose_payment` (and its callback receipt) on the baseline and on the
changed wasm with the new code unused. Storage stake is the minor cost (1 NEAR per 100 KB).

## Also

- The shipped build embeds the ABI (8.4 KB here); build both sides with the same flags or the size delta is
  wrong (see [[byte-identical-wasm-needs-the-feature-mod-declared-last]]).
- `CALLBACK_GAS` (10 Tgas) was budgeted ~2x a canonical floor; the measured callback burns ≈ 2.08 Tgas.
