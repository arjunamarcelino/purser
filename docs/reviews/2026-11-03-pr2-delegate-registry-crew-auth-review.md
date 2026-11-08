---
title: "Code review — PR #2: task + delegate registry, crew-cap & honest revocation"
pr: https://github.com/arjunamarcelino/purser/pull/2
branch: feat/delegate-registry-crew-auth
base: main
commits: [383d422, dfa7246, 5ad109d]
date: 2026-11-03
reviewers: [security-sentinel, architecture-strategist, data-integrity-guardian, performance-oracle, code-simplicity-reviewer, pattern-recognition-specialist, agent-native-reviewer]
verdict: SHIP — no P1/blocker; 3 P2 (should-fix), rest P3 polish
status: RESOLVED 2026-11-03 — all P2s + P3s addressed (2 reasoned won't-fix/deferred); see Resolution log
---

# Code review — PR #2 (Prompt 3: task + delegate registry, crew-cap & honest revocation)

**Scope:** `contract/src/{lib,delegates,types,error,budget}.rs`, `contract/tests/delegates.rs`,
`README.md`, `Cargo.{toml,lock}` (+1003 / −20). Rust / near-sdk 5.30. First `env`-reading contract
layer on top of the pure Prompt-2 accounting core.

## Verdict

**Shippable. No CRITICAL / P1 findings.** Seven independent reviewers converged on this:

- **No access-control bug.** All three mutators (`create_task`, `add_delegate`, `revoke_delegate`)
  are correctly gated on `predecessor == self.owner`; there is no ungated mutator, and a
  non-owner / registered delegate has **no** state-mutating surface in this slice (`propose_payment`
  is Prompt 4). `#[init]` without `ignore_state` prevents re-initialization.
- **No data corruption.** Borsh append-only is correct at all three carriers (`TaskBudget.active_crew`
  last; `Purser.{delegates,allowlist}` last; `StorageKey` unchanged). The `active_crew` counter is a
  **provable** inductive invariant (`active_crew == |{d: d.active}|`) across every add/revoke/
  re-revoke/re-add path — the unique-key guard + the `was_active`-gated decrement make double-count
  and double-decrement unreachable. Composite `(TaskId, AccountId)` keys are collision-safe
  (Borsh length-prefixing). The money invariant `completed + outstanding ≤ cap` is untouched.
- **Conventions honored.** `env` reads only at the `lib.rs` boundary; `delegates.rs` is a pure
  free-function over a borrowed collection; `MSG_*` panic strings fully centralized (zero inline
  literals) and re-exported for the external test crate; `require!`/`env::panic_str` throughout (no
  bare `panic!`/`assert!`); auth is single-sourced through `delegates::is_authorized`.
- **Quality gate (re-verified):** 27 lib + 6 integration tests pass; `clippy --all-targets -D warnings`
  clean; `fmt` clean; `cargo near build` → 177.5 KB wasm + ABI.

The findings below are scaling/rigor/quality improvements, **not** merge blockers. None require a fix
before merge; the two marked *pre-deploy* are cheapest to do while the Borsh/event layout is still
unfrozen.

---

## Resolution log (applied 2026-11-03)

All P2 and P3 findings addressed; one commit per issue (clean conventional messages, no AI
trail). P3-8 and P3-9 are reasoned won't-fix / deferred per an explicit operator decision.
Final gate after the fixes: `fmt` clean · `clippy --all-targets -D warnings` clean · **27 lib +
8 integration tests pass** · `cargo near build` → 181.6 KB wasm.

| # | Sev | Status | Commit | Resolution |
|---|-----|--------|--------|-----------|
| 3 | P2 | ✅ Fixed | `8dbd0ad` | `TaskCreated` now carries `token: TokenSpec`; event test asserts it. |
| 4 | P3 | ✅ Fixed | `4cc983d` | `DelegateRevoked` emitted only on a real deactivation; dropped the now-always-true `was_active` field (callers still get it via the `bool` return). |
| 7 | P3 | ✅ Fixed | `74588cd` | Redundant `if was_active { d.active = false }` branch + shadow replaced with an unconditional assign returning the prior state. |
| 6 | P3 | ✅ Fixed | `43c453f` | Both bare `.unwrap()`s → `.expect("task presence checked above")`. |
| 11 | P3 | ✅ Fixed | `1be96c6` | `64`/`128` → `MAX_TASK_ID_LEN` / `MAX_DERIVATION_PATH_LEN` consts. |
| 12 | P3 | ✅ Fixed | `cbc4d66` | Added a `//!` crate-root banner to `lib.rs`. |
| 10 | P3 | ✅ Fixed | `43ce8f9` | `PurserEvent` moved to a dedicated `events.rs`; `delegates.rs` is now purely the membership predicate. |
| 1 | P2 | ✅ Fixed | `c52b789` | `list_delegates` + `list_task_ids` paginated `(from_index, limit)`; bounds result & per-call work. (Full O(per-task) still needs the reserved `DelegateIndex`; deferred per the documented D-6 tradeoff.) |
| 9 | P3 | ⏭️ Deferred | `c52b789` | `derivation_path` exposure: added a code note on `list_delegates` to redact it when Chain Signatures lands (Prompt 5); meaningless until then. |
| 2 | P2 | ✅ Fixed | `5bf5f74` | Added `assert_crew_consistent` oracle (recompute vs `active_crew`) + an `active_crew_oracle` churn test — the denormalization invariant is now machine-checked. |
| 5 | P3 | ✅ Fixed | `73ecfb7` | New `refusals_cover_remaining_guards` (MSG_INVALID_PATH / MSG_NO_SUCH_TASK / MSG_NO_SUCH_DELEGATE); tightened the idempotent-revoke test to `crew_cap=1` and added the same-account-re-add-after-revoke refusal. |
| 8 | P3 | 🚫 Won't-fix | — | Delegate events stay deltas: `added ⇒ active=true`, `revoked ⇒ active=false` is a trivial standard inference; a constant-valued `active` field is noise and contradicts the simplicity bar that removed `TaskBudgetView`. (Operator-confirmed.) |
| 13 | P3 | ✅ No change needed | — | `active_crew` underflow backstop (`overflow-checks`) already documented in `Cargo.toml:31-41`; the warning fires on Cargo-workspace promotion. No code change. |
| 14 | Info | ⏭️ Deferred | — | Accounting `MSG_*` re-export left for the Prompt-6 attack suite (not needed yet). |
| 15 | Info | — | — | `TaskBudget.owner` redundancy is intentional pre-freeze insurance; no change. |

---

## Findings

| # | Sev | Finding | Location | Corroborating reviewers |
|---|-----|---------|----------|------------------------|
| 1 | 🟡 P2 | Unbounded registry growth + `list_delegates` is O(all delegates in contract), not per-task | `lib.rs:271-277`; revoke never removes rows | security (I-1), performance, data-integrity, agent-native, architecture |
| 2 | 🟡 P2 | `active_crew` denormalization invariant maintained by hand, not machine-checked (no `assert_invariant`/recompute oracle like `budget.rs`) | `lib.rs:192, 228` | architecture (MEDIUM) |
| 3 | 🟡 P2 | `TaskCreated` event omits `token` (a `NOT NULL` column in the indexer `task` table) — *pre-deploy fix* | `delegates.rs:48-53` | agent-native (MEDIUM) |
| 4 | 🔵 P3 | `DelegateRevoked` emitted even on an idempotent no-op → phantom events for the indexer | `lib.rs:230-235` | security (N-1) |
| 5 | 🔵 P3 | Missing refusal tests: `MSG_INVALID_PATH`, `MSG_NO_SUCH_TASK`, `MSG_NO_SUCH_DELEGATE`, and same-account re-add-after-revoke (terminal-revoke semantic) | `tests/delegates.rs` | pattern, security (N-2), simplicity |
| 6 | 🔵 P3 | Two bare `.unwrap()` diverge from the `.expect("why")` house convention | `lib.rs:192, 228` | pattern |
| 7 | 🔵 P3 | `revoke_delegate` has a redundant `if was_active { d.active = false }` branch + shadowed binding | `lib.rs:214-224` | simplicity |
| 8 | 🔵 P3 | Delegate events are deltas, not self-describing snapshots (no resulting `active`, no timestamp) | `delegates.rs:55-64` | agent-native (#2) |
| 9 | 🔵 P3 | `derivation_path` surfaced via the public `list_delegates` view — revisit before Chain Signatures ships | `types.rs` + `lib.rs:271` | security (N-3) |
| 10 | 🔵 P3 | `PurserEvent` (incl. task-lifecycle `TaskCreated`) lives in `delegates.rs` — cohesion/naming drift | `delegates.rs:46-65` | architecture (LOW) |
| 11 | 🔵 P3 | Input bounds `64`/`128` are inline magic numbers, not named consts | `lib.rs:122, 165` | pattern (nit) |
| 12 | 🔵 P3 | `lib.rs` lacks a `//!` module banner (pre-existing; this PR added the whole control plane under it) | `lib.rs:1` | pattern (nit) |
| 13 | 🔵 P3 | Latent: `active_crew -= 1` underflow backstop relies on `overflow-checks`, silently disabled on Cargo-workspace promotion (already warned in `Cargo.toml`) | `lib.rs:228`, `Cargo.toml:31-41` | data-integrity, security |
| 14 | ℹ️ Info | Accounting `MSG_*` not re-exported → unreachable from the (future) Prompt-6 attack crate | `lib.rs:16-20`, `error.rs:17-19` | pattern |
| 15 | ℹ️ Info | `TaskBudget.owner` is always `== self.owner` today (pre-freeze insurance for multi-owner) | `lib.rs:130` | architecture |

---

## Detail & recommendations (no changes applied — advisory only)

### 🟡 P2-1 — Registry growth + full-table `list_delegates` scan
Revocation frees the `active_crew` slot but **never removes** the `(task_id, account_id)` row
(`active=false` persists; re-adding that account is permanently blocked by the `!contains_key` guard,
`lib.rs:175`). `list_delegates` iterates the whole flat `delegates` map filtering by `task_id.0`
(`lib.rs:271-277`), so its cost is O(all delegates across all tasks). As revoked rows accumulate (high
crew turnover, or many tasks) this **public, dashboard-facing view** can eventually exceed the
view-gas ceiling and start failing for *every* task. Owner-only to trigger (so not an external
attack) and a **deliberate** D-6 tradeoff (the `DelegateIndex` StorageKey variant is reserved for
exactly this), hence P2 not P1.
**Recommendation:** add `(from_index, limit)` pagination to `list_delegates` *and* `list_task_ids`
(additive, no storage-layout change — matches the planned `list_commitments(from, limit)` shape); the
off-chain indexer consuming the NEP-297 events is the intended scale path. Revive `DelegateIndex` only
if an *on-chain* caller ever needs per-task enumeration.

### 🟡 P2-2 — `active_crew` invariant isn't machine-checked
`budget.rs` earns trust via `assert_invariant` + a recompute-from-ledger `TestLedger` oracle after
every op. The new `active_crew` counter is a denormalized cache maintained by hand at `lib.rs:192`
(`+1`) and `:228` (`-1`), with nothing asserting `active_crew == count(active delegates)`. **This is
not a live bug** — security and data-integrity both proved the counter correct today — it's a
rigor/defense-in-depth gap against *future* drift.
**Recommendation:** extract the admission/count logic into a pure `Result`-returning helper and
unit-test it, or add a `#[cfg(test)]` recompute oracle
(`list_delegates(task).filter(active).count() == active_crew`) so the denormalization is
machine-checked the way (I) is.

### 🟡 P2-3 — `TaskCreated` omits `token` (pre-deploy)
The event carries `task_id, owner, cap, crew_cap` but not `token`, which is `NOT NULL` in the
indexer's `task` table (schema §2.2); the event even carries `crew_cap` (which has *no* column) while
dropping the required `token`. The §2.3 poller reads views so it's non-blocking, but the event's field
set is internally inconsistent. Field names are frozen per `delegates.rs:14-17`, so **now (pre first
stateful deploy) is the right time** to add `token: TokenSpec` to the variant.

### 🔵 P3 highlights
- **#4 phantom revoke events:** emit `DelegateRevoked` only when `was_active == true`, else an indexer
  keying on the event (not `was_active`) double-processes/logs a no-op revoke.
- **#5 test gaps:** add `is_failure()` + `err_string(..).contains(MSG_*)` assertions for the three
  untested guards, and a test that re-adds the **same** revoked account and asserts
  `MSG_DELEGATE_EXISTS` — the "revoke is terminal" semantic (`lib.rs:175`) is currently unverified, so a
  future change re-activating a revoked row would pass the suite unnoticed. (The existing
  `readd_refused_and_revoke_idempotent` also overclaims: its trailing add runs under `crew_cap=3`, so it
  doesn't exercise the freed-slot boundary — `crew_cap_and_free_slot` is what actually proves the
  decrement; tightening the former to `crew_cap=1` would sharpen it.)
- **#6/#7 tidy:** `self.tasks.get_mut(&task_id).expect("task presence re-checked above")` at `:192`/`:228`;
  drop the redundant `if was_active { d.active = false }` branch in favor of an unconditional assign
  returning the prior value.
- **#9 derivation_path exposure:** opaque/unused in the MVP (`public_key` always `None`), but under
  Chain Signatures a derivation path maps to a derived address — reconsider surfacing it in an
  unauthenticated view before that path ships.

### Not acted on this PR (out of scope / future prompts)
`get_signer_id()` view (Prompt 5), a `tasks_for_delegate(account_id)` reverse index, a reason-returning
auth variant, and the Prompt-6 accounting-`MSG_*` re-export (#14).

---

## What's done well (verified, not boilerplate)

- Clean acyclic module DAG (`types` is the leaf); `env` boundary is genuinely singular; auth predicate
  single-sourced through `delegates::is_authorized` (DRY, like `reservation::transition`).
- Append-only Borsh implemented correctly and consistently; keeping the superseded `DelegateIndex`
  variant *reserved rather than deleted* is the correct conservative choice.
- Honest revocation correctly modeled (`active=false` blocks only future auth; no `outstanding`
  release; idempotent re-revoke can't double-decrement) and documented in code + README.
- Panic-at-boundary + `MSG_*` centralization + `assert_invariant` reuse all match the Prompt-2 bar;
  the Prompt-4 extension point (`assert_delegate_authorized`) is already in place and extends with no
  refactor.
- Events emitted *after* state writes everywhere; event field names treated as a frozen indexer
  contract; agent-discovery triad (`list_task_ids` × `is_delegate_authorized` + `remaining_budget`)
  complete for the slice.

## False positives considered and dismissed (by the reviewers)

Reentrancy / TOCTOU on the crew-cap snapshot (single-threaded, no cross-contract calls);
`active_crew` overflow/underflow/desync (guarded + `overflow-checks`); double-settle / double-decrement;
re-init via `new` (`#[init]` state guard); panic-message state leakage (static literals only); event
emitted-before-write or event data leak (`cap` is owner-supplied public data); prefix collision between
the tuple-key maps; `remaining()` underflow.

---

## Stakeholder lens (brief)

- **Developer:** small, well-documented, single-responsibility entrypoints; the one friction is the
  hand-maintained `active_crew` invariant (P2-2) and the three missing refusal tests (P3-5).
- **Operations / indexer:** events are the intended scale path; fix `TaskCreated.token` (P2-3) and the
  phantom-revoke event (P3-4) so the derived `task`/`delegate_snapshot` tables hydrate cleanly, and
  paginate the enumeration views (P2-1) before real crew sizes.
- **Security:** attack surface in this slice is owner-only; no external mutation path until Prompt 4.
  Watch `derivation_path` exposure (P3-9) when Chain Signatures lands.

## Suggested next steps (your call — nothing applied)

1. Optionally land the two **pre-deploy** items while layout is unfrozen: `TaskCreated.token` (P2-3) and
   the phantom-revoke guard (P3-4).
2. Decide on P2-1 (paginate now vs. defer to the documented index revival) and P2-2 (pure helper vs.
   debug recompute oracle).
3. Fold the P3 test gaps (#5) and `.expect()`/tidy nits (#6/#7) into this PR or a fast follow.

> Per request, this review is advisory only — no code was changed and no todo files were created.
