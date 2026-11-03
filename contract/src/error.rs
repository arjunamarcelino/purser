//! Typed errors for the pure accounting core.
//!
//! The pure core returns `Result<_, PurserError>` so unit tests can assert the
//! *exact* rejection reason without a VM. The `#[near]` contract entrypoints
//! (Prompt 4) convert `Err` into a panic — either manually
//! (`.unwrap_or_else(|e| env::panic_str(&e.to_string()))`) or declaratively via
//! `#[handle_result]` + `#[derive(near_sdk::FunctionError)]`. The panic is what
//! rolls back all state mutations atomically: `near_sdk::store` collections flush
//! only on a clean return, so an aborted call persists nothing. A returned `Err`
//! that a caller *ignored* would NOT roll back `outstanding` — which is precisely
//! why the core is `Result` and the boundary panics.

use crate::types::ReservationState;
use near_sdk::NearToken;

/// Panic-string constants. The core's `Display` uses these, and the Prompt 6
/// attack suite asserts against the same literals — single source of truth, so
/// the messages can't drift. The numeric error fields are deliberately omitted
/// from the strings (they would leak live budget/cap state into on-chain receipts).
pub const MSG_EXCEEDS_BUDGET: &str = "exceeds task budget";
pub const MSG_SPENT_EXCEEDS: &str = "spent exceeds reserved";
pub const MSG_OVERFLOW: &str = "arithmetic overflow";
pub const MSG_ILLEGAL: &str = "illegal reservation transition";
pub const MSG_ZERO_AMOUNT: &str = "amount must be positive";

/// Payload-validation refusals (`PurserError` `Display`; Prompt 4). Each is a bare literal
/// carrying no numeric state. The `msg_constants_are_frozen` unit test (below) pins every
/// literal's VALUE so an accidental reword fails CI now; the Prompt-6 near-workspaces attack
/// suite will additionally assert them end-to-end.
pub const MSG_UNSUPPORTED_CHAIN: &str = "unsupported chain";
pub const MSG_UNSUPPORTED_TOKEN: &str = "unsupported token";
pub const MSG_INVALID_RECIPIENT: &str = "invalid recipient";
pub const MSG_MEMO_TOO_LONG: &str = "memo too long";

/// Boundary-guard panic strings for the Prompt-3 contract layer (task/delegate
/// registry, access control, crew-cap). These are NOT [`PurserError`] variants —
/// they guard the `#[near]` entrypoints, where `require!` / `env::panic_str` take a
/// `&str` directly. They live here for the same reason as the accounting messages
/// above: single source of truth, so the entrypoint and the `near-workspaces` attack
/// suite assert the *same* literal and cannot drift. Like the accounting messages,
/// they carry no numeric state (no live budget/cap leaks into on-chain receipts).
pub const MSG_ONLY_OWNER: &str = "only owner";
pub const MSG_TASK_EXISTS: &str = "task exists";
pub const MSG_CAP_POSITIVE: &str = "cap must be positive";
pub const MSG_CREW_CAP_MIN: &str = "crew_cap must be >= 1";
pub const MSG_INVALID_TASK_ID: &str = "invalid task_id";
pub const MSG_INVALID_PATH: &str = "invalid derivation_path";
pub const MSG_NO_SUCH_TASK: &str = "no such task";
pub const MSG_DELEGATE_EXISTS: &str = "delegate exists";
pub const MSG_CREW_CAP_REACHED: &str = "crew cap reached";
pub const MSG_NO_SUCH_DELEGATE: &str = "no such delegate";
pub const MSG_DELEGATE_NOT_AUTHORIZED: &str = "delegate not authorized";
// Prompt-4 payment-flow boundary guards. `in-flight` / `already failed` are the exact literals
// the build prompt mandates; the TypeScript proposer branches on these, so treat them as a frozen
// cross-service wire contract (do not reword).
pub const MSG_IN_FLIGHT: &str = "in-flight";
pub const MSG_ALREADY_FAILED: &str = "already failed";
pub const MSG_INVALID_REQUEST_ID: &str = "invalid request_id";
pub const MSG_RECIPIENT_NOT_ALLOWED: &str = "recipient not allowlisted";
pub const MSG_NO_SUCH_COMMITMENT: &str = "no such commitment";
pub const MSG_NOT_RECONCILABLE: &str = "not reconcilable";

/// Why an accounting, state-machine, or payload-validation operation refused.
///
/// Variants are intentionally distinct: tests assert the *specific* refusal (e.g.
/// "one unit over cap" must be [`PurserError::ExceedsBudget`], not
/// [`PurserError::ArithmeticOverflow`]), which proves the right guard fired.
#[derive(PartialEq, Eq, Debug)]
pub enum PurserError {
    /// `try_reserve`: `completed + outstanding + amount` would exceed `cap`.
    ExceedsBudget {
        requested: NearToken,
        remaining: NearToken,
    },
    /// `settle_confirmed`: `spent > reserved_amount`.
    SpentExceedsReserved {
        spent: NearToken,
        reserved: NearToken,
    },
    /// A `checked_add`/`checked_sub` returned `None` (would wrap). Never admit/mutate.
    ArithmeticOverflow,
    /// A reservation-lifecycle edge not permitted by TECHNICAL §4.
    IllegalTransition {
        from: ReservationState,
        event: &'static str,
    },
    /// `try_reserve` with `amount == 0`.
    ZeroAmount,
    /// Payload validation: `intent.chain` is not `NearNative` (EVM is the stretch path).
    UnsupportedChain,
    /// Payload validation: a `Nep141` token on the intent or task (NEAR-native only for now).
    UnsupportedToken,
    /// Payload validation: `intent.recipient` does not parse to a NEAR `AccountId`.
    InvalidRecipient,
    /// Payload validation: `intent.memo` exceeds the max length.
    MemoTooLong,
}

impl core::fmt::Display for PurserError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            PurserError::ExceedsBudget { .. } => MSG_EXCEEDS_BUDGET,
            PurserError::SpentExceedsReserved { .. } => MSG_SPENT_EXCEEDS,
            PurserError::ArithmeticOverflow => MSG_OVERFLOW,
            PurserError::IllegalTransition { .. } => MSG_ILLEGAL,
            PurserError::ZeroAmount => MSG_ZERO_AMOUNT,
            PurserError::UnsupportedChain => MSG_UNSUPPORTED_CHAIN,
            PurserError::UnsupportedToken => MSG_UNSUPPORTED_TOKEN,
            PurserError::InvalidRecipient => MSG_INVALID_RECIPIENT,
            PurserError::MemoTooLong => MSG_MEMO_TOO_LONG,
        };
        f.write_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin every panic-string literal by VALUE. These are a frozen cross-service wire contract —
    /// the TypeScript proposer and the Prompt-6 attack suite branch on them by string — so an
    /// accidental reword must fail CI here, before any downstream consumer breaks silently.
    #[test]
    fn msg_constants_are_frozen() {
        // accounting / state-machine
        assert_eq!(MSG_EXCEEDS_BUDGET, "exceeds task budget");
        assert_eq!(MSG_SPENT_EXCEEDS, "spent exceeds reserved");
        assert_eq!(MSG_OVERFLOW, "arithmetic overflow");
        assert_eq!(MSG_ILLEGAL, "illegal reservation transition");
        assert_eq!(MSG_ZERO_AMOUNT, "amount must be positive");
        // payload validation
        assert_eq!(MSG_UNSUPPORTED_CHAIN, "unsupported chain");
        assert_eq!(MSG_UNSUPPORTED_TOKEN, "unsupported token");
        assert_eq!(MSG_INVALID_RECIPIENT, "invalid recipient");
        assert_eq!(MSG_MEMO_TOO_LONG, "memo too long");
        // owner / registry boundary guards
        assert_eq!(MSG_ONLY_OWNER, "only owner");
        assert_eq!(MSG_TASK_EXISTS, "task exists");
        assert_eq!(MSG_CAP_POSITIVE, "cap must be positive");
        assert_eq!(MSG_CREW_CAP_MIN, "crew_cap must be >= 1");
        assert_eq!(MSG_INVALID_TASK_ID, "invalid task_id");
        assert_eq!(MSG_INVALID_PATH, "invalid derivation_path");
        assert_eq!(MSG_NO_SUCH_TASK, "no such task");
        assert_eq!(MSG_DELEGATE_EXISTS, "delegate exists");
        assert_eq!(MSG_CREW_CAP_REACHED, "crew cap reached");
        assert_eq!(MSG_NO_SUCH_DELEGATE, "no such delegate");
        assert_eq!(MSG_DELEGATE_NOT_AUTHORIZED, "delegate not authorized");
        // payment-flow boundary guards
        assert_eq!(MSG_IN_FLIGHT, "in-flight");
        assert_eq!(MSG_ALREADY_FAILED, "already failed");
        assert_eq!(MSG_INVALID_REQUEST_ID, "invalid request_id");
        assert_eq!(MSG_RECIPIENT_NOT_ALLOWED, "recipient not allowlisted");
        assert_eq!(MSG_NO_SUCH_COMMITMENT, "no such commitment");
        assert_eq!(MSG_NOT_RECONCILABLE, "not reconcilable");
    }
}
