//! NEP-297 structured events for the off-chain indexer (BACKEND-SCHEMA §2.3).
//!
//! JSON-only (never stored), so — unlike the Borsh types in [`crate::types`] — these carry
//! no layout-freeze obligation. Their *field names* ARE the indexer's contract, though, so
//! treat them as frozen. Emitted via `PurserEvent::_.emit()` at the tail of each mutating
//! entrypoint, AFTER state is written. The SDK macro serializes each variant to the
//! canonical `EVENT_JSON:{"standard":"purser","version":"1.0.0","event":"<snake_case>",
//! "data":{…}}` line (the variant name is lower-snake-cased into `event`).
//!
//! Lives in its own module (not `delegates`) because the set spans task *and* delegate
//! lifecycles — and Prompt 4 adds payment events here too.

use crate::types::{TaskId, TokenSpec};
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
}
