---
title: "Poller silently lost a commitment: a failed task's id fell below the cursor once a later id of another task was stored"
category: integration-issues
date: 2026-11-05
tags: [indexer, poller, cursor, idempotency, partial-failure, list_commitments, get_commitment, data-integrity, purser]
module: indexer/src/poller.ts (commitment probing + commitment_cursor)
symptom: "Reading the code only (found in review, regression-tested before the fix): after two passes where task B failed (429) while task A kept advancing, B's commitment id was never stored, never in the open set, and the pass later reported 'complete' with a hole in history."
root_cause: "Unwritten ids were collected only when id > storedMax, where storedMax was read before the pass. Ids are global across tasks, so a lower id owned by a failed task stopped counting as soon as a higher id of another task landed, and the cursor jumped past it."
status: resolved
verified: true
---

# A cursor over a global id space needs per-id bookkeeping, not a high-water mark

**One-line:** commitment ids are one sequence for the whole contract (sequential from 0, never deleted),
but the poller writes one task per transaction, so a pass can store id 2 while id 1 (another task) failed.
A high-water mark loses id 1. Track what is unwritten, not what is highest. Fixed in `e709a5e` (PR #8).

## Design this lives in

- `list_commitments(task, from, limit)` rescans the whole ledger on every call (O(ledger x pages)), so
  the poller does not use it. It reads `get_commitment(id)` (O(1)) for `id = cursor ... until null`.
- Terminal states (`Confirmed`, plus `Failed`/`Cancelled` re-checked every 20th pass) are not re-read;
  `Reserved|Signed|Unknown` are re-read by id each pass (`openCommitmentIds`).
- Each task is written in its own transaction at one pinned final block `H`.

## The bug

```
pass 1: task A stores ids 0, 2.   task B (id 1) fails with 429.   cursor = 1
pass 2: probe from 1.             task B fails again.   task A stores id 3.
        storedMax at start = 2  ->  id 1 is not "> storedMax", so it is not counted unwritten
        cursor jumps to 4.     id 1 is not stored, not open, never re-read.
```

## Fix

An id read in the probe range whose task is not done counts as unwritten regardless of what is stored
above it; the cursor never moves past the lowest unwritten id. A null cursor probes from 0. Related
hardening from the same review:

- A throw in `applyTaskSnapshot` or the resolver is caught **per task** (kind `apply_failed`) and the
  pass continues; `MetaMismatchError` / `RepoUnavailableError` / `UnknownBlockError` still propagate.
- `last_pass_at` / `last_complete_height` advance only when every task succeeded; the cursor is
  always written and never beyond an unwritten id.
- The open-set re-read loop honours the pass budget and the AbortSignal.

## Tests (indexer/test/unit/poller.test.ts)

- "never skips a failed task's id when a later id of another task is stored"
- "a throw in the resolver fails only that task and never advances the cursor past it"
- "the open-set re-read stops on abort" / "honours the pass budget"

All four were written to fail first.

## Prevention

- When work is sharded (per task) but the id space is global, model it as a set of pending ids with a
  low-water mark; do not derive progress from `max(stored)`.
- Property-style test: random failure schedule per task over several passes; invariant is that the final
  stored id set equals the chain's id set.
- Never let "pass complete" imply "no holes": completeness is a statement about the id set.

## Related

- `docs/solutions/security-issues/owner-reconcile-contradicted-by-late-settlement-callback.md` (why
  non-terminal and Failed rows must be re-read: a late callback can flip Failed to Confirmed)
- `docs/solutions/integration-issues/near-api-js-7-rate-limited-public-rpc-board-freeze.md` (the 429s
  that make partial passes the normal case on the public RPC)
