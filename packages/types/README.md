# packages/types

**Canonical owner of the contract↔TypeScript type boundary.**

The Purser contract (Rust/near-sdk) is the source of truth for `PaymentIntent`, `Commitment`,
`ReservationState`, `IdemState`, `TaskBudgetView`, etc. (see `docs/PURSER-BACKEND-SCHEMA.md` §1.2).
To avoid four-way drift, every TypeScript service — `app`, `proposer`, `indexer`, `relayer` —
imports these types from here and does **not** hand-mirror them.

Generated from the contract ABI (`contract/target/near/purser_contract_abi.json`, emitted by
`cargo near build`). The ABI→TS codegen is wired in when the first TS service lands; until then this
package is a reserved placeholder so the ownership decision is explicit, not accidental.
