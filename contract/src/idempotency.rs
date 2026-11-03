//! Tri-state idempotency classification (TECHNICAL §6).
//!
//! The tri-state entry type [`crate::types::IdemState`] (`Pending | Committed |
//! Failed`) is on-chain state, keyed by `(AccountId, RequestId)` — the predecessor
//! (proposing delegate) plus the client request id, so a co-delegate cannot squat
//! another's `request_id`. This module provides the pure decision over that entry;
//! the `LookupMap<(AccountId, RequestId), IdemState>` store and its writes
//! (`None -> Pending` in the same atomic step as the reserve, `Pending -> Committed`
//! on settle, `Pending -> Failed` on safe failure) are the contract layer's job (`lib.rs`).
//!
//! NOTE on scope: [`classify`] proves the *classification* only. The genuine
//! in-flight RACE — two `propose_payment` calls both passing the admission check
//! before either reserves — is NOT reachable in this sequential pure core (here
//! `Pending` is just a value `classify` reads). It is exercised in the Prompt-6
//! `near-workspaces` suite with same-block / rapid-fire submission.

use crate::types::{CommitmentId, IdemState};

/// What a `propose_payment` request should do, given the stored idempotency entry
/// (or its absence).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdemDecision {
    /// No entry — proceed to reserve, then write `Pending` in the same atomic step.
    Fresh,
    /// `Pending` — the first request is still in-flight. Panic "in-flight"; do NOT
    /// open a second reservation. (The case a naive seen-set misses.)
    InFlight,
    /// `Committed` — return the prior result (exactly-once authorization).
    Replay { commitment_id: CommitmentId },
    /// `Failed` — already resolved as a safe failure; panic "already failed".
    AlreadyFailed,
}

/// Classify a stored idempotency entry into the action a retry should take.
pub fn classify(entry: Option<&IdemState>) -> IdemDecision {
    match entry {
        None => IdemDecision::Fresh,
        Some(IdemState::Pending) => IdemDecision::InFlight,
        Some(IdemState::Committed { commitment_id }) => IdemDecision::Replay {
            commitment_id: *commitment_id,
        },
        Some(IdemState::Failed) => IdemDecision::AlreadyFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Classification-only coverage (NOT invariant coverage — see module note). The
    /// in-flight race is a Prompt-6 near-workspaces concern.
    #[test]
    fn classify_covers_the_tri_state() {
        assert_eq!(classify(None), IdemDecision::Fresh);
        assert_eq!(classify(Some(&IdemState::Pending)), IdemDecision::InFlight);
        assert_eq!(
            classify(Some(&IdemState::Committed { commitment_id: 7 })),
            IdemDecision::Replay { commitment_id: 7 }
        );
        assert_eq!(
            classify(Some(&IdemState::Failed)),
            IdemDecision::AlreadyFailed
        );
    }
}
