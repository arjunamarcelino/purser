# packages/types

**Canonical owner of the contract↔TypeScript type boundary.**

The Purser contract (Rust/near-sdk) is the source of truth for `PaymentIntent`, `Commitment`,
`ReservationState`, `IdemState`, `TaskBudgetView`, etc. (see `docs/PURSER-BACKEND-SCHEMA.md` §1.2).
To avoid four-way drift, every TypeScript service — `app`, `proposer`, `indexer`, `relayer` —
imports these types from here and does **not** hand-mirror them.

Generated from the contract ABI (`contract/target/near/purser_contract_abi.json`, emitted by
`cargo near build`). The ABI→TS codegen is wired in when the first TS service lands; until then this
package is a reserved placeholder so the ownership decision is explicit, not accidental.

## Refusal wire contract (frozen)

`propose_payment` and `reconcile` refuse by panicking with one of these exact strings (pinned by
`contract/src/error.rs::msg_constants_are_frozen`). Clients match on the substring and act by its
retry class:

| Message | Retry class | What the client should do |
|---|---|---|
| `in-flight` | **wait** | The same request is still settling. Poll `get_idempotency(account, request_id)`; never resend with a new id. |
| `already failed` | terminal | The request failed safely before any payment. Start a new request with a fresh `request_id`. |
| `request_id reused with a different request` | terminal | The `request_id` already settled a *different* request (task, recipient, amount or memo differ; an empty memo equals no memo). Use a fresh `request_id`. |
| `exceeds task budget` | terminal for this amount | The cap leaves too little headroom. Retrying the same request is refused again until budget is released. |
| `task frozen` | terminal | A settlement contradicted an owner reconcile and the task went over cap; it authorizes nothing more. |
| `delegate not authorized` | terminal | The caller is not an active delegate (e.g. revoked). |
| `recipient not allowlisted` / `invalid recipient` | terminal | Fix the recipient; the owner manages the allowlist. |
| `amount must be positive`, `unsupported chain`, `unsupported token`, `memo too long`, `invalid request_id`, `invalid task_id` | terminal | Malformed request. |
| `reconcile too early` | **retry later** | Owner only: the commitment is younger than `get_config().reconcile_min_age_ns`. |
| `not reconcilable`, `no such commitment`, `only owner` | terminal | Owner-path refusals. |

Limits (`max_request_id_len`, `max_memo_len`, `max_task_id_len`) and the reconcile time-lock are
read from the `get_config()` view; do not hard-code them.

Events a client may also see: `reconcile_contradicted { attested, transfer_succeeded, frozen }`
means the chain proved an owner reconcile wrong; the books follow the chain.
