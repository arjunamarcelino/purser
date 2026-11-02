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

/// Why an accounting or state-machine operation refused.
///
/// Variants are intentionally distinct: tests assert the *specific* refusal (e.g.
/// "one unit over cap" must be [`PurserError::ExceedsBudget`], not
/// [`PurserError::ArithmeticOverflow`]), which proves the right guard fired.
#[derive(Debug, PartialEq, Eq)]
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
}

impl core::fmt::Display for PurserError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            PurserError::ExceedsBudget { .. } => MSG_EXCEEDS_BUDGET,
            PurserError::SpentExceedsReserved { .. } => MSG_SPENT_EXCEEDS,
            PurserError::ArithmeticOverflow => MSG_OVERFLOW,
            PurserError::IllegalTransition { .. } => MSG_ILLEGAL,
            PurserError::ZeroAmount => MSG_ZERO_AMOUNT,
        };
        f.write_str(s)
    }
}
