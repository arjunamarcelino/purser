---
title: "Code review — PR #5: security-proof suite (property tests + 7-case attack suite) and the two contract fixes it found"
pr: https://github.com/arjunamarcelino/purser/pull/5
branch: feat/security-proof-suite
base: main
commits: [b51f8a9, 5c2ff70, 20fd24e, e779aab, 587fd83, 0d91f6f, 505b887, e5b19ec, 04010d7, 9ed278f]
date: 2026-11-05
reviewers: [security-sentinel, architecture-strategist, data-integrity-guardian, pattern-recognition-specialist (test quality), performance-oracle, code-simplicity-reviewer]
verdict: "CONDITIONAL SHIP. The PR is strictly safer than main and its evidence is real (CI green, 71 tests, planted bugs go red). One P1: the reconcile time-lock is a heuristic, and the property model bakes in the same timing assumption, so the 'cannot double-spend' claim is not yet fully proven. 9 P2 + P3 polish."
status: "RESOLVED 2026-11-05 — P1 + all 9 P2 + P3 fixed across 14 commits (one per issue, no AI trail); 3 P3 declined with rationale. make lint (prod, fault, fixture) clean, actionlint clean, make build clean wasm, 74 tests pass (38 unit + 2 property + 11 attack + 15 payments + 8 delegates). See Resolution log."
---

# Code review — PR #5 (Prompt 6: prove the security property)

**Scope:** `main..feat/security-proof-suite`, 10 commits, 15 files, +5,325 / −12 (most of it tests and a
lockfile). The changes:

- **Contract fixes in `contract/src/{lib,error}.rs`:**
  - **D2:** a replay must match the stored task and intent, else `MSG_REQUEST_ID_REUSED`.
  - **D1:** `reconcile` is time-locked by `RECONCILE_MIN_AGE_NS`, which is 600 s of `block_timestamp`.
- **Fault injection:** a test-only `fault-injection` feature (a cfg'd helper that kills `on_near_settled`)
  plus `scripts/check-wasm-clean.sh`.
- **`tests/properties.rs`:** Layer A over the pure core (10k cases) and Layer B over the real `Purser`
  under the mocked VM (2k cases).
- **Attack suite:** `tests/attacks.rs` + `tests/common/mod.rs` (near-workspaces, receipt-height
  `race_proof`) and the `tests/fixtures/race-driver` fan-out contract.
- **Tooling:** CI reorder and guards, `make prove`, and `[profile.dev.package."*"] opt-level = 2`.

Six reviewers read the **implemented diff**, not the plan. Their claims were spot-checked against the code
before inclusion (see "Verified" markers). No code was changed. Per the request, this is one document and
**no todo files were created**.

**CI:** run 41881591792 passed both jobs in 37m45s on a cold cache. The time went to clippy (560 s) and
`cargo test` (1,494 s).

---

## Verdict

**The suite's core evidence is real and the PR should not be held back by anything except P1-1.** All six
reviewers agree on the following:

- **Both contract fixes are correct for the cases they target.**
  - The new `require!`s run before any mutation, so a refusal changes nothing (atomic).
  - The replay `expect` is unreachable: commitments are never removed, and `Committed` is only ever
    written with a just-read cid.
  - No Borsh or JSON type changed.
  - The extra cost is one storage read, about 0.05–0.1 Tgas, and only on a replay.
  - *(data-integrity, security, performance)*
- **The concurrency proofs are genuine.**
  - Cases 2 and 4 put the proposals in **one block**, and `race_proof` requires
    `max(admission height) < min(settlement height)`.
  - Leaf classification is strict.
  - Case 8's height oracle fails on the pre-fix contract, which the planted-bug check confirmed.
  - *(security, test quality)*
- **No test-only code leaks.**
  - The fault hook compiles to an empty fn in production.
  - `fault_hook_absent_from_production_wasm` is a two-sided check, and CI checks the shipped artifact.
  - The race-driver is host/coordinator-gated, standalone, and never deployed.
  - *(security, architecture)*
- **Layer B's rollback emulation is sound for `near_sdk::store`.** Calling `mem::forget` on the dirty
  struct leaves storage at its pre-call bytes, because `src` never flushes mid-call. On top of that, the
  harness asserts that views are unchanged after a panic, which is stricter than the runtime requires.
  *(architecture, test quality)*

What it does **not** yet prove: a settlement callback that arrives *after* the 10-minute lock. That gap
is P1-1.

---

## 🔴 P1 — resolve before claiming "cannot double-spend"

### P1-1. The reconcile time-lock is a heuristic, and the property model assumes the heuristic holds
*Raised independently by security, architecture and data-integrity.* **Verified.**

> ✅ **RESOLVED — option A** (`938d80c`). `on_near_settled` handles every state now. A late `Ok` on a `Failed` commitment goes through a new `Failed → Confirmed` edge (`record_contradicted_spend`): the spend is recorded, the idempotency entry becomes `Committed`, and `reconcile_contradicted` is emitted. If that puts the task over cap, `TaskBudget.frozen` is set (appended field) and `propose_payment` refuses with `task frozen`. A late `Err` on `Confirmed` keeps the safe over-count and flags it. Invariant (I) is asserted for every non-frozen task. Layer B delivers callbacks at any delay, lets the owner attest on silence, predicts freezing, and states the 10-minute lock independently of the contract constant (`SPEC_RECONCILE_MIN_AGE_NS`, asserted equal). Two planted bugs were caught: dropping the freeze, and ignoring the contradiction.

**Where:** `src/lib.rs:65-68` (const), `src/lib.rs:617-620` (the check), `src/lib.rs:502-560`
(`on_near_settled` panics on a non-`Reserved` commitment), `tests/properties.rs:604-606`
(`CALLBACK_WINDOW_NS = 5 s`), `:1109-1116` (`Tick` marks every Pending callback older than 5 s as Lost),
`:999` (`MSG_ILLEGAL` expected for a Deliver after settle).

**Failure scenario:**
1. NEAR gives no upper bound on receipt latency. Under congestion, a transfer receipt can sit in a
   delayed-receipt queue for more than 600 s, and `on_near_settled` waits on it.
2. At T+601 s the owner sees no outcome yet and calls `reconcile(cid, false)`. The lock passes, the
   commitment moves to `Failed`, and its headroom is released and re-spent.
3. The transfer then lands. The callback runs `authorize` on a `Failed` commitment, which hits an illegal
   edge, panics, and rolls back. The money has left, but the books say it was released, so the
   headroom has been spent twice.

**Why the suite misses it:**
- Layer B never models a callback arriving after the lock. `Deliver` only picks `Pending` callbacks, and
  `Tick` makes anything older than 5 s `Lost` forever. So the branch where the money-flow oracle
  (`:1196-1202`) would fire is unreachable.
- The model also imports `RECONCILE_MIN_AGE_NS` and copies the lock rule (`:1046`), so model and SUT
  share the logic under test.
- Layer B encodes the panic at `:999` as the *expected* outcome.

**Mitigating context (accounts for the severity):**
- This is not a regression. `main` had **no** lock, so the PR strictly narrows the window.
- The double spend also needs a **wrong owner attestation**. `reconcile(false)` documents "the owner
  proved it did not land". A transfer receipt's outcome is final before its callback runs, so an owner
  who waits for the *observed final* outcome cannot trigger this.
- The residual is therefore "owner attests on silence", which is exactly what Rule 4 forbids. The PR's
  docs, though, present the lock as closing the hole.

**Options:**

| Option | What | Pros | Cons |
|---|---|---|---|
| A (recommended) | Make `on_near_settled` **total**. On a `Failed` commitment that receives `Ok`, record reality: `completed += amount`, emit a `reconcile_contradicted` event, and freeze the task if `completed + outstanding > cap`. On a `Confirmed` commitment that receives `Err`, flag it the same way. Keep the lock as defense-in-depth. Add Layer B `Op::DeliverLate` for Lost commitments after a reconcile, keep the outflow oracle, and drop `RECONCILE_MIN_AGE_NS` from the model. | The books always match the chain, and the property genuinely covers the case | Medium effort. A "frozen / over-cap" state needs a dashboard story |
| B | Document the trust assumption precisely: `confirmed = false` is safe only after the owner has observed the transfer receipt's **final failed outcome**, never on silence. Optionally lock only `confirmed = false`, since an early `true` only over-counts. Add `DeliverLate` so the property pins the documented panic. | Small and honest | The guarantee still rests on the owner |
| C | Raise the lock (hours) | Trivial | Still a heuristic, and makes stuck-payment recovery slower |

**Acceptance:** Layer B can deliver a callback after a reconcile, and the outflow oracle holds, either
because the contract records the late spend (A) or because the test pins the documented limit (B). The
README and `lib.rs:593-598` state the residual trust assumption.

---

## 🟡 P2 — should fix

### P2-1. Layer B almost never reaches the *successful* replay path *(test quality)* **Verified**
Layer B has no `Retry` op (`properties.rs:707-722`); only Layer A does (`:161`). A successful replay
needs four things to line up:
- a random `Propose` hits a Committed `(who, r)` key,
- the task matches (1/2),
- the recipient matches (1/3),
- **and** `resolve_amount` reproduces the same amount, even though it is recomputed against the current
  `used` (`:963`), which happens about 1/1000 of the time for `Normal`.

> ✅ **RESOLVED** (`d6d7ef4`). Added `Op::Retry`, which re-sends a prior commitment's exact request. A planted "refuse every replay" bug now fails in about 2 s.

So under 1% of key collisions exercise `Out::Value(cid)`; almost all end in `REQUEST_ID_REUSED`.
**Fix:** add `Op::Retry { pick }` that re-sends a prior commitment's exact `(task, who, r, amount, recipient)`.

### P2-2. The D2 check is only exercised for task/amount/recipient, not memo/token/chain *(security, test quality, architecture)*
`lib.rs:437` compares the whole `PaymentIntent`, but every generator sends `memo: None` with NearNative
token and chain (`properties.rs:897-905`), and the model compares only `(task, amount, recipient)`
(`:1145`). A later "relaxation" of the check to amount + recipient would pass every test.
**Fix:**
- Vary memo in Layer B (`None` / `Some("")` / `Some(x)`) and make the model compare the full intent.
- Document that `None` and `Some("")` count as different requests, so clients must normalize memos.

> ✅ **RESOLVED** (`93ead8d`). Memo ∈ {None, "", "note", "other"}. `Retry` can swap only the memo. The model compares the full intent canonically and checks each stored intent. A planted memo-blind replay check fails in about 1.5 s. The README documents the client retry contract.

### P2-3. Raw-intent equality will misfire on the EVM path *(architecture)*
`prior.intent == intent` compares the raw `recipient: String`. That is fine for NEAR, because
`AccountId` parsing rejects non-canonical forms (security confirmed: no bypass). On EVM, though,
`0xAbC…` and `0xabc…` are the same payee, so an honest retry would get a terminal `REQUEST_ID_REUSED`.
**Fix:** compare a canonical form (normalized intent or the stored payload digest) now, so the EVM arm only
has to supply its own normalizer. Alternatively, record this as a Prompt-12 prerequisite.

> ✅ **RESOLVED** (`22feeb4`). New pure `same_request()` in `payload.rs`: exact chain/token/amount, NEAR recipient compared as a parsed `AccountId`, empty memo == no memo. Its `Chain::Evm` arm is the seam for Prompt 12's address normalizer. Unit-tested on every money-moving field.

### P2-4. The money-flow oracle is aggregate and can be masked *(data-integrity)*
`outflow[t] <= used(t)` (`properties.rs:1196-1202`) is a sum per task. One wrongly released executed
transfer (30) and one failed transfer that is still held (30) cancel out.
**Fix:** check per commitment that an executed transfer implies the commitment is held or `Confirmed`,
never `Failed`.

> ✅ **RESOLVED** (`41491b7`). Per-commitment check: an executed transfer is held or `Confirmed`, never `Failed`, except while a wrong release is still waiting for its contradicting callback. Layer B also bounds the aggregate check by exactly that unproven amount (`938d80c`).

### P2-5. Unbounded waits can hang CI *(performance, test quality, data-integrity)* **Verified**
- `settle()` (`attacks.rs:53-62`) polls every 100 ms with no timeout.
- The case 7 `while` loop (`attacks.rs:564-568`) has no iteration cap. It also has a TOCTOU: the
  reconcile can land in a later block that is already past the threshold, so it succeeds and
  `err_string` (via `unwrap_err`) panics.

> ✅ **RESOLVED** (`b9817b4`). `settle()` times out after 60 s. Case 7 asserts an explicit early reconcile is refused, then retries the reconcile itself with at most 10 fast-forwards (no TOCTOU), and checks that the clock really passed the lock.

**Fix:**
- Wrap `settle` in `tokio::time::timeout`.
- Cap the case 7 loop at about 5 iterations.
- Accept success when the threshold is crossed, and assert that time actually advanced.

### P2-6. Vacuous or self-referential assertions *(test quality)* **Verified**
- **`RaceProof::raced()` passes when nothing settled.** It returns `true` with no settlements
  (`common/mod.rs:270`), so if an event name drifts, every race proof passes vacuously. Assert
  `settlements.len() == reserved()`.
- **`hashes.dedup()` misses non-adjacent duplicates** (`attacks.rs:114`), so `[a, b, a]` passes. Use a `HashSet`.
- **Several Layer A checks only test the model:**
  - `:518-530` (unique keys, replay names a Confirmed commitment) read only the model.
  - `:534` cannot fail.
  - The SUT comparison (`:500-504`) skips `delegate` and `request_id`, so exactly-once is not actually
    checked on the SUT.

> ✅ **RESOLVED** (`4e46b04`). `raced()` requires one settlement per reservation. Distinct hashes are counted with a `HashSet`. Layer A checks exactly-once (delegate, request_id, key uniqueness, replay target) and (I) on the code under test. `MSG_ILLEGAL` was added to `ALL_MSGS` in `938d80c`.

  Compare those fields, and assert `sut.budget.completed + outstanding <= cap` directly.
- **`MSG_ILLEGAL` is missing from `ALL_MSGS`** (`properties.rs:915-929`). The `:999` prediction would
  abort with "unexpected panic message" the day the branch becomes reachable, which P1-1's `DeliverLate`
  will do.

### P2-7. The wasm-clean guard covers only CI's non-reproducible build *(security, architecture)*
`check-wasm-clean.sh` runs in `ci.yml:41` only. Neither `contract-build-release` (the reproducible
build) nor the upcoming deploy target calls it.
**Fix:**
- Call it from both targets.
- Optionally make a `build.rs` `compile_error!` reject `fault-injection` unless an opt-in env var is set.
- Alternatively, use a `--cfg purser_fault` rustflag, which feature unification and `--all-features`
  cannot enable.

> ✅ **RESOLVED** (`5e85cae`). `build.rs` fails compilation of `fault-injection` without `PURSER_ALLOW_FAULT_INJECTION=1`, so `--all-features` and stray builds fail loudly. The harness passes the opt-in via `cargo near build --env`. `make build-release` runs `check-wasm-clean.sh`, and the deploy stub records that it must too.

### P2-8. CI is 37 min cold and builds the wasm four times *(performance, architecture)*
- `wasms()` (`common/mod.rs:42-78`) runs three release builds (`lto`, `codegen-units = 1`), and the
  fault build's separate target dir recompiles every wasm32 dependency.
- `ci.yml:40` then rebuilds the production wasm.
- rust-cache only caches `workspaces: contract`, so the fixture's lockfile isn't part of the cache key,
  and the sandbox binary in `~/.near` isn't cached.

> ✅ **RESOLVED** (`190aa42`, `6ea3e4e`). One artifact path: every sandbox suite reads prod/fault/driver from `tests/common`, built lazily and one at a time, or taken from `PURSER_WASM_*`. CI runs `lint | wasm | host-tests` in parallel, and `sandbox-tests` (needs `wasm`) uses the artifacts built once. rust-cache keys both lockfiles, with `cache-on-failure`. `PROPTEST_CASES` is tiered: 256 on PRs, the code defaults on main, 20000 in a new nightly run. The sandbox binary is under `OUT_DIR`, so the target cache already covers it and `~/.near` isn't needed. Validated locally (env-provided wasms, the job's exact build commands) and with `actionlint`; the first PR run will confirm the wall time.

**Fix, in priority order (estimated about 37 → 15 min cold, 5–8 min warm):**
1. Build the wasms once in a `wasm` job and pass their paths to the tests via env vars.
2. Split CI into lint / host tests / sandbox tests.
3. Add the fixture to the cache `workspaces`, set `cache-directories: ~/.near`, and `cache-on-failure`.
4. Use tiered `PROPTEST_CASES`: 256 on PRs, full counts on main and nightly.

### P2-9. The wire contract has drifted ahead of `packages/types` *(architecture)*
`MSG_REQUEST_ID_REUSED` (terminal) and `MSG_RECONCILE_TOO_EARLY` (retry later) are new refusal strings with
retry semantics, and `RECONCILE_MIN_AGE_NS` is invisible to clients.
**Fix:**
- Add an error-code and retry-class table to `packages/types` before the TS proposer lands (Prompt 7).
- Expose the min-age through a view (e.g. `get_config`) so ops tooling doesn't hard-code 600 s.

> ✅ **RESOLVED** (`88a81de`). Added a `get_config()` view: the reconcile lock plus the request_id, memo and task_id limits, sandbox-tested. `packages/types/README.md` now has the refusal table with retry classes (wait / retry later / terminal) and the `reconcile_contradicted` event.

---

## 🔵 P3 — polish

> ✅ **RESOLVED** except the three declined items below. Commits: `5e80972` (property harness),
> `7fac83c` (attack suite / common), `190aa42` (shared artifact path, helper duplication),
> `6ea3e4e` (CI lock-step and guard scope), `cb00673` (docs/comments).
>
> **Done:**
> - **Tick range:** it straddles the 600 s lock on purpose; a comment now says so.
> - **cids and events:** the fresh-admission cid is read from the `payment_reserved` event, every
>   callback's event is checked, and Layer B no longer assumes cid = ledger index.
> - **Layer A dead paths:** `SpentExceeds` is reachable (per-mille up to 1100), and d0 is never
>   revoked. The `Tick` semantics are documented.
> - **Mock upgrade hazard:** noted in the harness.
> - **Case 8 / case 9:**
>   - Case 8 uses `common::height` / `has_event`, explains why the owner hosts the driver, and its
>     misnamed closure is gone.
>   - Case 9 is removed. Its new check moved to `payments.rs::settlement_callback_cannot_be_forged`.
> - **Duplication:**
>   - `REQUEST_ID_REUSED` is tested once, in `payments.rs`, which now also covers the books after a
>     refusal and cross-task reuse.
>   - `propose`/`propose_tx` are unified, `msg_static` is gone, and `EXPECTED_REFUSALS` is trimmed to 2.
>   - Case 2c is renamed 2b.
>   - `payments.rs`/`delegates.rs` share `tests/common` for the artifacts.
> - **Constants:**
>   - The fault marker is one public `FAULT_MARKER` (the script points at it).
>   - Named constants replace the literals: `CREW_CAP`, `PROPOSE_TGAS`/`FIRE_TGAS`, `GENESIS_NS`.
> - **Comments:**
>   - the overflow-safe amount math
>   - race-driver scheduling on drop
>   - the replay `expect` and its pruning hazard
> - **CI:**
>   - a race-driver toolchain + near-sdk lock-step diff
>   - the deploy-tooling guard now also covers the Makefile
> - **Docs:**
>   - the Cargo.toml comments are trimmed
>   - the README overclaim is fixed
>   - the `--all-features` note appears once
>
> **Declined (with rationale):**
> - **"Reused" for a mismatched `Pending`/`Failed` key.** This would mean storing a cid in
>   `IdemState::Pending`/`Failed`. BACKEND-SCHEMA fixes `IdemState = Pending | Committed { commitment_id }
>   | Failed`, and the TS proposer branches on it. It is never a false success, so it isn't worth a
>   schema change.
> - **An exported `__purser_fault_build()` marker method.** Superseded by the P2-7 `build.rs` gate: a
>   fault build can no longer be produced without an explicit opt-in, and the marker check remains.
> - **`list_commitments` full scan.** Pre-existing and outside this diff; the reserved
>   `StorageKey::TaskCommitments` index is the known fix.

**Tests and harness:**
- **Tick range** `590u64..=900` (`properties.rs:720`) dips below the 600 s threshold **(verified)**.
  Probably meant to be `600..=900`, or intentionally straddling it; say which.
- **The proposed cid is never checked directly.** `Out::Promise(u64::MAX)` is overwritten with the
  predicted cid (`:968-976`), and Layer B assumes cid = dense index (`:893`, `:992`). Record the cid the
  contract actually returns.
- **Layer A dead paths:**
  - `Outcome::SpentExceeds` is never produced, since `spent_per_mille ≤ 1000`.
  - `Tick` is a no-op, because `now += 1` runs every step.
  - `Revoke` is permanent, which starves late `Propose`s.
- **Coverage and parity:**
  - Events emitted on success paths are never asserted in Layer B, so indexer-wire payloads go unchecked.
  - Layer B relies on `near_sdk::mock` internals, which is fine while pinned at `=5.30`. Note it as an
    upgrade hazard.
- **Case 8 and case 9:**
  - Case 8 re-implements `has_event` and the height lookup. Add `common::height(worker, &outcome)`.
  - Case 8's closure named `height` returns a `block_hash`.
  - The dummy coordinator `"unused.test.near"` needs a one-line explanation of why the owner must host
    the driver.
  - Case 9 mostly duplicates `payments.rs:508/528` (`reconcile_rejects_*`); only the `"is private"`
    assert is new. Its `for _ in 0..2` loop adds nothing.
- **Duplication and naming:**
  - `MSG_REQUEST_ID_REUSED` is tested both in case 3 and in `payments.rs`.
  - `propose` and `propose_tx` build the same call.
  - `msg_static` is unnecessary.
  - `EXPECTED_REFUSALS` lists 6 messages where the race tests expect 2. Trim it so the classification
    really is strict.
  - Case numbering (2, 2c, 4, 4b) has gaps.
- **Constants:** the fault marker appears 4 times (lib.rs const, two places in attacks.rs, the shell
  script). Make the lib const `pub` and reuse it. Magic numbers: crew cap 3, driver gas 75/90/120/60 Tgas,
  genesis `1_000_000_000`.
- **Comments to add:**
  - At the `Amount::Normal` `1 << 100` overflow guard.
  - On how `CALLBACK_WINDOW_NS` relates to `RECONCILE_MIN_AGE_NS`.
  - On `race-driver/src/lib.rs:47-53`: the batch is scheduled only because it is dropped, so an early
    return or `mem::forget` would silently send nothing.

**Contract and docs:**
- A mismatched request on a `Pending`/`Failed` key reports `in-flight` / `already failed` rather than
  `reused`. That is never a false success, so it's OK, just less clear.
- `check-wasm-clean.sh` keys on one string. An exported `__purser_fault_build()` method checked via
  wasm exports would be sturdier.
- The CI race-driver guard greps only `../scripts`, not `Makefile` or `app/`.
- The race-driver's toolchain and near-sdk lock-step is enforced only by comments. Add a CI diff of the
  two `rust-toolchain.toml` files and the pin.
- `payments.rs` / `delegates.rs` still duplicate `tests/common`; migrating them is the known follow-up.
- The Cargo.toml `[features]` / `[profile.dev.package."*"]` comments are 3–4 lines each and repeated in
  the README and Makefile.
- README "on every interleaving it can generate" slightly overclaims, and the `--all-features` warning
  appears twice.
- **Pre-existing, outside this diff:** `list_commitments` scans the whole ledger (`lib.rs:827-840`).

---

## Stakeholder notes

- **Judges / security track:** the evidence is demo-ready (`make prove` takes 1m39s and prints heights).
  Resolve P1-1 before saying "cannot double-spend" without qualification.
- **Ops:** a stuck payment now needs ≥10 min before `reconcile`. That should be in the runbook, with
  `RECONCILE_MIN_AGE_NS` exposed through a view (P2-9).
- **TS proposer (Prompt 7):**
  - Two new refusal strings with different retry semantics (P2-9).
  - Clients must normalize memos before retrying (P2-2).
- **CI cost:** the cold run is high but cached runs should be cheaper. P2-8 makes it predictable.

## Recommended order

1. **P1-1**, option A, or option B as the minimum. Add `DeliverLate` either way.
2. **Test-strength set:** P2-1 / P2-2 / P2-4 / P2-6.
3. **Hang risk:** P2-5.
4. **Build hardening:** P2-7.
5. **CI time:** P2-8.
6. **Wire contract:** P2-9 / P2-3.
7. P3 as convenient.


---

## Resolution log (2026-11-05)

Fixed on `feat/security-proof-suite`. Each commit is one issue, authored by the user only, with no AI trailer.

| Commit | Resolves |
|---|---|
| `938d80c` fix(contract): record a settlement that contradicts a reconcile | P1-1 (option A), P2-6 (`MSG_ILLEGAL` in `ALL_MSGS`) |
| `22feeb4` fix(contract): compare replays in canonical form | P2-3 (+ the memo-normalization note in P2-2) |
| `d6d7ef4` test(contract): exercise the successful replay path in Layer B | P2-1 |
| `93ead8d` test(contract): vary the memo so the replay check is fully pinned | P2-2 |
| `41491b7` test(contract): per-commitment money-flow check in Layer B | P2-4 |
| `b9817b4` test(contract): bound every wait in the attack suite | P2-5 |
| `4e46b04` test(contract): make vacuous assertions able to fail | P2-6 |
| `5e85cae` build(contract): refuse fault-injection builds without an explicit opt-in | P2-7 |
| `88a81de` feat(contract): get_config view and the refusal wire contract | P2-9 |
| `190aa42` test(contract): one artifact path for every sandbox suite | P2-8 (prerequisite), P3 helper duplication |
| `6ea3e4e` ci: split into parallel jobs that build each wasm once | P2-8, P3 lock-step diff + guard scope |
| `5e80972` test(contract): tighten the property harness (events, cids, dead paths) | P3 (properties.rs set) |
| `7fac83c` test(contract): consolidate the attack suite helpers and tests | P3 (attacks/common set, case 9, marker, constants) |
| `cb00673` docs: trim and correct the security notes and comments | P3 (docs/comments set) |

**Verification:**
- `make lint` is clean, as are the fault-feature clippy (with the opt-in) and the fixture fmt + clippy.
- `actionlint` is clean.
- `make build` produces a 254,012 B wasm that `check-wasm-clean.sh` passes.
- `make test` passes 74 tests: 38 unit, 2 property (10k + 2k cases), 11 attack, 15 payments, 8 delegates.

**Planted-bug checks run during the fixes.** Each one went red as expected, then the code was restored:
- dropping the freeze
- ignoring a contradicted release
- refusing every replay
- a memo-blind replay check
- ignoring every contradiction

One process note: the first memo-blind plant was **not** caught, and that commit had already been made.
The generator could not produce a memo-only difference, so `Retry` gained a memo swap and the commit
was amended before any push.

**Open, not code:** CI's new wall time is confirmed on the next PR run.
