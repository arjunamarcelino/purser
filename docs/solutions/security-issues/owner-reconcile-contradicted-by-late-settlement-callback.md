---
title: "Owner reconcile raced / contradicted by a late settlement callback: make the callback total and freeze on over-cap"
category: security-issues
date: 2026-11-05
tags: [near-sdk, 5.30, reconcile, settlement-callback, receipt-latency, delayed-receipts, double-spend, invariant, state-machine, idempotency, replay, property-testing, money-flow-oracle, purser]
module: contract payment flow (on_near_settled / reconcile / propose_payment replay) + Layer-B property test
symptom: "Money leaves the contract but the books show it released: an owner reconcile(cid, false) on a still-Reserved commitment frees its headroom, the transfer then lands, and the settlement callback panics on the illegal Failed edge and rolls back — completed never counts the spend and the cap headroom is spendable twice. Separately, a retry with the same request_id but a different task/amount/recipient got the OLD cid back as success."
root_cause: "Two wrong assumptions: (1) 'a Reserved commitment that outlives its proposal is a lost callback' — false, NEAR does not bound receipt latency, so the callback can still be in flight minutes later; a time-lock only narrows the window. (2) Idempotency keyed by (predecessor, request_id) treated 'same key' as 'same request' without comparing the request."
status: resolved
verified: true
---

# Owner reconcile contradicted by a late settlement callback (and replay-of-a-different-request)

**One-line:** an owner attestation is not proof; the settlement callback is. Make the callback
**total** over every state a reconcile can leave, record what the chain proves, and freeze the task
if that breaks the cap. Shipped in PR #5 (`938d80c`, `e779aab`, `20fd24e`, `22feeb4`).

## Symptom (found by the contract-level property test, not by inspection)

Layer B (real `Purser` under the mocked VM) shrank each to 2–3 steps:

```
D1: Propose{r0} → Reconcile{cid 0, confirmed: false}      // contract accepted while callback still live
D2: Propose{req-3 → merchant} → Deliver(ok) → Propose{req-3 → removable}   // returned Value(0): false success
```

Then three reviewers independently found the deeper residual of the first fix: a **10-minute
time-lock** on `reconcile` is still a heuristic — under congestion a transfer receipt can sit in a
delayed-receipt queue longer than any constant, so `reconcile(false)` at T+601 s can still be
contradicted by a callback that lands later.

## What did NOT work

- **"A persisting Reserved = lost callback" (original code comment).** False for ~2 blocks after every
  proposal, and unbounded under congestion.
- **Time-lock only (first fix).** Closes the common race (same block / seconds), not the delayed one.
  The property test missed it because its model marked every callback older than 5 s as lost forever
  and imported the contract's own lock constant — model and SUT shared the assumption under test.
- **Making the late callback "fix" the books by releasing/re-reserving.** Impossible to do without
  breaking invariant (I): the released headroom may already be re-spent.

## Solution

### 1. The callback is total (lib.rs `on_near_settled`)

| Commitment state | Callback | Action |
|---|---|---|
| `Reserved` | `Ok` / `Err` | settle → `Confirmed` / release → `Failed` (unchanged) |
| `Confirmed` | `Ok` | agreement — no-op |
| `Failed` | `Err` | agreement — no-op |
| `Failed` | `Ok` | **contradiction**: new edge `Failed → Confirmed` (`Event::Contradict`, `record_contradicted_spend`): `completed += spent`, idem → `Committed`, emit `reconcile_contradicted`; if `completed + outstanding > cap` set `TaskBudget.frozen` |
| `Confirmed` | `Err` | over-count (safe direction) — keep, emit `reconcile_contradicted` |

`propose_payment` refuses a frozen task (`"task frozen"`). Invariant (I) is asserted only for
non-frozen tasks (`assert_invariant_unless_frozen`); a frozen task authorizes nothing and can only
arise from a wrong owner attestation. The time-lock (`RECONCILE_MIN_AGE_NS`, exposed via
`get_config()`) stays as defense-in-depth. **Borsh:** `frozen` is appended to `TaskBudget`
(free only because nothing was stateful-deployed yet).

### 2. Replays must be the SAME request (payload.rs `same_request`)

On a `Committed` hit, load the commitment and require `prior.task == task && same_request(prior.intent, intent)`
else `"request_id reused with a different request"`. Compare canonically (parsed `AccountId`,
empty memo == none, exact chain/token/amount) so an honest re-serialized retry is not refused; the
`Chain::Evm` arm is the seam for address-checksum normalization.

### 3. The property test can now see it

- Callbacks deliverable at **any** delay (no "lost after 5 s"); owner may attest on silence.
- Lock value stated **independently** in the model (`SPEC_RECONCILE_MIN_AGE_NS`), asserted equal.
- **Money-flow oracle**: value whose transfer executed ≤ `completed + outstanding` + (wrong releases
  still awaiting their contradicting callback) — per task **and** per commitment (an aggregate can be
  masked by an opposite error).

## Prevention

- Treat every owner/relayer attestation as a hint the chain may overrule; never let an attestation
  be the last word on money.
- Any callback that can run after a human/off-chain action must be total over all reachable states;
  a panic in a callback is "rollback the books, keep the money gone".
- Never let a test model import the constant/logic under test; state the spec value and assert equality.
- Every oracle must read something the SUT can't fake (actual outflow, not the contract's own fields).
- After writing a property, **plant the bug** and confirm it goes red — and *read the result before
  committing*: one plant here (memo-blind replay) was not caught because the generator could not
  produce a memo-only difference.

## Related

- `docs/solutions/integration-issues/near-sandbox-race-proof-and-mocked-vm-harness.md` (the harness)
- `docs/reviews/2026-11-05-pr5-security-proof-suite-review.md` (P1-1, P2-2/3/4)
- `docs/PURSER-TECHNICAL.md` §4 (state machine, contradiction edge)
