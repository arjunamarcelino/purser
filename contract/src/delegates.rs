//! Delegate (crew) membership logic (BACKEND-SCHEMA §1.2, §1.4; APP-FLOW §4, §9).
//!
//! This module is the *behavioral* half of the Prompt-3 control plane; the stateful,
//! `env`-reading `#[near]` entrypoints live in [`crate::lib`] (`impl Purser`), and the
//! NEP-297 events in [`crate::events`]. Mirroring the Prompt-2 pure core, the logic here
//! is a **free function over a borrowed collection** ([`is_authorized`]) with the caller
//! injected as a parameter — it reads neither `env` nor `self`, so the entrypoint stays
//! the single `env`/store boundary and this stays trivially reasoned-about.
//!
//! Authorization model (operator gate, resolved): **registry + predecessor**. A delegate
//! is authorized iff it is a *registered, active* member of the task; the contract issues
//! no access keys. See [`crate::types::Delegate`] and the README "Honest revocation" note.

use crate::types::{Delegate, TaskId};
use near_sdk::store::IterableMap;
use near_sdk::AccountId;

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
