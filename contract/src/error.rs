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
// `reconcile` refuses while the commitment's settlement callback may still be in flight.
pub const MSG_RECONCILE_TOO_EARLY: &str = "reconcile too early";
// A retry must replay the SAME request (task + intent); a settled request_id is never reused.
pub const MSG_REQUEST_ID_REUSED: &str = "request_id reused with a different request";
// A task frozen by a contradicted reconcile accepts no new proposal.
pub const MSG_TASK_FROZEN: &str = "task frozen";

// EVM payment path (Prompt 12). Same rules as above: bare literals, no numeric state, pinned by value in
// `msg_constants_are_frozen`. The relayer and `packages/types` (`classifyRefusal`) branch on them.
pub const MSG_EVM_VALUE_TOO_LOW: &str = "evm value below minimum";
pub const MSG_EVM_INVALID_FEE: &str = "invalid evm fee";
pub const MSG_EVM_SIGHASH_RANGE: &str = "sighash out of range";
pub const MSG_EVM_LANE_UNSEEDED: &str = "evm lane not seeded";
pub const MSG_EVM_LANE_BUSY: &str = "evm lane busy";
pub const MSG_EVM_NONCE_REFUSED: &str = "nonce seed refused";
pub const MSG_EVM_NOT_CONFIGURED: &str = "evm not configured";
pub const MSG_EVM_BAD_CFG: &str = "invalid evm config";
pub const MSG_EVM_TASK_NOT_EMPTY: &str = "task must have no delegates";
pub const MSG_NOT_EVM_TASK: &str = "not an evm task";
pub const MSG_EVM_KEY_NOT_CACHED: &str = "derived key not cached";
pub const MSG_EVM_KEY_CACHED: &str = "derived key already cached";
pub const MSG_EVM_LOW_GAS: &str = "insufficient prepaid gas";
pub const MSG_EVM_LOW_BALANCE: &str = "insufficient contract balance";
pub const MSG_PATH_IN_USE: &str = "derivation path in use";
pub const MSG_ONLY_OWNER_OR_RELAYER: &str = "only owner or relayer";
pub const MSG_NOT_EVM_COMMITMENT: &str = "not an evm commitment";
pub const MSG_RECONCILE_EVM: &str = "reconcile not allowed for evm";
pub const MSG_RELAYER_IS_OWNER: &str = "relayer must not be owner";
pub const MSG_RELAYER_BUSY: &str = "relayer change blocked";
pub const MSG_TOO_EARLY_UNKNOWN: &str = "too early to mark unknown";
pub const MSG_UNKNOWN_TX_HASH: &str = "unknown tx hash";
pub const MSG_INVALID_TX_HASH: &str = "invalid tx hash";
pub const MSG_CANCEL_EXISTS: &str = "cancel already requested";
pub const MSG_NOT_CANCELLABLE: &str = "not cancellable";
pub const MSG_NO_RELEASE_EVIDENCE: &str = "no release evidence";

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
    /// EVM tx builder: `value` is below `EvmCfg.min_value` (or zero).
    EvmValueTooLow,
    /// EVM tx builder: fee fields violate `tip <= max_fee <= ceiling` (or a cancel bump rule).
    EvmInvalidFee,
    /// EVM tx builder: the digest is not a valid secp256k1 scalar (zero, or `>= n`).
    EvmSighashRange,
    /// Lane: no `next_nonce` has been seeded yet.
    EvmLaneUnseeded,
    /// Lane: another commitment is already in flight on this derived address.
    EvmLaneBusy,
    /// Lane: a re-seed that would lower the nonce, or seed a non-empty lane.
    EvmNonceRefused,
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
            PurserError::EvmValueTooLow => MSG_EVM_VALUE_TOO_LOW,
            PurserError::EvmInvalidFee => MSG_EVM_INVALID_FEE,
            PurserError::EvmSighashRange => MSG_EVM_SIGHASH_RANGE,
            PurserError::EvmLaneUnseeded => MSG_EVM_LANE_UNSEEDED,
            PurserError::EvmLaneBusy => MSG_EVM_LANE_BUSY,
            PurserError::EvmNonceRefused => MSG_EVM_NONCE_REFUSED,
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
        assert_eq!(MSG_RECONCILE_TOO_EARLY, "reconcile too early");
        assert_eq!(
            MSG_REQUEST_ID_REUSED,
            "request_id reused with a different request"
        );
        assert_eq!(MSG_TASK_FROZEN, "task frozen");
        // EVM payment path
        assert_eq!(MSG_EVM_VALUE_TOO_LOW, "evm value below minimum");
        assert_eq!(MSG_EVM_INVALID_FEE, "invalid evm fee");
        assert_eq!(MSG_EVM_SIGHASH_RANGE, "sighash out of range");
        assert_eq!(MSG_EVM_LANE_UNSEEDED, "evm lane not seeded");
        assert_eq!(MSG_EVM_LANE_BUSY, "evm lane busy");
        assert_eq!(MSG_EVM_NONCE_REFUSED, "nonce seed refused");
        assert_eq!(MSG_EVM_NOT_CONFIGURED, "evm not configured");
        assert_eq!(MSG_EVM_BAD_CFG, "invalid evm config");
        assert_eq!(MSG_EVM_TASK_NOT_EMPTY, "task must have no delegates");
        assert_eq!(MSG_NOT_EVM_TASK, "not an evm task");
        assert_eq!(MSG_EVM_KEY_NOT_CACHED, "derived key not cached");
        assert_eq!(MSG_EVM_KEY_CACHED, "derived key already cached");
        assert_eq!(MSG_EVM_LOW_GAS, "insufficient prepaid gas");
        assert_eq!(MSG_EVM_LOW_BALANCE, "insufficient contract balance");
        assert_eq!(MSG_PATH_IN_USE, "derivation path in use");
        assert_eq!(MSG_ONLY_OWNER_OR_RELAYER, "only owner or relayer");
        assert_eq!(MSG_NOT_EVM_COMMITMENT, "not an evm commitment");
        assert_eq!(MSG_RECONCILE_EVM, "reconcile not allowed for evm");
        assert_eq!(MSG_RELAYER_IS_OWNER, "relayer must not be owner");
        assert_eq!(MSG_RELAYER_BUSY, "relayer change blocked");
        assert_eq!(MSG_TOO_EARLY_UNKNOWN, "too early to mark unknown");
        assert_eq!(MSG_UNKNOWN_TX_HASH, "unknown tx hash");
        assert_eq!(MSG_INVALID_TX_HASH, "invalid tx hash");
        assert_eq!(MSG_CANCEL_EXISTS, "cancel already requested");
        assert_eq!(MSG_NOT_CANCELLABLE, "not cancellable");
        assert_eq!(MSG_NO_RELEASE_EVIDENCE, "no release evidence");
    }
}
