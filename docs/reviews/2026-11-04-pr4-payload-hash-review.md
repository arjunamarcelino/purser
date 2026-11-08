---
title: "Code review — PR #4: NEAR-native payload_hash construction + tamper rejection (Prompt 5 / 'sign only what you can read')"
pr: https://github.com/arjunamarcelino/purser/pull/4
branch: feat/near-native-payload-hash
base: main
commits: [a9a4b68, 1ed3e6c]
date: 2026-11-04
reviewers: [security-sentinel, architecture-strategist, data-integrity-guardian, performance-oracle, pattern-recognition-specialist, code-simplicity-reviewer, agent-native-reviewer]
verdict: SHIP — no P1/blocker; the audit anchor is correct, injective, never read for authorization, and TRD S1 holds. 3 P2 (forward-compat / operational hardening, non-blocking) + P3 polish.
status: RESOLVED 2026-11-04 — all 3 P2 + 11 P3 fixed across 11 commits (one per issue, no AI trail); `make lint` clean, `make build` green, 55 tests pass (35 lib + 8 delegates + 12 payments). See Resolution log.
---

# Code review — PR #4 (Prompt 5: NEAR-native `payload_hash`, "never blind-sign")

**Scope:** `contract/src/{payload,lib,types}.rs`, `contract/tests/payments.rs`, `contract/Cargo.{toml,lock}`
(+300/−40 across 6 files). Fills the one remaining stub (`Commitment.payload_hash: None`) by recording
a per-spend, contract-constructed audit anchor:

```
payload_hash = sha256( PAYLOAD_DOMAIN(32B) || borsh(version:u16, task, commitment_id:u64, recipient:&AccountId, amount_yocto:u128) )
```

built by a pure `canonical_payload_bytes()` in `payload.rs` and hashed via `env::sha256_array` inside
`open_reservation` (after `try_reserve` admits and the `cid` is assigned). Adds the independent
re-derivation + tamper-rejection test matrix and the TRD-S1 grep tripwire.

Seven independent agents reviewed the **implemented diff** (`main..HEAD`), not the plan. No code was
changed — this document is advisory, and per the review request **no todo files were created**.

---

## Verdict

**Shippable for the NEAR-native scope. No CRITICAL / P1 correctness or security finding.** The seven
reviewers converged:

- **The anchor is correct and injective.** `PAYLOAD_DOMAIN` is compiler-enforced 32 bytes; the body is
  all primitives + length-prefixed strings (no enum, no map), so the encoding is injective — no
  second-preimage/collision surface within the scheme. Fixed-width domain + length-framed body closes the
  `v1`/`v10` prefix ambiguity. *(security, architecture, best-practices)*
- **"Hashed == executed" holds literally.** The hash binds the exact parsed `payload.recipient` and
  `intent.amount` later moved into `Promise::new(recipient).transfer(amount)`, in the same synchronous
  frame, no mutation between. *(security, architecture, data-integrity)*
- **Never blind-sign / TRD S1 holds.** `payload_hash` is written once and never read for control flow; the
  only hash primitive call is the domain-separated `env::sha256_array` over contract-built bytes; no
  client value reaches a signing/authorization path; the grep for a raw-hash/payload entrypoint returns
  nothing. *(security)*
- **The money invariant is untouched.** Hashing adds no accounting mutation; it runs strictly after
  `try_reserve` admits, so a zero/over-budget/allowlist refusal does no hash work, burns no `cid`, and
  mutates nothing (atomic rollback). `cid` hashed == `cid` persisted (no off-by-one). *(data-integrity)*
- **Cheap and bounded.** ~0.01–0.02 Tgas added on the synchronous path (<1% of the ~6 Tgas burn),
  structurally isolated from the 10 Tgas `CALLBACK_GAS`; wasm effectively flat (`sha2` is test-only, borsh
  already linked, sha256 is a host import); preimage ≤ ~194 B — a hard constant ceiling, no griefing
  surface. *(performance)*
- **Pattern-faithful + read-path parity.** Purity boundary preserved (`payload.rs` stays env-free, the one
  `env` call is at the `#[near]` boundary); Borsh layout frozen (value `None`→`Some` only; `NearPayload`
  is transient, no freeze obligation); `payload_hash` is JSON-surfaced to agents via `get_commitment` /
  `list_commitments`. *(architecture, pattern, agent-native)*
- **Verified on a sandbox:** 36 unit + 9 near-workspaces tests pass, `clippy --all-targets -D warnings`
  clean, `cargo near build` succeeds (241.5 KB). The re-derivation test is a genuine independent oracle
  (`sha2` crate + hand-assembled preimage, not `canonical_payload_bytes`, not `env::sha256_array`).

### Dissent worth recording
The **agent-native** reviewer rated its "scheme not reachable by a non-Rust verifier" finding **P1**,
arguing it gates the feature's stated "independently re-derivable *without source access*" goal. Synthesis
**down-ranks it to P2** (P2-3): the off-chain consumers (indexer, dashboard, proposer, judge) live in the
same monorepo, `PAYLOAD_DOMAIN`/`PAYLOAD_VERSION` are stable `pub const`s, and a shared constant + a
Rust↔TS golden-vector in CI is the normal, low-risk way to keep a non-Rust verifier in lockstep. It is a
real parity/hardening gap, not a correctness blocker for the NEAR-native merge — but it is the single
finding where a reviewer and this synthesis disagree on severity, so it is flagged, not buried.

---

## Resolution log (applied 2026-11-04)

All **3 P2 + 11 P3** addressed across **11 commits** (one per issue, clean conventional messages, no
AI trail). Final state: `make lint` (clippy `--all-targets -D warnings`) clean, `make build`
(`cargo near build non-reproducible-wasm`) green, **55 tests pass** (35 lib + 8 delegates + 12
payments), 0 failures. The three P2s required owner confirmation (they change public surface / one
reverses the earlier additive-only decision) — all three were confirmed "implement".

| # | Sev | Outcome | Commit | Note |
|---|-----|---------|--------|------|
| P2-1 | 🟡 | ✅ Fixed | `7f80f52` | New owner-gated `remove_recipient_allowlist` + `RecipientAllowlistRemoved` event + 2 tests (removed payee can't be paid; non-owner refused). Reverses the earlier additive-only scope (owner-confirmed). |
| P2-2 | 🟡 | ✅ Fixed | `1456bcf` | `match intent.chain` at the hash site: `NearNative` arm hashes, `Evm` arm panics (unreachable today) so Prompt 12 must add its own digest. Scheme-selection now local to the construction site. |
| P2-3 | 🟡 | ✅ Fixed | `e9a2b93` | New `payload_scheme()` view + `PayloadScheme` DTO (domain_hex, version, hash, encoding); test proves a non-Rust client re-derives using ONLY the view output. (agent-native's P1 concern.) |
| P3-1 | 🔵 | ✅ Fixed | `75f00aa` + `d4149e1` | Docs: version fetchable via `payload_scheme()`, bump discipline. Storage: `d4149e1` appends `Commitment.payload_version: Option<u16>` (set with the hash) and carries it on `PaymentReserved`, so historical anchors stay re-derivable across a bump — no longer deferred. |
| P3-2 | 🔵 | ✅ Fixed | `c86684c` | `payload_hash` carried on `PaymentReserved` (same `[u8;32]` shape as `get_commitment`); `open_reservation` returns `(cid, hash)`; event-assertion test added. |
| P3-3 | 🔵 | ✅ Fixed | `c7a6520` | Cross-pointer comments between the two deliberately-independent oracles (`hand_assembled_body` ↔ `rederive_payload_hash`) + `canonical_payload_bytes`. |
| P3-4 | 🔵 | ✅ Fixed | `027609a` + `75f00aa` | Dropped the determinism test + self-implied prefix assertion (`027609a`); single-sourced the per-chain re-derivation prose in the `Commitment.payload_hash` doc (`75f00aa`). |
| P3-5 | 🔵 | ✅ Fixed | `812445a` | `canonical_payload_bytes(task: &TaskId, commitment_id: CommitmentId, …)` — matches the crate's alias convention; wire bytes unchanged. |
| P3-6 | 🔵 | ✅ Fixed | `1456bcf` | Comment at the hash site reflowed to statement indentation (landed with P2-2, same lines). |
| P3-7 | 🔵 | ✅ Fixed | `b98ae96` | `canonical_payload_bytes` builds in a single allocation via `to_writer` (was `to_vec` + `extend`). Despite perf's "won't-fix", applied per "fix all P3s"; byte output unchanged. |
| P3-8 | 🔵 | ✅ Fixed (doc) | `75f00aa` | Documented the primitives-only preimage discipline the infallible `to_writer` relies on. |
| P3-9 | 🔵 | ✅ Fixed | `84e45ed` | Reworded the oracle-independence rationale (separate `sha2` implementation, not the imprecise "SDK mock in this binary" claim). |
| P3-10 | 🔵 | ✅ Fixed (doc) | `75f00aa` | Named the `AccountId == String` borsh dependency and that the wire-layout unit test is load-bearing for off-chain verifiers. |
| P3-11 | 🔵 | ✅ Fixed (doc) | `75f00aa` | Documented that the anchor attests `recipient/amount/task/commitment_id` but NOT `token/delegate/memo`. |

**Forward work recorded (not in this PR):** the shared Rust↔TS golden-vector in CI and the TS
indexer verifier that consumes `payload_scheme()` (the off-chain half of P2-3).

---

## Findings

| # | Sev | Area | Finding | Location |
|---|-----|------|---------|----------|
| P2-1 | 🟡 | security | Allowlist is additive-only — no removal/revocation path (accepted risk; schedule removal) | `lib.rs:279-292` |
| P2-2 | 🟡 | architecture | NEAR hashing scheme applied unconditionally at the hash site — no `match intent.chain` guard; Prompt 12 could silently mislabel an EVM commitment with a NEAR-scheme digest | `lib.rs:598` |
| P2-3 | 🟡 | agent-native | Scheme (`PAYLOAD_DOMAIN`/`PAYLOAD_VERSION` + borsh layout) is Rust-source-only — a non-Rust verifier can't fetch it from any view/event/ABI (agent-native rated P1) | `payload.rs:35,40`; `lib.rs:39-41` |
| P3-1 | 🔵 | agent-native | Scheme `version` not pinned per-commitment — a future `PAYLOAD_VERSION` bump breaks re-derivation of historical commitments with no on-chain signal | `types.rs:114` |
| P3-2 | 🔵 | architecture / agent-native | `PaymentReserved` omits `payload_hash` — event-only indexer can't hydrate it (vs `TaskCreated.token` precedent). Deliberately deferred; documented alt is a `get_commitment` follow-up | `events.rs:44-51`; `lib.rs:374-383` |
| P3-3 | 🔵 | pattern / simplicity | Two hand-assembled borsh oracles (`hand_assembled_body`, `rederive_payload_hash`) never cross-check each other; a layout change needs 3 lockstep edits. Duplication is deliberate (independence) — add a cross-pointer comment | `payload.rs:247-263`; `payments.rs` `rederive_payload_hash` |
| P3-4 | 🔵 | simplicity | `canonical_bytes_are_deterministic` tests the language (pure borsh over primitives); self-implied second assertion in the golden-vector test; wire-layout prose stated ~5× | `payload.rs` unit tests + docs |
| P3-5 | 🔵 | pattern | `canonical_payload_bytes` params drop the `TaskId`/`CommitmentId` type-alias convention used elsewhere | `payload.rs:88-93` |
| P3-6 | 🔵 | (consensus) | Comment mis-indentation at the hash site — the explanatory `//` lines align to the `assert_invariant` trailing comment, not the statements they describe | `lib.rs:596-598` |
| P3-7 | 🔵 | performance | `PAYLOAD_DOMAIN.to_vec()` + `borsh::to_vec` + `extend` = 2 allocs + copy; collapsible to one `Vec::with_capacity` + `serialize(&mut vec)`. Immeasurable gain — **won't-fix** | `payload.rs:94-104` |
| P3-8 | 🔵 | security / data-integrity | `.expect("...infallible")` is correct today; keep the "primitives only" preimage discipline when the EVM scheme reuses this (a non-primitive type could make borsh fallible) | `payload.rs:102` |
| P3-9 | 🔵 | security | Test doc on `rederive_payload_hash` justifies using `sha2` by "env::sha256_array routes through the SDK mock in this test binary" — imprecise for a near-workspaces sandbox (the on-chain side runs real host sha256). Conclusion right, rationale off | `payments.rs` (helper doc) |
| P3-10 | 🔵 | security / architecture | Off-chain re-derivation implicitly depends on `AccountId` borsh == `String` borsh; name this in the `PAYLOAD_VERSION` doc and note the wire-layout unit test is load-bearing for off-chain verifiers | `payload.rs:37-39,99` |
| P3-11 | 🔵 | data-integrity / security | The anchor does not attest `token`, `delegate`, or `memo` (correct for NEAR-native: `token` is validated constant, native transfer carries no memo); state the scope explicitly so a reused preimage doesn't assume otherwise | `payload.rs:83-87` |

---

## Finding detail (P2 — should-fix, non-blocking)

### P2-1 · Allowlist is additive-only — no removal/revocation
`set_recipient_allowlist` (`lib.rs:279-292`) only inserts `true`; there is no owner path to revoke a payee.
A recipient added by mistake, or an account that is later compromised/rotated, stays payable up to the
task budget forever — remediable only by a contract migration. Mitigated by owner-only gating + per-task
budget caps (bounded blast radius), and the PR documents it honestly as accepted scope. **Recommendation:**
schedule an owner-gated `remove_recipient_allowlist` (and matching event) rather than leaving it
open-ended; it is the only security-relevant residual in the diff.

### P2-2 · EVM scheme-selection not localized at the hash site
`open_reservation` (`lib.rs:598`) applies the NEAR sha256 scheme unconditionally — there is no
`match intent.chain` or assertion at the construction site. Today this is safe only because
`build_near_payload` rejects any non-`NearNative` chain in a *different* function. When Prompt 12 relaxes
that reject, nothing at the hash site forces the author to branch, and an EVM commitment could be silently
stamped with a NEAR-scheme digest — exactly the mislabel `types.rs:109-113` warns verifiers about. The
documentation promises chain-dependent hashing; the code encodes a chain-independent assumption.
**Recommendation (cheap):** co-locate the assumption — `debug_assert!(matches!(intent.chain,
Chain::NearNative))` or an explicit `match intent.chain` where the hash is built.

### P2-3 · Non-Rust verifiers can't reach the scheme (agent-native rated P1)
`PAYLOAD_DOMAIN` / `PAYLOAD_VERSION` are `pub const` (importable by *Rust* consumers — the test oracle uses
exactly that) and the borsh layout is documented only in source comments. NEAR exposes view methods at
runtime, not free constants, and they are not in near-abi. So a JS/Python indexer, dashboard, or judge
cannot fetch the domain/version/layout from the deployed contract — it must hardcode values copied from the
repo, i.e. re-derivation is not independent of source. **Recommendation:** publish the scheme as a shared,
version-controlled off-chain spec/const consumed by the TS side, backed by a Rust↔TS **golden-vector** in
CI (the best-practices review's "real safety net"); or add a tiny `payload_scheme() -> (domain, version)`
view so a non-Rust client has a contract-anchored source. See the severity dissent above — this is
parity/hardening, not a NEAR-native correctness blocker.

---

## Finding detail (P3 highlights)

- **P3-1 version pinning:** version is baked into the preimage but not stored per-commitment; a future bump
  leaves historical commitments un-re-derivable with no on-chain signal. Consider storing/surfacing the
  version (or deriving it from `chain` + a stored tag) so audit history survives a bump.
- **P3-2 event parity:** the module banner names the event stream (not the O(ledger) `list_commitments`) as
  the scale path, yet `PaymentReserved` lacks `payload_hash`, so an event-only indexer can't hydrate it
  without a per-reservation `get_commitment` call. This was a deliberate deferral in the plan; the decision
  to make is "event-self-contained vs view-reconciled" — if the former, add the field (hex-encoded,
  chain-neutrally documented) consistent with `TaskCreated.token`.
- **P3-4 simplicity trim:** cut `canonical_bytes_are_deterministic` (pure borsh over primitives can't be
  non-deterministic) and the self-implied `got[..32] == PAYLOAD_DOMAIN` assertion; collapse the wire-layout
  prose (stated in ~5 places) to a single source-of-truth with pointers. The hand-assembled-borsh
  duplication across the two test tiers is **correct and must stay** — it is what makes the oracle
  independent; DRY-ing it would couple the oracle to the code under test and defeat the test's purpose.
- **P3-6 comment indent:** every reviewer that read `lib.rs:596-598` noted the two explanatory comment
  lines are indented to the `assert_invariant(b);` trailing-comment column, so they read as attached to the
  wrong statement. Purely cosmetic reflow.

---

## Stakeholder & scenario notes (condensed)

- **Developer:** API/flow unchanged for callers (`propose_payment` still takes the structured
  `PaymentIntent`); the new surface is a readable `payload_hash` field + two `pub const`s. Debuggable —
  the golden-vector unit test gives precise byte-diff failures without a sandbox.
- **Operations:** no new deploy risk; wasm flat; no migration (value-only field change on a frozen layout).
  Note P2-1 (no payee revocation) as an operational runbook caveat.
- **Security team:** attack surface reviewed — no blind-sign path, allowlist is exact-match/fail-closed, no
  normalization bypass, reserve amount ≡ transfer amount ≡ hashed amount. Audit capability is *present*
  (re-derivable anchor) but currently easiest for source-holders (P2-3).
- **Business:** realizes a headline product claim ("Purser only enforces policy over a transaction it
  understands") with the evidence artifact to prove it; low TCO (small, well-tested slice).
- **Scenarios checked:** happy path ✅; invalid inputs (malformed recipient, zero amount, wrong token, EVM
  chain) ✅ rejected pre-reserve, budget untouched, no `cid` burned; boundary (one-yocto-over-cap, memo at
  bound) ✅; concurrent/in-flight — out of scope here (Prompt-6 suite); resource/DoS — preimage bounded,
  no griefing. Not exercised: a genuinely-stuck callback leaving `Reserved` (owner `reconcile` covers it,
  and `payload_hash` is immutable across that path — data-integrity verified).

---

## Next steps (for the author to decide — nothing applied)

1. **P2-2** is the cheapest high-value item: a one-line `debug_assert!`/`match` at `lib.rs:598` that pays
   forward into Prompt 12. Consider for this PR.
2. **P2-1** and **P2-3** are better as scheduled follow-ups (a `remove_recipient_allowlist` entrypoint; a
   shared scheme spec + Rust↔TS golden vectors) than as scope-creep on this slice.
3. **P3-4 / P3-6** are a quick polish pass if touching the branch again; the rest are documentation/notes.
4. None of the above blocks merge. If merging as-is, record P2-1/P2-2/P2-3 as tracked follow-ups so they
   aren't lost.
