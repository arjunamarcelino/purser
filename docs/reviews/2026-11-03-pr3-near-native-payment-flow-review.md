---
title: "Code review — PR #3: NEAR-native payment flow, atomic reserve-before-sign (Prompt 4)"
pr: https://github.com/arjunamarcelino/purser/pull/3
branch: feat/near-native-payment-flow
base: main
commits: [9a58170, 50f751d, a07809c, 0713575]
date: 2026-11-03
reviewers: [security-sentinel, architecture-strategist, data-integrity-guardian, performance-oracle, pattern-recognition-specialist, code-simplicity-reviewer, agent-native-reviewer]
verdict: SHIP — no P1/blocker; invariant holds and is runtime-verified; 3 P2 (should-fix, non-blocking) + P3 polish
status: RESOLVED 2026-11-03 — all 3 P2 + 7 of 13 P3 fixed (10 commits, one per issue); 6 reasoned keep/defer (2 are operator decisions). See Resolution log.
---

# Code review — PR #3 (Prompt 4: NEAR-native payment flow, atomic reserve-before-sign)

**Scope:** `contract/src/{lib,payload,error,events}.rs`, `contract/tests/payments.rs` (+795/−21 across 5 files).
Implements `#[payable] propose_payment -> PromiseOrValue<CommitmentId>` (reserve-before-sign), the
`#[private] on_near_settled` settlement callback, a fail-closed `set_recipient_allowlist`, and the
`get_commitment`/`list_commitments`/`get_idempotency` views, on top of the already-tested pure core.

Seven independent agents reviewed the **implemented diff** (`ca8a78b..HEAD`), not the plan. No code was
changed — this document is advisory.

---

## Verdict

**Shippable. No CRITICAL / P1 findings.** All seven reviewers converged:

- **The core theorem holds.** `completed + outstanding ≤ cap` is preserved on every path; data-integrity
  verified all six accounting checks and found no desync.
- **The load-bearing check passed.** The idempotency key is coherent between `propose_payment`
  `(predecessor, request_id)` and `on_near_settled` `(commitment.delegate, request_id)` — the same value,
  confirmed by code trace **and** the passing runtime assertion in `payments.rs:164-170`. No stuck-Pending,
  no wrong-key replay.
- **Reserve-before-sign is real.** Auth → `request_id` bound → tri-state `classify` → payload +
  deny-by-default allowlist → `try_reserve` → `idempotency = Pending` → event all commit before the first
  `Promise` (the `// ---- NO ASYNC ABOVE THIS LINE ----` boundary). This is NEAR's documented
  withdrawal/reentrancy pattern; the bare `Transfer` executes no recipient code (no reentrancy).
- **Trust boundary airtight.** Every agent-supplied field is validated, allowlisted, namespaced, or
  contract-reconstructed before it can touch state; reserve amount ≡ transfer amount.
- **Verified on a sandbox:** 43 tests pass (32 unit + 8 delegates + 3 payments), `-D warnings` clean, wasm
  builds. Measured ~6 Tgas total burn; `CALLBACK_GAS = 10 Tgas` is right-sized.

The three P2s are non-blocking: two are documentation/test-pinning accuracy, one is the already-documented
callback-starvation residual whose real fix (an owner reconcile entrypoint) is correctly deferred.

---

## Resolution log (applied 2026-11-03)

All 3 P2 and 7 of 13 P3 fixed (10 commits, one per issue; clean conventional messages, no AI trail).
Six findings are reasoned keep/defer (P3-5 and P3-16 are explicit operator decisions). Final state:
fmt clean, `clippy -D warnings` clean, wasm builds (240.5 KB), **47 tests pass** (33 lib + 8 delegates
+ 6 payments), 0 failures.

| # | Sev | Outcome | Commit | Note |
|---|-----|---------|--------|------|
| 1 | P2 | ✅ Fixed | `59feaa6` | `idempotency.rs` + `types.rs` banners now name the `(AccountId, RequestId)` key. |
| 2 | P2 | ✅ Fixed | `252d8a1` | Added `error::tests::msg_constants_are_frozen` pinning every `MSG_*` literal's value; reworded the overstated comment to a Prompt-6 forward reference. |
| 3 | P2 | ✅ Fixed | `bcf60d7` | New owner-only `reconcile(cid, confirmed)` closes the stuck-`Reserved` gap: owner-attested force-confirm (`Reserved→Signed→Confirmed`) or safe-release (`Reserved→Failed`), `PaymentReconciled` event, 3 reject tests. Honors Rule 4 (owner attestation = proof). |
| 4 | P3 | ✅ Fixed | `3b0aaa1` | Trimmed the `StorageKey` + struct banners (~30→~16 lines); kept the 4 load-bearing inline safety notes and the Prompt-5/12 seam markers. |
| 5 | P3 | 🚫 Won't-fix | — | **Operator decision: keep `list_commitments`** (full-scope; feeds the dashboard/indexer). Implemented exactly as documented (O(total-ledger), scan-ceiling noted, `TaskCommitments` reserved). |
| 6 | P3 | ✅ Fixed | `caa75dd` | `MSG_INVALID_MEMO`→`MSG_MEMO_TOO_LONG` / `"memo too long"` — restores the 1:1 variant↔constant↔message correspondence. |
| 7 | P3 | 🚫 Won't-fix | — | Keep `PaymentReserved.delegate` (not `account_id`): role-specific naming is clearer alongside `recipient` in a payment event; the delegate-lifecycle events' `account_id` is unambiguous because they carry only one account. Deliberate, documented. |
| 8 | P3 | ✅ Fixed | `05e921f` | `budget.rs` `authorize` doc: `on_signed`→`on_near_settled` (+ owner `reconcile`). |
| 9 | P3 | ✅ Fixed | `2c17cdb` | `RequestId` doc notes it must be globally unique per delegate (keyed `(predecessor, request_id)`). |
| 10 | P3 | ⏭️ Deferred | — | `request_id→cid` O(1) only for `Committed`: enriching `IdemState::{Pending,Failed}` with the cid is speculative core/Borsh churn with no consumer yet; the recovery loop is already functional (terminal classification is O(1)). Revisit when the TS proposer needs non-`Committed` cid lookup. |
| 11 | P3 | ✅ Fixed | `55c24ac` | `assert_invariant` backstop at the tail of `open_reservation` + `on_near_settled` (fulfils `budget.rs`'s documented live-backstop intent; matches `create_task`). |
| 12 | P3 | ✅ Fixed | `20423ec` | `PaymentReserved` emits the parsed `payload.recipient` (exact transfer target). |
| 13 | P3 | ✅ Fixed | `efb9c1e` | `propose_payment`'s `task` arg length-bounded (mirrors `create_task`). |
| 14 | P3 | 🚫 Won't-fix | — | Keep `assert_delegate_authorized` as `pub(crate)`: it is the shared auth-predicate gate; narrowing to private is cosmetic and `pub(crate)` causes no issue. |
| 15 | P3 | ⏭️ Deferred | — | `PaymentFailed.reason` kept as an inline literal: a single free-form event-data string does not warrant a dedicated const (the simplicity bar argues against const-for-one-literal); revisit if more settlement-failure reasons appear. |
| 16 | P3 | 🚫 Won't-fix | — | **Operator decision: keep `StorageKey::DelegateIndex` reserved** — dropping it re-numbers later prefixes and contradicts the append-only "lock the order up front" discipline; already `#[allow(dead_code)]`. |

**Tally:** 3/3 P2 fixed; 7/13 P3 fixed (#4, #6, #8, #9, #11, #12, #13); 6/13 P3 reasoned keep/defer
(#5, #7, #10, #14, #15, #16 — #5 and #16 by operator decision).

---

## Findings

| # | Sev | Finding | Location | Raised by |
|---|-----|---------|----------|-----------|
| 1 | 🟡 P2 | Stale core docs: still say idempotency is "keyed by `RequestId`" / `LookupMap<RequestId, IdemState>` after the key became `(AccountId, RequestId)` — drift in the modules that document the store (SSOT convention) | `idempotency.rs:3-7`, `types.rs:137` | architecture, performance, pattern |
| 2 | 🟡 P2 | "Frozen cross-service wire contract" overstated: `error.rs` comment says the attack suite asserts the new `MSG_*`, but only `MSG_EXCEEDS_BUDGET` + `MSG_RECIPIENT_NOT_ALLOWED` are pinned by a committed test (~10 of ~12 unasserted; no in-repo consumer yet) | `error.rs:26-28`; `tests/payments.rs` | pattern, agent-native |
| 3 | 🟡 P2 | Callback-starvation residual: if `on_near_settled` is gas-starved/panics **after** a successful transfer, the commitment is stuck `Reserved` + idempotency stuck `Pending` forever (budget locked; retry panics `in-flight`; `mark_unknown`/`cancel` cores exist but are unwired). Invariant still holds (conservative). Documented + deferred to a future owner reconcile entrypoint | `lib.rs:411-413` | data-integrity, security, performance, agent-native |
| 4 | 🔵 P3 | Comment ceremony: ~70–90 lines of roadmap/append-only narration (keep the 4 load-bearing notes: NO-ASYNC, two-disjoint-borrow, NEP-297 emit-ordering, `near_tx`-None) | `lib.rs:62-78, 92-106`, scattered Prompt-N refs | simplicity |
| 5 | 🔵 P3 | `list_commitments` has zero consumers (no frontend, no test) — YAGNI; O(total-ledger) scan. **Advisory only** — conflicts with the operator "full scope (events+views)" decision; it feeds the planned dashboard/indexer | `lib.rs:606-625` | simplicity |
| 6 | 🔵 P3 | Naming mismatch: `MemoTooLong` variant → `MSG_INVALID_MEMO` / `"invalid memo"` breaks the 1:1 variant↔constant↔message pattern the other payload errors keep | `error.rs:32, 93, 107` | pattern |
| 7 | 🔵 P3 | Cross-event field naming: `PaymentReserved.delegate` vs `DelegateAdded/Revoked.account_id` for the same entity (frozen indexer contract — decide deliberately) | `events.rs:47` vs `:31, :38` | pattern |
| 8 | 🔵 P3 | Stale doc: `authorize`'s comment references an `on_signed` callback that doesn't exist; the shipped callback is `on_near_settled` | `budget.rs:127-128` | pattern, architecture |
| 9 | 🔵 P3 | `request_id` is per-caller-global, not per-task: one delegate reusing a `request_id` across two tasks skips/blocks the second (fail-safe; no double-spend). Worth a one-line "globally unique per delegate" doc note | `lib.rs:342`, `types.rs:19` | security |
| 10 | 🔵 P3 | `request_id → commitment_id` is O(1) only for `Committed` (`Pending`/`Failed` are unit variants); non-`Committed` recovery by request_id falls back to the O(ledger) `list_commitments` scan | `types.rs:144`; `lib.rs:612` | agent-native |
| 11 | 🔵 P3 | `assert_invariant` not called as a live tail backstop on the payment paths (it is on `create_task`); invariant preserved by construction, so defense-in-depth consistency only | `lib.rs` payment paths vs `:177` | security |
| 12 | 🔵 P3 | `PaymentReserved` emits the raw `intent.recipient` string, not the parsed `payload.recipient` (harmless — `AccountId` parse is validating-only, no normalization) | `lib.rs:378` | architecture |
| 13 | 🔵 P3 | `propose_payment`'s `task` arg is not length-bounded (unlike `task_id`/`request_id`/`memo`); fails closed via auth, only wastes the caller's own gas | `lib.rs:324-333` | security |
| 14 | 🔵 P3 | `assert_delegate_authorized` is `pub(crate)` though its only caller is in the same impl → could be private | `lib.rs:478` | architecture |
| 15 | 🔵 P3 | `PaymentFailed.reason` is a hardcoded `"transfer failed"` literal, present only in the event (not on the `Commitment`) | `lib.rs:467`, `events.rs:69` | pattern, agent-native |
| 16 | 🔵 P3 | `StorageKey::DelegateIndex` is genuinely dead (superseded, not merely reserved); droppable pre-stateful-deploy while the layout is unfrozen | `lib.rs:85` | simplicity |
| — | ⚪ note | Double `self.tasks` lookup (`get` for token, then `get_mut`) and the callback's `get`→`get_mut` are **cache hits** under `near_sdk::store` (one trie read), and the bounded key clones are gas-noise — **do not restructure** | `lib.rs:351/513`, `:425/437` | performance |

---

## Detail & recommendations (no changes applied — advisory only)

### 🟡 P2-1 — Stale idempotency-key docs (SSOT drift)
The PR correctly changed the store key to `(AccountId, RequestId)` and flagged it on the `Purser` struct
(`lib.rs:101-106, 113-114`), but the module that *documents* the store — `idempotency.rs:3-7` — and the
`IdemState` type doc (`types.rs:137`) still describe `LookupMap<RequestId, IdemState>` / "keyed by
`RequestId`." In a codebase that treats module banners as load-bearing single-source-of-truth, update
those two lines to name the composite key. Doc-only; no behavior change.

### 🟡 P2-2 — `MSG_*` "frozen wire contract" is asserted by comment, not test
`error.rs:26-28` states (present tense) that the near-workspaces suite asserts the new payload constants.
It doesn't yet: `payments.rs` pins only `MSG_EXCEEDS_BUDGET` and `MSG_RECIPIENT_NOT_ALLOWED`; the other
~10 (`MSG_IN_FLIGHT`, `MSG_ALREADY_FAILED`, `MSG_INVALID_REQUEST_ID`, `MSG_UNSUPPORTED_*`,
`MSG_INVALID_RECIPIENT`, `MSG_INVALID_MEMO`, …) have no committed assertion and there is no in-repo
consumer (`proposer/` is a README stub). The deferral of the in-flight/replay/revoke suite to Prompt 6 is
fine; the overstatement is the issue. **Two low-cost options:** (a) soften the comment to a forward
reference ("will be asserted by the Prompt-6 attack suite"), matching the honest `TODO(Prompt 5)` style
elsewhere; and/or (b) add a trivial table test asserting each `MSG_*` literal value, so a reword fails CI
before the TS proposer lands. (b) makes the "do not reword" guarantee real now.

### 🟡 P2-3 — Callback-starvation residual (documented, deferred-by-design)
The single real liveness hole, cited by four reviewers and already documented at `lib.rs:411-413`. If
`on_near_settled` runs out of its 10 Tgas or panics **after** the transfer receipt applied, the callback's
state changes revert but the funds are gone → commitment stuck `Reserved`, idempotency stuck `Pending`,
`outstanding` locked. There is **no agent- or owner-reachable escape** in this PR: a retry of the same
`request_id` panics `in-flight` forever, and the `mark_unknown`/`cancel` cores (`budget.rs:205-217`) are
not wired to any entrypoint. A client that wrongly treats the stuck request as failed and re-pays with a
*new* `request_id` double-pays the recipient (the contract's invariant is not violated — the first amount
stays conservatively in `outstanding`). **Why P2, not P1:** the accounting invariant holds, native
transfers make over-run rare (binary same-tx callback, 2× gas headroom, bounded inputs), and it is an
explicitly accepted deferral. **Recommendation:** keep as the top item for the follow-up prompt — add an
owner `reconcile(cid)` that force-advances a stuck `Reserved` to `Confirmed` on proof (or safe-releases),
and add a callback-gas-starvation case to the Prompt-6 matrix.

### 🔵 P3 cluster — polish (batch into a single cleanup pass if desired)
- **Docs/comments:** trim the `StorageKey`/struct-banner essays (F4), fix the `on_signed`→`on_near_settled`
  reference (F8), add the "`request_id` globally-unique per delegate" note (F9). All doc-only.
- **Naming:** `MemoTooLong`↔`MSG_INVALID_MEMO` (F6) and `PaymentReserved.delegate`↔`account_id` (F7) — pick
  the 1:1 form; F7 touches the frozen event contract so decide before any indexer consumes it.
- **Minor code:** `assert_delegate_authorized` → private (F14); emit parsed `payload.recipient` in
  `PaymentReserved` for consistency (F12); consider a bound on the `task` arg (F13); optionally call
  `assert_invariant` at the tail of the payment paths for defense-in-depth parity with `create_task` (F11);
  drop the dead `DelegateIndex` variant while the layout is unfrozen (F16).
- **Scope (advisory):** `list_commitments` (F5) has no caller yet — the operator chose "full scope" to feed
  the dashboard/indexer, so this is a keep-or-defer judgment, not a defect. If kept, it is implemented
  exactly as documented (O(total-ledger), scan-ceiling noted, `TaskCommitments` index reserved).
- **Agent-ergonomics:** `request_id→cid` is O(1) only for `Committed` (F10) and `PaymentFailed.reason` is a
  fixed string (F15) — both minor; revisit if the autonomous proposer needs richer recovery.

### ⚪ Explicitly confirmed implemented-as-documented (not findings)
Storage-deposit guard **deferred** (`#[payable]`, no deposit required) — matches the accepted P-11 risk
decision, not worse. `request_id`/`memo` **length-bounded** and correctly ordered (bound before key
construction). `list_commitments` O(total) with `TaskCommitments` reserved — as documented. `payload_hash`
threaded `None` for a zero-churn Prompt 5. The "double lookup" is a `store` cache hit — a non-issue.

---

## Stakeholder / scenario notes

- **Developer:** APIs intuitive; `.expect("why")` discipline and pure-core reuse make it easy to follow.
  The two-disjoint-borrow callback is the one subtle spot — its guard comment is load-bearing, keep it.
- **Operations:** Fund the contract above **Σ task caps + storage reserve** (shared balance; caps are
  per-task) per the plan's corrected note; watch slow storage-staking growth (unpruned commitments +
  idempotency entries) until the NEP-145 guard lands.
- **Security:** attack surface is small and fail-closed (deny-by-default recipient, namespaced idempotency,
  `#[private]` callback, no blind-sign, no reentrancy, no state leak in panics).
- **Scenarios covered by tests:** happy path, over-budget refusal, non-allowlisted refusal. **Deferred to
  Prompt 6:** genuine concurrency (⌊R/a⌋), in-flight retry, replay, revoke-block, timeout, callback
  starvation (F3).

---

## Next steps (not performed — review-doc-first per request)
1. **No P1 → not merge-blocked.** The three P2s are should-fix but non-blocking.
2. Cheapest high-value follow-ups: P2-1 (doc fix) + P2-2 (MSG_* table test or comment softening) — both tiny.
3. Track P2-3 (reconcile entrypoint) as the headline item for the next prompt; it is the only real
   functional gap and is deferred by design.
4. P3s are a single optional cleanup pass; none affect correctness or the DONE-WHEN.
