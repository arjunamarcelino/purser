//! NEAR-native payload validation/construction (TECHNICAL §8; "never blind-sign").
//!
//! Pure and `env`-free — mirrors [`crate::delegates`]: a free function over borrowed values
//! with the caller injected, reading neither `env` nor `self`, so the `#[near]` entrypoint in
//! [`crate::lib`] stays the single `env`/store boundary. The contract constructs/validates the
//! transaction it signs from the structured [`PaymentIntent`]; it never blind-signs a
//! client-supplied hash.
//!
//! SCOPE (Prompt 4): validate a well-formed NEAR-native transfer against the task's token and
//! return the parsed recipient. `payload_hash` is carried as `None` here; Prompt 5 fills it with
//! the canonical constructed-action hash (a zero-churn body change — the field is already threaded
//! through `open_reservation` into the `Commitment`). `amount > 0` is deliberately NOT checked
//! here — [`crate::budget::try_reserve`] is the single zero-amount authority.

use crate::error::PurserError;
use crate::types::{Chain, PaymentIntent, TokenSpec};
use near_sdk::AccountId;

/// The validated, contract-constructed NEAR-native payload: the parsed recipient plus the
/// signing-payload hash (`None` until Prompt 5 constructs it).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NearPayload {
    pub recipient: AccountId,
    pub payload_hash: Option<[u8; 32]>,
}

/// Validate `intent` as a NEAR-native transfer denominated in `task_token`, returning the parsed
/// recipient. Rejects a non-NEAR chain, a non-native / mismatched token, an over-long memo, and a
/// recipient that is not a valid `AccountId`. Pure and total.
pub fn build_near_payload(
    task_token: &TokenSpec,
    intent: &PaymentIntent,
    max_memo_len: usize,
) -> Result<NearPayload, PurserError> {
    if intent.chain != Chain::NearNative {
        return Err(PurserError::UnsupportedChain);
    }
    // NEAR-native only for now: both the intent and the task must be NearNative. Once both are
    // NearNative they are necessarily equal, so no separate "token mismatch" check is reachable.
    if intent.token != TokenSpec::NearNative || *task_token != TokenSpec::NearNative {
        return Err(PurserError::UnsupportedToken);
    }
    if let Some(memo) = &intent.memo {
        if memo.len() > max_memo_len {
            return Err(PurserError::MemoTooLong);
        }
    }
    let recipient = intent
        .recipient
        .parse::<AccountId>()
        .map_err(|_| PurserError::InvalidRecipient)?;
    Ok(NearPayload {
        recipient,
        payload_hash: None, // TODO(Prompt 5): construct the transfer action + hash it
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::NearToken;

    const MAX_MEMO: usize = 256;

    fn intent(
        chain: Chain,
        token: TokenSpec,
        recipient: &str,
        memo: Option<String>,
    ) -> PaymentIntent {
        PaymentIntent {
            chain,
            recipient: recipient.to_string(),
            amount: NearToken::from_yoctonear(100),
            token,
            memo,
        }
    }

    #[test]
    fn valid_near_native_parses_recipient_and_defers_hash() {
        let p = build_near_payload(
            &TokenSpec::NearNative,
            &intent(
                Chain::NearNative,
                TokenSpec::NearNative,
                "recipient.near",
                None,
            ),
            MAX_MEMO,
        )
        .unwrap();
        assert_eq!(p.recipient, "recipient.near".parse::<AccountId>().unwrap());
        assert_eq!(
            p.payload_hash, None,
            "payload_hash is constructed in Prompt 5"
        );
    }

    #[test]
    fn rejects_evm_chain() {
        let err = build_near_payload(
            &TokenSpec::NearNative,
            &intent(
                Chain::Evm { chain_id: 11155111 },
                TokenSpec::NearNative,
                "recipient.near",
                None,
            ),
            MAX_MEMO,
        )
        .unwrap_err();
        assert_eq!(err, PurserError::UnsupportedChain);
    }

    #[test]
    fn rejects_nep141_token_on_intent_or_task() {
        let nep141 = TokenSpec::Nep141 {
            contract: "usdc.near".parse().unwrap(),
        };
        // Nep141 on the intent.
        assert_eq!(
            build_near_payload(
                &TokenSpec::NearNative,
                &intent(Chain::NearNative, nep141.clone(), "recipient.near", None),
                MAX_MEMO,
            )
            .unwrap_err(),
            PurserError::UnsupportedToken
        );
        // Nep141 on the task.
        assert_eq!(
            build_near_payload(
                &nep141,
                &intent(
                    Chain::NearNative,
                    TokenSpec::NearNative,
                    "recipient.near",
                    None
                ),
                MAX_MEMO,
            )
            .unwrap_err(),
            PurserError::UnsupportedToken
        );
    }

    #[test]
    fn rejects_overlong_memo() {
        let memo = "m".repeat(MAX_MEMO + 1);
        let err = build_near_payload(
            &TokenSpec::NearNative,
            &intent(
                Chain::NearNative,
                TokenSpec::NearNative,
                "recipient.near",
                Some(memo),
            ),
            MAX_MEMO,
        )
        .unwrap_err();
        assert_eq!(err, PurserError::MemoTooLong);
        // A memo exactly at the bound is accepted.
        let at_bound = "m".repeat(MAX_MEMO);
        assert!(build_near_payload(
            &TokenSpec::NearNative,
            &intent(
                Chain::NearNative,
                TokenSpec::NearNative,
                "recipient.near",
                Some(at_bound)
            ),
            MAX_MEMO,
        )
        .is_ok());
    }

    #[test]
    fn rejects_malformed_recipient() {
        let err = build_near_payload(
            &TokenSpec::NearNative,
            &intent(
                Chain::NearNative,
                TokenSpec::NearNative,
                "Not A Valid Id!!",
                None,
            ),
            MAX_MEMO,
        )
        .unwrap_err();
        assert_eq!(err, PurserError::InvalidRecipient);
    }
}
