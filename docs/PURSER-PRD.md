# Purser — Product Requirements Document (PRD)

> **One budget. Many agents. Nothing overspent.**
> Status: v1 (hackathon) · Owner: product · Last updated: 2026-10-28 · Event: NEAR HACKATHON (build Nov 1–14, 2026)

**Companion docs:** `PURSER-TRD.md` (technical requirements) · `PURSER-BACKEND-SCHEMA.md` · `PURSER-APP-FLOW.md` · `PURSER-DESIGN-BRIEF.md` · `PURSER-IMPLEMENTATION-PLAN.md` · `PURSER-BUSINESS.md` (market narrative).

---

## 1. Summary

Purser is an on-chain spending controller that lets a **crew of AI agents** draw from **one shared, capped budget** while a NEAR smart contract enforces, at every moment and across failures, the invariant:

> **completed spending + outstanding authorized commitments ≤ task budget.**

The agents (LLM-driven or not) only *propose* payments; all authority and all limits live in the contract, outside the agents' trust domain. This turns "give an agent a wallet" into "give a crew a governed budget" — the missing safety primitive for the agentic economy.

- **Primary track:** `security` (AI Security & Defense). **Also:** `swarms`, `agents`.
- **Primary user (ICP):** teams building AI agent platforms/frameworks who need to let their users fund agents safely.
- **MVP surface:** one token, three delegate agents, one shared budget, NEAR-native execution; one EVM path as a cuttable stretch.

---

## 2. Problem statement

Autonomous agents are starting to spend real money (data, compute, APIs, services). Today's controls fail in three specific ways:

1. **The limit lives in the wrong trust domain.** Spending caps are enforced inside the agent's own runtime (config, prompt, SDK guard). Anything in the agent's trust domain — a bug, a jailbreak, a compromised tool — can bypass it. A limit the spender enforces on itself is not a limit.
2. **No one governs a *shared* budget across *multiple* agents.** Real deployments run crews. When several agents draw on one budget concurrently, naïve controls double-spend: each checks the balance, each sees enough, each spends.
3. **Controls break at the moment that matters — failure.** On a timed-out payment, did it fail or is it still in flight? On revocation, are already-authorized payments revoked too? Most systems optimistically release holds and silently overspend.

**Opportunity:** be the primitive that makes agent spending *safe* — the governed budget layer the market is about to require, aligned exactly with NEAR's "hardware-enforced security" agent requirement.

---

## 3. Goals & non-goals

### Goals (what success looks like)
- G1. Enforce the budget invariant on-chain, provably, **including under concurrency, retries, timeouts, and revocation**.
- G2. Let 2+ agents share one budget with correct accounting under genuine contention.
- G3. Make the security guarantee a **property of the contract**, independent of model behavior — demonstrable with reproducible tests.
- G4. Ship a live testnet demo that shows a legitimate spend succeeding and the adversarial cases each refused or safely handled (concurrent over-budget, duplicate/in-flight retries, tampered recipient, revoked agent, timeout), each with verifiable on-chain evidence.
- G5. Never blind-sign: the contract authorizes only transactions it constructs/validates.
- G6. Be honest about limits (issued signatures can't be recalled; cross-chain confirmation needs a named relayer attestation).

### Non-goals (explicitly out of scope for v1)
- N1. Multi-token budgets or USD-denominated caps with a price oracle. (One token only.)
- N2. A production indexer / analytics warehouse. (Thin off-chain cache only.)
- N3. Mainnet deployment or moving real user funds. (Testnet only.)
- N4. A full agent framework. (Purser governs agents; it is not the agent runtime.)
- N5. More than one external chain. (NEAR-native core; one EVM path is stretch.)
- N6. Reputation/credit scoring of agents (a natural v2, not v1).

---

## 4. Target users & personas

| Persona | Role | Needs from Purser |
|---|---|---|
| **Platform engineer** (primary ICP) | Builds an agent platform/framework | A drop-in, on-chain budget layer their users can trust; an SDK and a clear invariant; failure-safe accounting they don't have to reinvent. |
| **Budget owner / operator** | Sets and supervises a crew's budget | Set a cap, authorize agents, watch live spend, and kill an agent instantly. A legible audit trail. |
| **Agent (non-human actor)** | Proposes & requests payments | A simple "propose_payment" call; clear accept/refuse responses; no ability (by design) to exceed authority. |
| **Judge / auditor** (hackathon) | Evaluates the submission | A README with do-X-see-Y steps, reproducible tests, verifiable tx references, and an honest-limits section. |

---

## 5. User stories & acceptance criteria

> Format: *As a [persona], I want [capability], so that [outcome].* AC = acceptance criteria.

### Epic A — Budget & crew setup
- **A1.** As a budget owner, I want to create a task budget (token + cap) so a crew can spend against it.
  - AC: `create_task` initializes a budget with `completed=0, outstanding=0`; only the owner can create; invariant holds.
- **A2.** As a budget owner, I want to authorize up to N agents as delegates so they can propose payments.
  - AC: `add_delegate` registers an agent; an unregistered account's proposals are refused; only the owner can add.
- **A3.** As a budget owner, I want to set a recipient allowlist so payments can only go to approved destinations.
  - AC: proposals to non-allowlisted recipients are refused before any signing.

### Epic B — Governed spending
- **B1.** As an agent, I want to propose a payment so that an approved purchase executes.
  - AC: a legit, within-budget, allowlisted payment succeeds; remaining budget decreases by the amount; a verifiable tx reference is produced.
- **B2.** As a budget owner, I want concurrent over-budget proposals to be refused so the crew can never exceed the cap.
  - AC: given remaining R and k concurrent proposals each of amount a with k·a > R, exactly ⌊R/a⌋ succeed and the rest are refused; invariant holds throughout; the race is genuinely concurrent.
- **B3.** As an agent/platform, I want retries to be safe so network flakiness never double-charges.
  - AC: re-sending the same `request_id` after completion returns the original result and never creates a second authorization; a retry while the first is in-flight returns "in-flight" and opens no second reservation.

### Epic C — Integrity & failure handling
- **C1.** As a budget owner, I want tampered payments rejected so an agent can't redirect funds.
  - AC: a proposal whose recipient/amount doesn't match what the contract constructs is rejected ("payload mismatch").
- **C2.** As a budget owner, I want to revoke an agent instantly so a rogue agent is stopped.
  - AC: after revocation, new proposals from that agent are blocked; the UI/doc states revocation cannot recall already-issued signatures.
- **C3.** As a budget owner, I want timeouts handled conservatively so uncertainty never causes overspend.
  - AC: a signed payment that times out keeps its reservation (moves to `Unknown`, not released); budget is only reclaimed on proof of outcome.

### Epic D — Visibility & evidence
- **D1.** As an operator, I want a live manifest (task, remaining, holds, payments) so I can supervise the crew.
  - AC: dashboard reflects real contract state; every payment links to a testnet explorer tx.
- **D2.** As a judge, I want reproducible proof so I can trust the claim.
  - AC: one command runs property-based invariant tests + the attack suite, all green; one command runs the full live demo on testnet.

### Epic E — Agent intelligence (proposer)
- **E1.** As a platform, I want agents to propose *useful* purchases via NEAR AI Cloud so the demo is realistic.
  - AC: three proposer personas generate structured intents; an over-budget AI proposal is still refused by the contract (proving safety ≠ model quality).

### Epic F — Cross-chain (STRETCH, cuttable by Day 8)
- **F1.** As a budget owner, I want one governed EVM payment so the control extends across chains.
  - AC: an EVM-testnet payment executes via Chain Signatures under the same invariant; a stuck tx stays reserved until a relayer-attested cancel, then releases. If not enforceable by Day 8, this epic is cut and the README stays NEAR-native.

---

## 6. Functional requirements

| # | Requirement | Priority |
|---|---|---|
| FR1 | Create/configure a task budget (token, cap, owner). | P0 |
| FR2 | Register/revoke delegate agents; enforce authorization on every proposal. | P0 |
| FR3 | `propose_payment(task, intent, request_id)` with **atomic reserve-before-sign**. | P0 |
| FR4 | Tri-state idempotency keyed by `request_id` (Pending/Committed/Failed). | P0 |
| FR5 | In-contract payload construction + recipient allowlist; reject tampering. | P0 |
| FR6 | Conservative settlement: reclaim only on proof; retain on timeout/unknown. | P0 |
| FR7 | Live manifest view methods + dashboard (task, remaining, holds, payments). | P0 |
| FR8 | Property-based invariant tests + 7-case attack suite. | P0 |
| FR9 | AI proposer on NEAR AI Cloud (3 personas); attestation surfaced if available. | P1 |
| FR10 | Testnet deploy + one-command reproducible demo. | P0 |
| FR11 | Thin off-chain cache for dashboard history + relayer queue + attestation logs. | P1 |
| FR12 | EVM external path via Chain Signatures + nonce-burn reclaim. | P2 (stretch) |

Priority key: **P0** = required to win the track · **P1** = strongly desired · **P2** = stretch/cuttable.

---

## 7. Non-functional requirements

- **Security/correctness (highest):** the invariant must never be observably violated; all state transitions preserve it. The AI is untrusted; safety is deterministic.
- **Reproducibility:** every claim backed by a test or a verifiable tx. Metrics measured on our harness, never asserted.
- **Honesty/integrity:** vulnerable baseline is labeled as a naïve implementation; no simulation portrayed as a live exploit against a competitor; cross-chain trust assumptions named.
- **Performance:** per-authorization latency and gas measured and reported; should be demo-smooth on testnet.
- **Safety of operations:** testnet only; no secrets in the repo; no mainnet signing.
- **Usability:** an operator can set up a budget and run the demo in minutes; a judge can reproduce with one command.

---

## 8. Success metrics (measured, not claimed)

| Metric | Target |
|---|---|
| Budget overruns across concurrent test runs | **0** |
| Duplicate authorizations (same `request_id`) | **0** |
| Valid, within-budget requests wrongly blocked | 0 (track if any) |
| Invariant violations observed in property tests | **0** across all generated sequences |
| Attack suite pass rate | 7/7 |
| Added latency per authorization | measured & reported |
| Gas cost per authorization | measured & reported |
| Live demo reproducibility | `deploy-testnet.sh && demo.sh` reproduces all outcomes from clean |

---

## 9. Scope by phase (MVP → stretch)

| Tier | Contents |
|---|---|
| **Core (P0)** | Budget, crew, atomic reserve-before-sign, idempotency, payload/allowlist, conservative settlement, NEAR-native execution, tests, dashboard, testnet demo. |
| **Desired (P1)** | AI proposer + attestation surfacing, off-chain cache & richer manifest history, metrics harness. |
| **Stretch (P2, cuttable)** | One EVM path via Chain Signatures, relayer with attested confirmation, nonce-burn reclaim. |

---

## 10. Assumptions, dependencies, constraints

- **Assumptions:** NEAR testnet, `v1.signer-prod.testnet`, NEAR AI Cloud, and chainsig.js are available and stable during the build window.
- **Dependencies:** near-sdk (Rust) 5.30.x; Chain Signatures MPC signer; NEAR AI Cloud API; near-api-js + wallet-selector; chainsig.js (stretch). *(Pin and re-verify versions/endpoints at build start — see TRD.)*
- **Constraints:** two-week build; testnet only; one token; do **not** use the deprecated Shade Agent Framework; never commit secrets.

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Concurrency correctness is subtle | Core claim fails | Make reserve-before-sign + tri-state idempotency the first and most-tested code; property tests. |
| EVM path not enforceable in time | Overclaiming | Day-1 feasibility spike; Day-8 hard cut; keep README NEAR-native by default. |
| "Infra is unexciting" to human judges | Lower score | Lead the demo with a felt customer story + rogue-agent moment. |
| Very fresh SDK (5.30.0) churn | Build breakage | Pin exact version; re-verify at build start; keep an upgrade note. |
| NEAR AI Cloud API specifics unverified | Integration delay | Treat proposer as P1; verify endpoint/auth at docs.near.ai Day 1; contract works without it. |

---

## 12. Open questions (resolve at build start)

- Full function-call-key provisioning per delegate vs. registry-based authorization for the MVP? (TRD proposes a default; confirm Day 1.)
- Exact NEAR AI Cloud base URL / auth header / model id / attestation flow (verify at docs.near.ai).
- Current near-api-js major version and wallet-selector React pattern (verify Day 1).
- Does the deployed `v1.signer-prod.testnet` sign response match the in-dev shape? (verify before relying on it — stretch only.)

---

## 13. Release / definition of done

**Done (submittable) when:**
- All P0 functional requirements pass their acceptance criteria on testnet.
- Property + 7 attack tests green from a clean checkout.
- `deploy-testnet.sh && demo.sh` reproduces the full narrative with verifiable tx refs.
- README (machine-readable, do-X-see-Y) with an honest-limits section.
- Metrics measured and recorded.
- Submission package prepared (human performs the submission per `PURSER-BUILD-PROMPTS.md` Prompt 15).
