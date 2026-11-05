# packages/types

**Canonical owner of the contract↔TypeScript type boundary.**

The Purser contract (Rust/near-sdk) is the source of truth for `PaymentIntent`, `Commitment`,
`ReservationState`, `IdemState`, `TaskBudgetView`, etc. (see `docs/PURSER-BACKEND-SCHEMA.md` §1.2).
To avoid four-way drift, every TypeScript service — `app`, `proposer`, `indexer`, `relayer` —
imports these types from here and does **not** hand-mirror them.

`src/generated.ts` is generated from the contract ABI (`contract/target/near/purser_contract_abi.json`,
emitted by `cargo near build`) and committed. Regenerate with `make types-gen`; CI regenerates it from
the freshly built ABI and fails on any diff. The package is pure (no Node or network imports), so the
browser dashboard can bundle it.

| Module | What it holds |
|---|---|
| `generated.ts` | Every ABI type, `PurserViews` / `PurserCalls` (args + result per method), `VIEW_METHODS`, `CALL_METHODS`, `U64_BIGINT_FIELDS` |
| `brands.ts` | `YoctoString`, `CommitmentId`, `RequestId`: wire values branded at the one place they are validated |
| `refusals.ts` | The frozen table below as code: `REFUSALS`, `classifyRefusal(raw)` (exact match, never substring) |
| `records.ts` | zod schemas for the off-chain JSONL records (`ProposalRecord`, `Evidence`). Readers must validate: they are written by untrusted processes |

Wire details the ABI cannot express:

- `NearToken` is a bare JSON string in the ABI, so generated fields are `string`; amounts are built as
  `YoctoString` (decimal yoctoNEAR, within u128).
- Block timestamps (`created_at`, `updated_at`, `added_at`) are plain `u64` JSON numbers around 1.7e18,
  beyond 2^53. A plain `JSON.parse` silently rounds them. They are typed `bigint`; parse view results with a
  reviver keyed on `U64_BIGINT_FIELDS`.

Do not use `near-abi-client-js`: the npm name is a malware placeholder. Codegen uses
`json-schema-to-typescript` on the ABI's `body.root_schema`.

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
