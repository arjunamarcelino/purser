//! NEP-297 structured events for the off-chain indexer (BACKEND-SCHEMA §2.3).
//!
//! JSON-only (never stored), so — unlike the Borsh types in [`crate::types`] — these carry
//! no layout-freeze obligation. Their *field names* ARE the indexer's contract, though, so
//! treat them as frozen. CONVENTION: ADDING a field under the same `event_version` is allowed
//! (indexers must tolerate unknown fields); RENAMING or REMOVING one is a breaking change that
//! needs a version bump. Emitted via `PurserEvent::_.emit()` at the tail of each mutating
//! entrypoint, AFTER state is written. The SDK macro serializes each variant to the
//! canonical `EVENT_JSON:{"standard":"purser","version":"1.0.0","event":"<snake_case>",
//! "data":{…}}` line (the variant name is lower-snake-cased into `event`).
//!
//! Lives in its own module (not `delegates`) because the set spans task *and* delegate
//! lifecycles — and Prompt 4 adds payment events here too.

use crate::types::{CommitmentId, RequestId, TaskId, TokenSpec};
use near_sdk::{near, AccountId, NearToken};

#[near(event_json(standard = "purser"))]
pub enum PurserEvent {
    #[event_version("1.0.0")]
    TaskCreated {
        task_id: TaskId,
        owner: AccountId,
        cap: NearToken,
        /// The budget's token denomination — a `NOT NULL` column in the indexer `task`
        /// table, so the event must carry it for an event-only row hydration.
        token: TokenSpec,
        crew_cap: u8,
    },
    #[event_version("1.0.0")]
    DelegateAdded {
        task_id: TaskId,
        account_id: AccountId,
    },
    /// Emitted only when a revoke actually deactivates a delegate (never on an
    /// idempotent re-revoke), so the event stream carries no phantom revocations.
    #[event_version("1.0.0")]
    DelegateRevoked {
        task_id: TaskId,
        account_id: AccountId,
    },
    /// A reservation was admitted (Prompt 4). Emitted in the synchronous prefix of
    /// `propose_payment`, AFTER the reserve + idempotency writes and BEFORE the transfer
    /// Promise — the only correct place, since the Promise performs no synchronous state write.
    #[event_version("1.0.0")]
    PaymentReserved {
        task_id: TaskId,
        commitment_id: CommitmentId,
        delegate: AccountId,
        recipient: String,
        amount: NearToken,
        request_id: RequestId,
        /// The contract-constructed audit anchor (`sha256` of the domain-separated preimage),
        /// carried so an event-only indexer can hydrate it without a `get_commitment` call —
        /// same 32-byte array the `get_commitment` view returns. Re-derive via `payload_scheme()`.
        payload_hash: [u8; 32],
        /// The scheme version `payload_hash` was computed under — so the event stays re-derivable
        /// across a future `PAYLOAD_VERSION` bump (mirrors `Commitment.payload_version`).
        payload_version: u16,
    },
    /// A reservation settled on a proven-successful transfer (`on_near_settled`). Carries no
    /// `near_tx`: the contract cannot observe its own receipt id on-chain, so the indexer
    /// backfills the tx hash off-chain (correlating by `commitment_id` / `request_id`).
    #[event_version("1.0.0")]
    PaymentConfirmed {
        task_id: TaskId,
        commitment_id: CommitmentId,
        request_id: RequestId,
        actual_spent: NearToken,
    },
    /// A reservation was released because the transfer failed before any value moved
    /// (`on_near_settled`); the budget is returned.
    #[event_version("1.0.0")]
    PaymentFailed {
        task_id: TaskId,
        commitment_id: CommitmentId,
        request_id: RequestId,
        reason: String,
    },
    /// Owner added recipients to a task's payee allowlist (Prompt 4; refined in Prompt 5).
    #[event_version("1.0.0")]
    RecipientAllowlistSet {
        task_id: TaskId,
        recipients: Vec<String>,
    },
    /// Owner removed recipients from a task's payee allowlist (honest revocation of a payee).
    /// Idempotent: lists the recipients the owner requested removed, whether or not each was present.
    #[event_version("1.0.0")]
    RecipientAllowlistRemoved {
        task_id: TaskId,
        recipients: Vec<String>,
    },
    /// Owner reconciled a commitment stuck in `Reserved` (settlement callback lost): `confirmed`
    /// records the owner-attested on-chain transfer outcome — `true` → settled `Confirmed`,
    /// `false` → safe-released `Failed`. Distinct from the callback-driven `Payment*` events so the
    /// indexer can tell an owner recovery apart from the normal lifecycle.
    #[event_version("1.0.0")]
    PaymentReconciled {
        task_id: TaskId,
        commitment_id: CommitmentId,
        request_id: RequestId,
        confirmed: bool,
    },
    /// A settlement callback contradicted an owner `reconcile`: `attested` is what the owner
    /// claimed (`confirmed`), `transfer_succeeded` is what the chain proved. `frozen` reports
    /// whether recording the proven spend froze the task.
    #[event_version("1.0.0")]
    ReconcileContradicted {
        task_id: TaskId,
        commitment_id: CommitmentId,
        request_id: RequestId,
        attested: bool,
        transfer_succeeded: bool,
        frozen: bool,
    },
}
