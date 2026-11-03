//! Delegate (crew) membership logic & events (BACKEND-SCHEMA §1.2, §1.4; APP-FLOW §4, §9).
//!
//! This module is the *behavioral* half of the Prompt-3 control plane; the stateful,
//! `env`-reading `#[near]` entrypoints live in [`crate::lib`] (`impl Purser`). Mirroring
//! the Prompt-2 pure core, the logic here is a **free function over a borrowed
//! collection** ([`is_authorized`]) with the caller injected as a parameter — it reads
//! neither `env` nor `self`, so the entrypoint stays the single `env`/store boundary and
//! this stays trivially reasoned-about.
//!
//! Authorization model (operator gate, resolved): **registry + predecessor**. A delegate
//! is authorized iff it is a *registered, active* member of the task; the contract issues
//! no access keys. See [`crate::types::Delegate`] and the README "Honest revocation" note.
//!
//! [`PurserEvent`] is a JSON-only NEP-297 event enum consumed by the off-chain indexer.
//! It is never stored, so — unlike [`crate::types::Delegate`] — it carries no Borsh
//! layout-freeze obligation; its *field names* are the indexer's contract, though, so
//! treat them as frozen.

use crate::types::{Delegate, TaskId, TokenSpec};
use near_sdk::store::IterableMap;
use near_sdk::{near, AccountId};

/// Is `who` a registered, **active** delegate of `task_id`? Pure point lookup, O(1).
///
/// The single source of truth for delegate authorization: the public
/// `Purser::is_delegate_authorized` view and the `Purser::assert_delegate_authorized`
/// gate (consumed by `propose_payment` in Prompt 4) both route through here, so the rule
/// lives in exactly one place.
pub fn is_authorized(
    delegates: &IterableMap<(TaskId, AccountId), Delegate>,
    task_id: &TaskId,
    who: &AccountId,
) -> bool {
    delegates
        .get(&(task_id.clone(), who.clone()))
        .is_some_and(|d| d.active)
}

/// NEP-297 structured events for the off-chain indexer (`standard = "purser"`).
///
/// Emitted via `PurserEvent::_.emit()` at the tail of each mutating entrypoint, AFTER
/// state is written. The SDK macro serializes the variant to the canonical
/// `EVENT_JSON:{"standard":"purser","version":"1.0.0","event":"<snake_case>","data":{…}}`
/// line (variant name lower-snake-cased into `event`).
#[near(event_json(standard = "purser"))]
pub enum PurserEvent {
    #[event_version("1.0.0")]
    TaskCreated {
        task_id: TaskId,
        owner: AccountId,
        cap: near_sdk::NearToken,
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
    #[event_version("1.0.0")]
    DelegateRevoked {
        task_id: TaskId,
        account_id: AccountId,
        was_active: bool,
    },
}
