# Limits and trust

What Purser does not do, what it trusts, and how authorization and revocation work. The short version is in the [README](../README.md#limits).

## Limits

- **Revocation blocks new authorizations; it cannot un-issue signatures or transactions already produced.**
  It also does not release the delegate's already-reserved budget.
- **Cross-chain confirmation relies on a named relayer attestation.** The contract cannot read Sepolia;
  absent proof, reservations stay locked (conservative accounting), and only the owner's `confirm_release`
  frees them. See the trust table in [EVM-PATH.md](EVM-PATH.md).
- **MVP scope: one token, no USD oracle, a NEAR-native core, and one optional EVM path** (Sepolia only).
- **near-sdk 5.30.0 is very fresh.** It is pinned exactly and the whole suite runs against it.
- **A signer error is not proof that no signature exists.** The MPC nodes' `respond` transaction carries the
  signature in public args even when the caller's yield timed out, so a failed signer callback keeps the
  reservation (`Unknown`), never releases it.
- **State growth is bounded, not zero.** Commitments and their idempotency entries are never pruned. Each
  task may create at most `DEFAULT_MAX_COMMITMENTS` (1000) commitments unless the owner sets another limit with
  `set_task_limits`; the cap counts every commitment ever created, including failed ones. The storage stake
  (about 0.00375 NEAR per commitment, measured) is paid from the contract's own balance.
  The cap is shared by the whole crew: one registered delegate can burn a task's slots (cheap failing or
  minimum transfers) and block the other delegates until the owner raises the limit. `min_payment` applies to
  NEAR-native payments only; EVM tasks have no minimum. `max_commitments = 0` admits nothing, the intended way
  to pause a task's new admissions. `set_task_limits` emits no event, so the board and indexer cannot see limit
  changes. `set_relayer` still scans every commitment (bounded per task by the limit, but the number of tasks is
  owner-controlled), so it stays unbounded in total.
- **Measurements are sandbox measurements.** Latency and gas in `docs/METRICS.md` come from a local nearcore
  sandbox, EVM gas from a mock signer. They are not testnet or mainnet figures.
- **Outcome 7 of the demo is a sandbox replay**, because the shipped wasm cannot lose a callback.
- **The owner is trusted.** Owner-gated calls (`reconcile`, `confirm_release`, limits, allowlists) are
  not constrained by the contract; a wrong owner attestation can overspend by up to one in-flight value per
  lane and then freezes the task.

## Authorization and revocation

**Auth model (MVP): registry + predecessor.** The owner registers delegate agents per
task; each agent authorizes from its own NEAR account. A caller is authorized only if it
is a registered, **active** delegate of the task — the contract issues no access keys, so
the budget guarantee is a property of the contract code, never of key mechanics. (Function-call
keys are an outer layer: `make deploy-testnet` gives each proposer one key limited to
`propose_payment`, and the contract's checks do not depend on it. Having the contract issue keys
itself is a documented, deferred option; see the operator gate in `docs/BUILD-START-VERIFICATION.md`.)

**State-growth limits (S8).** The owner bounds what a registered delegate can make the contract store with
`set_task_limits(task_id, min_payment, max_commitments)`; the contract also refuses any attached deposit on
`propose_payment`. Tasks that never call it get no minimum and a default of 1000 commitments.

**Revocation is honest.** `revoke_delegate` marks a crew member inactive, which blocks all
**future** authorizations immediately (the next proposal is refused) and reports whether it
actually changed state. It **cannot** un-issue or recall a signature/transaction already
produced — no on-chain mechanism can — and it does **not** release that delegate's
already-reserved (`outstanding`) budget, which stays reserved until settled or failed by the
normal lifecycle (no reclaim on silence). The dashboard greys out a revoked agent and marks
new proposals BLOCKED; the owner's revoke confirmation states that a payment or signature already made cannot be recalled.

**Operational notes.** A commitment whose settlement callback was lost stays reserved until the
owner reconciles it with the transfer's **observed final outcome** (never on silence), and
`reconcile` refuses until the commitment is 10 minutes old. NEAR does not bound receipt latency,
so the settlement callback stays authoritative even after a reconcile: if it proves a released
payment actually landed, the contract records the spend, emits `reconcile_contradicted`, and, if
that puts the task over its cap, **freezes** the task so it authorizes nothing more. The cap
invariant holds for every task that is not frozen, and only a wrong owner attestation can freeze one.

**Retries.** A retry must repeat the same request: task, recipient, amount and memo (an empty memo
counts as no memo). Reusing a settled `request_id` for anything else is refused with
`request_id reused with a different request`; generate a fresh `request_id` per payment. Never deploy Purser on
the owner's own account: `#[private]` callbacks would then accept the owner as the caller.
