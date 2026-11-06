---
title: Code review — PR #1 budget accounting core & reservation state machine
date: 2026-11-03
pr: https://github.com/arjunamarcelino/purser/pull/1
branch: feat/budget-accounting-core
base: main
reviewers: [security-sentinel, data-integrity-guardian, architecture-strategist, code-simplicity-reviewer, performance-oracle, pattern-recognition-specialist]
verdict: APPROVE (no P1 / no merge-blockers)
status: resolved (2026-11-03 — all P2/P3 fixed or decided; P4/P6 tracked as carry-forward)
---

# Code review — PR #1 (Prompt 2: budget accounting core)

> **Scope:** the six contract source files in the PR —
> `contract/src/{types,error,reservation,budget,idempotency,lib}.rs` (+1196 / −9).
> Six specialist agents reviewed the **implementation** (not the plan) in parallel.
> **Per request, nothing was fixed and no todo files were created — this document is the
> sole deliverable.**

## Resolutions (applied 2026-11-03)

All findings have been actioned on branch `feat/budget-accounting-core`: P2/P3 code & doc items
fixed (one commit each, authored by the repo owner, no AI trail); the two P2 carried risks and all
P4/P6 items tracked as carry-forward in
`docs/plans/2026-11-02-feat-budget-accounting-core-plan.md`.

| Finding | Resolution | Commit |
|---|---|---|
| P2-1 TaskBudget import | ✅ Fixed | `2f1f702` |
| P2-2 D-2 pairing | 📌 Deferred → Prompt 4 (boundary `require!`); tracked in plan | — |
| P2-3 D-1 `Reserved` dual-meaning | 📌 Deferred → Prompt 4 (protocol invariant); tracked in plan | — |
| P3-1 `NearToken::ZERO` | ✅ Fixed | `1735885` |
| P3-2 unreachable branches documented | ✅ Fixed (comments; guards kept) | `d3da170` |
| P3-3 `PurserError` derive order | ✅ Fixed | `5270d5e` |
| P3-4 `Copy` on `Chain`/`IdemState` | ✅ Fixed | `5ce69fa` |
| P3-5 explicit type re-exports | ✅ Fixed | `5c97b3b` |
| P3-6 `release_outstanding` helper | ✅ Fixed | `4ff8a3c` |
| P3-7 `transition`/`Event` visibility | 🔵 Kept `pub` by decision — the Prompt-6 `tests/` crate needs cross-crate access (integration tests can't see `pub(crate)`) | — |
| P3-8 trim typestate comment | ✅ Fixed | `e1f23b5` |
| P3-9 `idempotency.rs` YAGNI | 🔵 Kept by decision — the Prompt-2 spec names the module; `IdemState` type must stay in `types.rs` (frozen layout). Test is classification-only by design | — |
| P3-10 `commitments` `IterableMap` | 🔵 Kept `IterableMap` per BACKEND-SCHEMA §1.1 (schema-faithful); revisit at Prompt 4 — tracked | — |
| P3-11 §1.1 field-order doc drift | ✅ Fixed (schema note) | `<schema>` |
| P4 ×7 + P6 ×3 obligations | 📌 Tracked → Prompt 4/6 checklist in the plan carry-forward | `<plan>` |

Legend: ✅ fixed in code/docs · 🔵 kept by recorded decision · 📌 deferred to a later prompt (tracked).
(`<schema>`/`<plan>` = the `docs(schema)` and `docs(plan)` commits on this branch.)

---

## Verdict

**APPROVE — no P1, no merge-blockers.** All six reviewers independently judged the pure
accounting core **sound**: the safety invariant (I) `completed + outstanding ≤ cap` is
preserved by construction across all five operations; `reservation::transition` permits
**exactly** the six legal edges (locked by an exhaustive 6×5 table test); all `NearToken`
math is `checked_*`-only with compute-then-commit (a rejected op leaves state byte-for-byte
unchanged); and the `TestLedger` oracle independently recomputes the aggregates from the
ledger after every operation. 26 tests pass; `fmt`/`clippy -D warnings`/`cargo near build`
are green.

The findings below are **P2 consistency**, **P3 polish**, and — most importantly — a set of
**P4 carry-forward obligations**: two correctness-critical checks that the schema-verbatim
design (decisions D-1/D-2) deliberately pushes to the Prompt-4 boundary. They are *not*
defects in this PR, but they are load-bearing and must not be lost.

## Severity summary

| Sev | Count | Nature |
|---|---|---|
| 🔴 P1 | **0** | — |
| 🟡 P2 | 3 | 1 code-consistency fix in this PR; 2 accepted carried risks to enforce in P4 |
| 🔵 P3 | 10 | Idiomatic polish, cosmetics, and "decide before P4" notes |
| 📌 P4 carry-forward | 8 | Obligations the later prompts must honor (tracked, not fixable here) |

---

## 🟡 P2 findings

### P2-1 — `TaskBudget` import inconsistency in `budget.rs` *(fixable in this PR)*
*Flagged by: code-simplicity, pattern-recognition.*
`budget.rs:26` imports six sibling types from `crate::types` but omits `TaskBudget`, which is
then written fully-qualified as `crate::types::TaskBudget` at `budget.rs:35, 55, 120, 156, 189`
— while the test module imports it normally (`budget.rs:203`). Every other module uses the
imported style uniformly. **Fix:** add `TaskBudget` to the line-26 import and drop the five
`crate::types::` prefixes. Pure readability; no behavior change. *(Small.)*

### P2-2 — D-2 pairing is structurally unprovable in the core *(accepted carried risk → P4)*
*Flagged by: security-sentinel, architecture-strategist, data-integrity-guardian.*
`settle_confirmed`/`release_failed`/`cancel` take `&mut TaskBudget` and `&mut Commitment` as
separate args; nothing proves the commitment belongs to the budget, and `TaskBudget` carries
no task-id. A mis-paired settle where the wrong budget holds ≥ `reserved_amount` outstanding
would **silently** subtract (the `checked_sub` only catches an *underflowing* mispair) →
aggregate↔ledger desync → later over-admit → **overspend**. This is the one overspend path the
`TestLedger` recompute cannot catch (tests always pair correctly by construction). This PR
correctly makes **no** in-core claim (no `Mispaired` variant, **no `debug_assert!` anywhere** —
grep-clean). **Obligation:** P4 must enforce a **release-surviving** `require!(commitment.task
== task_id, …)` at the boundary — never `debug_assert!` (stripped from the `cargo near build`
wasm). Add a P6 mis-pairing attack case. *(Decision D-2, schema-verbatim — see the plan.)*

### P2-3 — D-1 `release_failed` releases any `Reserved` *(accepted carried risk → P4)*
*Flagged by: security-sentinel, architecture-strategist.*
`release_failed` will zero the hold on *any* `Reserved` commitment. The core cannot distinguish
"never dispatched" from "signing promise dispatched, callback lost" — both are `Reserved`. If P4
ever releases the latter, a signature may already have escaped → real spend exceeds cap while
stored aggregates still satisfy (I). The code is correct for the schema-verbatim decision, but
offers **zero structural protection**. **Obligation:** P4 fires `Event::Fail` **only** from (a)
a synchronous pre-promise rejection or (b) a signing-failure callback proving no signature —
never on timeout/owner action against a dispatched reservation. Add a P6 "dispatched-then-silent
`Reserved` is NOT released" case. *(Decision D-1, schema-verbatim.)*

---

## 🔵 P3 findings (polish / decide-before-P4)

Idiomatic / cosmetic (fixable in this PR, low value):
- **P3-1** Use `NearToken::ZERO` instead of `NearToken::from_yoctonear(0)` (`budget.rs:78` + test fixtures). `ZERO`/`MAX` consts exist in `near-token 0.3.6`. *(simplicity, pattern)*
- **P3-2** Unreachable defensive branches: the commit-side `checked_add` at `budget.rs:85-88` and the `unwrap_or(ZERO)` at `budget.rs:78` cannot fire given the preceding checks. Safe to keep as defense-in-depth; if you prefer the code to *document* impossibility, use `.expect("… by invariant (I)")`. *(simplicity, performance, data-integrity)*
- **P3-3** `PurserError` derives `#[derive(Debug, PartialEq, Eq)]` with `Debug` first; every other type lists `Debug` last. Cosmetic ordering. *(pattern)*
- **P3-4** `Chain` and `IdemState` are `Copy`-eligible (u64-only payloads) but not `Copy`, breaking the `ReservationState` precedent (and `IdemDecision`, which *is* `Copy`, mirrors `IdemState::Committed`). Either add `Copy` for symmetry, or add a one-line "deliberately not `Copy`" note. *(pattern)*
- **P3-5** `pub use types::*;` (`lib.rs:17`) is the one glob re-export among otherwise explicit symbol lists. Arguably justified (types = public vocabulary); minor asymmetry. *(pattern)*
- **P3-6** `release_failed` / `cancel` share a near-identical "release outstanding → terminal state" body; an optional `release_outstanding(b, c, event, now)` helper could unify them. Keeping them separate (distinct events + idempotency semantics) is also defensible. *(pattern)*
- **P3-7** `transition` and `Event` are re-exported at the crate root (`lib.rs:16`); `budget.rs` reaches `transition` via `crate::reservation`, not the re-export. Could be `pub(crate)` unless the P6 `tests/` crate asserts on them directly. Low-risk either way. *(architecture)*
- **P3-8** Trim the typestate-justification essay comment (`reservation.rs:15-19`) to a sentence. *(simplicity)*
- **P3-9** The `classify` test (`idempotency.rs:52`) is near-tautological, and `idempotency.rs` (classify/`IdemDecision`) is arguably YAGNI for Prompt 2 — its only consumer is the Prompt-4 store wiring, and the real in-flight race is a Prompt-6 concern. **Keep** (the prompt spec names the module; the `IdemState` *type* must stay in `types.rs` for the frozen layout), but treat the test as classification-only, not invariant coverage. *(simplicity)*

Decide before Prompt 4:
- **P3-10** `commitments` as `IterableMap` adds a per-insert key-index write on the hottest path (`propose_payment`). If no view truly enumerates *all* commitments globally (vs. per-task via `task_commitments`), a `LookupMap` is cheaper; if such a view exists, plan it as bounded/paginated to avoid unbounded-gas reads as the ledger grows. *(performance)*
- **P3-11 (doc drift — new)** BACKEND-SCHEMA §1.1 documents the *final* `Purser` field order with the deferred fields **interleaved in the middle** (`owner, tasks, delegates, delegate_index, allowlist, commitments, task_commitments, idempotency, next_commitment_id, signer_id`), but `lib.rs:56-60` instructs P3/P4 to **append at the end**. These are mutually inconsistent. **No migration hazard while nothing is stateful-init'd before P4** (CI builds-but-doesn't-deploy), but off-chain tooling that trusts §1.1 order — notably the `packages/types` ABI→TS bindings — could be miswritten. **Reconcile the §1.1 doc to "append-only at end" (or re-order the struct to match §1.1) before the first stateful deploy and before generating bindings.** *(data-integrity)*

---

## 📌 P4 (and P6) carry-forward obligations

> **Resolution:** all items below are **tracked as a checklist** in
> `docs/plans/2026-11-02-feat-budget-accounting-core-plan.md` → "PR #1 review — tracked P4/P6
> obligations". They are deferred by design (Prompt-4 entrypoints / Prompt-6 suites do not exist
> yet) and are **not** implemented in PR #1.

These are tracked so the later prompts honor what this PR's core guarantees (or deliberately defers):

1. **Pairing `require!`** (P2-2) — release-surviving `require!(commitment.task == task_id)` at every settle/release/cancel entrypoint; **never `debug_assert!`**.
2. **`Event::Fail` protocol** (P2-3) — only pre-dispatch or proven-no-signature; never on silence.
3. **Panic via `Display`, never `Debug`** — `PurserError` derives `Debug`, which *carries* the numeric amounts (`remaining`/`spent`/`reserved`). `Display` omits them to avoid leaking budget headroom into on-chain receipts. P4 must panic via `env::panic_str(&e.to_string())` (or `#[handle_result]`+`FunctionError`, which uses `Display`) — **never** `{:?}`. *(security)*
4. **Atomic dual-write** — P4 must mutate `TaskBudget` and `Commitment` in one call via in-place `get_mut` handles (not load-clone-mutate-forget-to-reinsert), with no fallible step / early `return Ok` between the `outstanding` mutation and the commitment/idempotency inserts. *(data-integrity, architecture)*
5. **Live `assert_invariant`** — call it at the tail of every mutating entrypoint as a cheap production backstop (panic → rollback). It only checks aggregates, so it is *not* the mis-pairing backstop — the `require!` is. *(security, architecture)*
6. **`next_commitment_id`** — bump-then-insert within the atomic reserve; `commitments.insert` should assert-absent (panic on collision). Atomic rollback makes gaps (harmless) the only failure mode, never reuse. *(data-integrity)*
7. **Storage-grief** — `ZeroAmount` rejection is necessary but not sufficient; add `#[payable]` storage staking + a per-task commitment-count cap, and enforce `crew_cap` (stored but unenforced in this PR). *(security, performance)*
8. **P6 coverage** — add the mis-pairing attack case (P2-2), the dispatched-then-silent `Reserved` case (P2-3), and the genuine in-flight idempotency race (same-block `near-workspaces`).

---

## What's confirmed sound (no action)

- **Invariant (I)** preserved by all five ops; `settle_confirmed` correctly releases the over-reservation (net Δ ≤ 0). *(data-integrity walked each op.)*
- **State machine** permits exactly 6 edges; `Signed→Failed`, `(Unknown,Timeout)`, and direct `Reserved→Confirmed` all reject; no release on silence. 6×5 table test locks the set. *(security, architecture, data-integrity)*
- **Money math** `checked_*`-only, `None → ArithmeticOverflow`, no `saturating_*`/`wrapping_*`/raw `as_yoctonear()` arithmetic; compute-then-commit proven by `rejection_never_mutates`. *(security, performance)*
- **`release_failed` idempotent** (no double-release), **`cancel` one-shot** via the state gate. *(security)*
- **No desync path** within the pure core; the `TestLedger` oracle recomputes independently and runs after every op. *(data-integrity)*
- **Borsh layout** struct-field + enum-variant order matches §1.2 exactly; `StorageKey` prefixes reserved append-only; `#[derive(PanicOnDefault)]` blocks default-init. *(data-integrity, pattern — modulo P3-11 doc drift)*
- **near-sdk 5.30 idioms** fully consistent; no deprecated API (`near_sdk::collections::*`, `UnorderedMap/Set`, `#[near_bindgen]`, raw-u128 `add_access_key`). *(pattern)*
- **Allocations** tight: `try_reserve` moves owned args into the `Commitment` with zero clones; `Display` is `&'static str` (no `format!`); test code correctly `#[cfg(test)]`-gated (zero wasm impact). *(performance)*
- **Dependency graph** clean and acyclic (`types ← error ← reservation ← budget`; `idempotency ← types`; `lib ← all`); `transition` honored as the sole legality authority (one sanctioned genesis exception: `try_reserve` stamps `Reserved` at construction). *(architecture)*

---

## Stakeholder / scenario notes

- **Developer:** the pure-core split (no `env`) makes every rule host-testable as ordinary Rust; the error-variant granularity lets tests prove *which* guard fired. Intuitive to extend.
- **Security:** attack surface in this PR is the accounting math + state machine — both exhaustively tested; the two real overspend vectors (mis-pairing, dispatched-`Reserved` release) are correctly deferred to the P4 boundary and flagged above.
- **Operations:** no runtime surface yet (no entrypoints beyond `new`/`version`); the live `assert_invariant` backstop (obligation #5) will give a cheap on-chain guard once entrypoints land.
- **Scenarios covered by tests:** happy path, boundary (exactly-at-cap, +1 over, spent==reserved, spent==0), invalid (zero amount, spent>reserved, every illegal transition), overflow (`u128::MAX` admission sum), idempotent/double-call (release, cancel, settle), headroom recycling. Concurrency/race is explicitly P6 (`near-workspaces`).

## Recommendation

**Merge-ready.** If you want the PR spotless before merge, apply **P2-1** (trivial import fix) and optionally the P3 idiomatic items (P3-1, P3-3, P3-4). Everything else is a documented P4/P6 obligation, not a change to this PR. The two P2 carried risks (D-1/D-2) are the highest-value items to track into Prompt 4.
