---
title: "A minimum payment does not bound state growth: cap the commitments EVER created, in a separate map, so no migration"
category: security-issues
date: 2026-11-06
tags: [S8, storage-staking, griefing, state-growth, borsh, upgrade, migration, near-sdk, payable, purser]
module: contract/src/lib.rs, contract/src/types.rs, contract/tests/limits.rs, contract/tests/upgrade.rs
symptom: "TRD S8 (a caller must not be able to grief contract state) was reviewed as 'input lengths are bounded, fine'. In fact a registered delegate could loop 1-yocto payments, or payments whose transfer fails, and grow commitment + idempotency state without limit, paid from the contract's balance."
root_cause: "Commitments and their idempotency entries are never pruned. A failed transfer moves a commitment to Failed and releases its BUDGET, but the entries stay, so a failing-transfer loop grows state with zero budget consumption. There was no minimum amount (only 0 was refused) and no per-task commitment count. propose_payment was also #[payable] with the deposit never read, so a stray deposit was silently kept."
status: resolved
verified: true
---

# Bound what can be CREATED, not what is outstanding

**Measured exposure before the fix:** one admitted proposal adds **375 bytes** (commitment + idempotency entry),
about **0.00375 NEAR** of storage stake (1e19 yocto per byte), taken from the contract's own balance. Rejected
calls panic and roll back, so only admitted ones grow state.

## Why the obvious fixes fall short

- **Minimum payment alone:** does nothing for the failing-transfer loop (an allowlisted account that was deleted
  makes every transfer fail; budget is released each time; entries accumulate).
- **Counting outstanding commitments:** decrements on Failed, so it is bypassed by the same loop.
- **Attached storage deposit per proposal:** strongest, but changes every proposer and demo call.

## Fix

A per-task `created_count` that **never decrements**, checked against `max_commitments` inside `open_reservation`
before any write (one site covers the NEAR and EVM paths; a refusal persists nothing). An optional owner-set
`min_payment` for NEAR tasks. `propose_payment` is no longer `#[payable]`, so the runtime rejects a deposit.

```rust
// lib.rs: built on demand, never a struct field
fn limits_map() -> LookupMap<TaskId, TaskLimits> { LookupMap::new(StorageKey::TaskLimits) }
// open_reservation, before any state write:
require!(task_limits.created_count < task_limits.max_commitments, MSG_COMMITMENT_LIMIT);
```

## The part that avoided a migration

Adding a field to `TaskBudget` or `Purser` breaks Borsh deserialization of every existing task and of the contract
state, so the deployed contract would need `#[init(ignore_state)] migrate` or a fresh account. Instead:

- **append** `StorageKey::TaskLimits` (appending is Borsh-safe: the variant only picks a key prefix);
- construct the `LookupMap` inline; `LookupMap::new` reads nothing, so the struct layout is unchanged;
- a task with no stored entry uses baked-in defaults (no minimum, 1000 commitments).

Proof is a test, not an argument: `contract/tests/upgrade.rs` deploys the PREVIOUS release's wasm, creates a task and
a commitment, deploys the new wasm over it with no migration, and checks reads, idempotent replay and new traffic
(`make upgrade-check` builds the previous release in a worktree and runs it). Known scope: history written before the
upgrade is not counted toward `created_count`.

## Residuals (disclosed in the README, not fixed)

- Growth is bounded per task, not zero; the owner can raise the limit.
- One delegate can burn a task's slots and block its crew until the owner raises the limit (`max_commitments = 0`
  is the intended way to pause a task).
- `min_payment` does not apply to EVM tasks (wei; they have `min_value`).
- `set_relayer` scans every commitment, so bloat can still push it past the gas limit (todo 043).

## Prevention

- When reviewing "state-growth" requirements, ask what is never deleted, then count creations.
- Run the audit's refusal-coverage meta-test so a new refusal string (`payment below minimum`, `task commitment limit
  reached`) cannot ship untested.
