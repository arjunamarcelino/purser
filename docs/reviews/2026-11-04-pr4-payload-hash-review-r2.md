---
title: "Code review (round 2) — PR #4: NEAR-native payload_hash + the review-fix commits"
pr: https://github.com/arjunamarcelino/purser/pull/4
branch: feat/near-native-payload-hash
base: main
commits: a9a4b68..d4149e1 (13 commits — original 2 + 11 review-fix commits)
date: 2026-11-04
reviewers: [security-sentinel, architecture-strategist, data-integrity-guardian, performance-oracle, code-simplicity-reviewer, pattern-recognition-specialist, agent-native-reviewer]
verdict: SHIP — no P1; no correctness/security/integrity regression from the 11 fix commits. The one actionable cluster is the `payload_scheme()` verifier surface (incomplete + chain-blind + ambiguously-named), which undercuts the very "re-derive without source" goal the view was added for. 4 P2 + P3 polish.
status: RESOLVED 2026-11-04 — all 4 P2 + 7 P3 fixed across 6 commits (one per issue/cluster, no AI trail); `make lint` clean, `make build` green, 56 tests pass (36 lib + 8 delegates + 12 payments). See Resolution log.
---

# Code review (round 2) — PR #4

**Scope:** the full PR at `d4149e1` (+524/−47 across 8 files), with emphasis on the **11 review-fix
commits** added since round 1 — `remove_recipient_allowlist`, `payload_scheme()` + `PayloadScheme`,
`Commitment.payload_version` + the event field, the `match intent.chain` hash-site guard, the
single-allocation `canonical_payload_bytes`, and the type-alias / doc changes.

Seven independent agents reviewed the implemented diff. Round-1 findings are all resolved (see
`2026-11-04-pr4-payload-hash-review.md`). No code was changed here; **no todo files created**, per
the review request.

---

## Verdict

**Shippable. No P1. No correctness, security, or data-integrity regression introduced by the fix
commits** — security, data-integrity, and performance each independently passed the new code:

- **Pairing holds on every persisted path.** `payload_version` is `Some` exactly when `payload_hash`
  is `Some` — both set together in one `match` arm in `open_reservation`, never touched by
  `authorize`/`settle_confirmed`/`release_failed`/`reconcile`. `cid`/hash/version in the 3-tuple ==
  what's persisted == what's emitted. (data-integrity, security)
- **`remove_recipient_allowlist` is clean.** Owner-gated, task-checked, idempotent, touches only the
  allowlist map — no reclaim-on-revoke, already-`Reserved` commitments settle normally
  (honest revocation, matches `revoke_delegate`). (security, data-integrity, pattern)
- **`payload_version` append is layout-correct** (appended last, matches the `active_crew`
  precedent); event additions follow the field-name-is-contract convention. (architecture, pattern)
- **Still ~0 cost.** Added work is <0.01 Tgas; the single-alloc `to_writer` is strictly cheaper than
  before; `payload_version` adds 1–3 borsh bytes/commitment; `sha2` stays test-only. (performance)
- **The EVM `match` arm is correct defensive scaffolding** — unreachable today (`build_near_payload`
  rejects non-`NearNative` first), forces Prompt 12 to pick a scheme at the hash site. (security, architecture)

**The one theme worth acting on** is the `payload_scheme()` **verifier surface**. Round 1's gap was
"the scheme is Rust-source-only." The fix added the view — but three reviewers independently find the
view *still insufficient* to re-derive from on-chain reads alone, plus chain-blind and ambiguously
named. Note this revisits the exact 4-field DTO shape that was **owner-approved** during the fix round,
so expanding it is a deliberate call to make, not a defect to silently patch.

### Dissent / severity note
The **agent-native** reviewer rated the "`payload_scheme()` omits the preimage field schema" finding
**P1** (it gates the stated source-free re-derivation goal). Synthesis keeps it **P2**: the layout is
pinned by a load-bearing test and fully documented, the Rust-linking test oracle and the same-monorepo
TS verifier can re-derive today, and no correctness/security property is at risk — but it is the
headline actionable item and is flagged, not buried.

---

## Resolution log (applied 2026-11-04)

All **4 P2 + 7 P3** addressed across **6 commits** (one per issue/cluster, no AI trail). Final state:
`make lint` clean, `make build` green, **56 tests** (36 lib + 8 delegates + 12 payments), 0 failures.
The `payload_scheme()` reshape (P2-1/2/3) was owner-confirmed as the "full self-describing DTO".

| # | Sev | Outcome | Commit | Note |
|---|-----|---------|--------|------|
| P2-1 | 🟡 | ✅ Fixed | `e27e15a` | Added a `preimage` descriptor to `PayloadScheme` stating the full composition rule (domain is a RAW PREFIX, ordered tuple, recipient-as-string, excluded fields) — a non-Rust verifier now re-derives from on-chain alone. |
| P2-2 | 🟡 | ✅ Fixed | `e27e15a` | Added `chain: "near-native"` so EVM (Prompt 12) is a sibling scheme, not a breaking view change. Current-version-only: the view describes the live version; per-commitment `payload_version` identifies historical anchors (registry deferred, now non-breaking). |
| P2-3 | 🟡 | ✅ Fixed | `e27e15a` | Renamed `hash`→`hash_algorithm`; `chain`/`hash_algorithm`/`encoding`/`preimage` all sourced from new `payload::` constants so the view can't drift from the implementation. |
| P2-4 | 🟡 | ✅ Fixed | `234d82f` | New `is_recipient_allowed(task_id, account_id)` view (twin of `assert_allowlisted`), read-parity with `is_delegate_authorized`; test covers allowlisted/outsider/after-removal. |
| P3-1 | 🔵 | ✅ Fixed | `49b1b21` | Unit test locks the `payload_hash`/`payload_version` both-or-neither invariant at the pure-core level; the both-Some side is covered by the integration test. (Structural `Option<PayloadAnchor>` not taken — append-only discipline; the test is the agreed lock.) |
| P3-2 | 🔵 | ✅ Fixed | `17eb409` | Merged the two ~80%-duplicate re-derivation sandbox tests into one view-driven proof (re-derives from the view output alone). |
| P3-3 | 🔵 | ✅ Fixed | `4edc72d` | `canonical_payload_bytes` (+ `PAYLOAD_PREIMAGE_SPEC`) is now the single source of the layout; module doc + `Commitment.payload_hash` doc point to it instead of restating the formula. |
| P3-4 | 🔵 | ✅ Fixed | `4edc72d` | Corrected the stale `PAYLOAD_VERSION` doc (the field is persisted per-commitment NOW, not "from the first bump"). |
| P3-5 | 🔵 | ✅ Fixed | `4edc72d` | Trimmed the EVM-arm comment (~7→3 lines); right-sized the capacity hint to the 162-byte worst-case body (no realloc), with the arithmetic documented. |
| P3-6 | 🔵 | ✅ Fixed | `b80c6e4` | Documented the additive-event-field convention (add under same `event_version` OK; rename/remove needs a bump). Event `payload_version` kept for commitment/event symmetry. |
| P3-7 | 🔵 | ◑ Partial / reasoned | `17eb409` | Fixed: the stray `P2-3:` test-doc prefix (dropped in the P3-2 merge). No-change (reasoned): `PayloadScheme` stays in `lib.rs` (it's a `#[near]`-layer view DTO, not pure-core scheme state); `PaymentReconciled` variant order is immaterial for JSON events; `payload_scheme()`'s throwaway hex `String`s are on a free view path. |

**Forward work (unchanged, not in this PR):** the TS indexer verifier consuming `payload_scheme()` +
a shared Rust↔TS golden vector in CI (off-chain half of P2-3); an on-chain scheme registry only if a
second `PAYLOAD_VERSION` ever ships.

---

## Findings

| # | Sev | Area | Finding | Location |
|---|-----|------|---------|----------|
| P2-1 | 🟡 | agent-native / arch / security | `payload_scheme()` is **insufficient for source-free re-derivation**: it omits the ordered preimage field list, the `AccountId`-encoded-as-`String` rule, the excluded fields, and the domain-**prefix** framing — and `encoding:"borsh"` misleads (the preimage is `domain ‖ borsh(tuple)`, not all-borsh). (agent-native rated P1.) | `lib.rs:122-131,163-170` |
| P2-2 | 🟡 | architecture / security | `payload_scheme()` is **chain-blind and current-version-only**: a nullary view returning one NEAR scheme. Extending for EVM (Prompt 12) or a post-bump historical lookup is a **breaking** change to a public view/DTO. Cheapest to shape now (unreleased). | `lib.rs:122-131,163-170` |
| P2-3 | 🟡 | pattern / architecture | `PayloadScheme.hash` JSON key holds an *algorithm name* but reads as a sibling of `payload_hash` (a digest). Rename to `hash_algorithm`; and source `hash`/`encoding` from `payload::` constants, not hand-typed literals, so they can't drift from the implementation. | `lib.rs:127,167-168` |
| P2-4 | 🟡 | agent-native | **No `is_recipient_allowed(task, recipient)` view** — the allowlist has write-parity (`set`/`remove`) but no read-parity: an agent can't cheaply pre-flight the deny-by-default gate the way `is_delegate_authorized` lets it pre-flight delegate auth (only via a destructive `propose_payment` or event replay). A point-check mirror of `assert_allowlisted` closes it. | `lib.rs:610-618,722-724` |
| P3-1 | 🔵 | data-integrity / architecture | hash↔version pairing is enforced only by two adjacent lines + docs, not the type system. Add a test asserting `c.payload_hash.is_some() == c.payload_version.is_some()` after reserve (cheap lock). Structural `Option<PayloadAnchor{hash,version}>` would make it unbreakable (and collapse the 3-tuple), but only viable pre-first-stateful-deploy. | `types.rs:114,123`; `lib.rs:676-677` |
| P3-2 | 🔵 | simplicity | `payload_hash_recorded_and_independently_rederivable` and `payload_scheme_view_lets_a_nonrust_client_rederive` are ~80% the same sandbox test (same oracle; only the scheme source differs). Merge into one — unlike the unit/integration oracles, there's no independence rationale separating them. | `tests/payments.rs` |
| P3-3 | 🔵 | simplicity | The hash formula / wire layout is restated in **4** prose sites (module doc, `canonical_payload_bytes` doc, `PayloadScheme` doc, `Commitment.payload_hash` doc). Designate `canonical_payload_bytes` the single source; others point to it. (Round 1 trimmed doc essays; the fixes re-grew a parallel set.) | `payload.rs`, `lib.rs`, `types.rs` |
| P3-4 | 🔵 | simplicity (doc bug) | `PAYLOAD_VERSION` doc says "from the first bump, persist the version per-commitment … until then every commitment is `v1`" — **now inaccurate**: `d4149e1` persists `Some(1)` on every commitment today. Reword. | `payload.rs:37-40` |
| P3-5 | 🔵 | simplicity / performance | The `match intent.chain` EVM arm carries a ~7-line comment longer than the branch (trim to one line); and `Vec::with_capacity(PAYLOAD_DOMAIN.len() + 96)` — `96` is an unexplained guess (perf: a long task-id + 64-char implicit account can exceed it → one tiny realloc; bump to ~160 or add a note, both immaterial). | `lib.rs:656-669`; `payload.rs:109` |
| P3-6 | 🔵 | simplicity / architecture | Event `payload_version` is mildly premature (events are fire-and-forget JSON, no append constraint; always `1` today) — kept for commitment/event symmetry, borderline. Separately: `PaymentReserved` grew two fields under the same `event_version("1.0.0")`; document the "additive-under-fixed-version is allowed" convention so Prompt 12 follows it. | `events.rs:52-57` |
| P3-7 | 🔵 | pattern / performance | Minor: `PayloadScheme` DTO defined in `lib.rs` while the scheme it mirrors lives in `payload.rs` (author's call — JSON DTO is a `#[near]`-layer concern vs keeping scheme in one module); `PaymentReconciled` enum variant ordering; the `P2-3:` ticket prefix on a test doc is a reference-style outlier; `payload_scheme()` builds 32 throwaway `String`s on a free view path (irrelevant). | various |

**Protected-artifact note:** no finding recommends touching `docs/plans/` or `docs/solutions/`.

---

## Finding detail (P2 — the `payload_scheme()` verifier surface)

The round-1 objective was: *an off-chain verifier re-derives `payload_hash` from on-chain reads, no
repo access.* The fix added `payload_scheme() → {domain_hex, version, hash, encoding}` and
`payload_version` on the commitment/event. That closes **which inputs** (task, cid, recipient, amount
via `get_commitment`/event) and **which version** produced a hash. It does **not** yet close **the
composition rule**:

- **P2-1 — the layout is still source-only.** `encoding:"borsh"` doesn't tell a non-Rust verifier the
  ordered tuple `(u16, String, u64, String(AccountId), u128)`, that `AccountId` serializes as a borsh
  `String`, that `token`/`delegate`/`memo` are *excluded*, or that the 32-byte domain is a **raw
  prefix outside** the borsh body. Today those live only in `canonical_payload_bytes` + its doc. A
  verifier would have to guess or read the Rust. **Fix options:** add an ordered
  `fields: [{name,type}]` + a `domain_framing:"prefix"` marker to the DTO, or a single machine-readable
  `preimage` descriptor (e.g. `"domain32 || borsh(u16,string,u64,string,u128)"`).
- **P2-2 — chain-blind + current-version-only.** The DTO is a single NEAR scheme with no `chain`
  discriminator and no per-version lookup. Prompt 12's EVM scheme (keccak/RLP) has nowhere to go, and
  after a `PAYLOAD_VERSION` bump a verifier holding a `payload_version:1` anchor can't fetch v1's
  params. Both extensions are breaking to the current signature/DTO. **Fix options:** name it
  `near_payload_scheme()` to scope it honestly, or add a `chain` field (NEAR row self-describing, EVM a
  sibling) and a `payload_scheme(version: Option<u16>)` form / small on-chain registry.
- **P2-3 — ambiguous JSON key.** `scheme.hash:"sha256"` vs `commitment.payload_hash:[…]` — rename to
  `hash_algorithm`; derive the string from a `payload::` constant so it tracks `env::sha256_array`.

**Caveat for the author:** the 4-field DTO was the owner-approved shape in the fix round. Expanding it
(P2-1/P2-2/P2-3) is a product decision about how self-describing the on-chain verifier contract should
be — reasonable to do now while the DTO is unreleased, or to defer to the Prompt-12 / indexer work
with the layout carried in a shared spec + a Rust↔TS golden vector instead. Flagging, not prescribing.

**P2-4 — allowlist read-parity.** Add `is_recipient_allowed(task_id, account_id) -> bool` (a trivial
mirror of the private `assert_allowlisted`), so an agent/dashboard can observe the recipient-confinement
gate before proposing — the same pre-flight `is_delegate_authorized` already gives for delegate auth.

---

## Stakeholder & scenario notes (condensed)

- **Developer:** new surface is symmetric and discoverable (`set`/`remove`, `payload_scheme()`,
  `payload_version` on the same types). The 4× formula prose (P3-3) is the main readability drag.
- **Operations:** no new deploy risk; wasm flat; `payload_version` append is migration-free only on
  fresh state (documented). `remove_recipient_allowlist` is the operational revocation lever ops asked for.
- **End user / agent:** can now read `payload_version` + `payload_scheme()`; still can't (a) fully
  re-derive without the layout (P2-1) or (b) read allow-state without proposing (P2-4).
- **Security:** attack surface re-reviewed on the new code — no blind-sign path, owner-gates intact,
  honest revocation, pairing invariant holds. No new risk.
- **Scenarios:** happy/invalid/boundary all covered; refusals burn no cid; removed-recipient refusal
  proven; Evm arm unreachable+panics; append-migration only matters post-first-stateful-deploy.

---

## Next steps (author's call — nothing applied)

1. **Decide the `payload_scheme()` surface (P2-1/P2-2/P2-3).** Either enrich the DTO now (ordered
   `fields` + `domain_framing` + `chain` + `hash_algorithm`, version-parameterized) so it truly meets
   the source-free goal, or consciously keep it minimal and move the layout contract to a shared
   off-chain spec + Rust↔TS golden vector. This is the round-2 headline.
2. **`is_recipient_allowed` view (P2-4)** — small, closes the read-parity asymmetry.
3. **P3 quick wins if touching the branch:** the `is_some()==is_some()` lock test (P3-1), merge the two
   re-derivation tests (P3-2), fix the now-inaccurate `PAYLOAD_VERSION` doc (P3-4), single-source the
   formula (P3-3), trim the EVM-arm comment (P3-5).
4. None blocks merge. If merging as-is, record P2-1..P2-4 as tracked follow-ups (several are cheapest
   *before* Prompt 12 / the indexer land).
