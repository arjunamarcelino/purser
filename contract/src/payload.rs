//! NEAR-native payload validation + canonical-bytes construction (TECHNICAL §8; "never blind-sign").
//!
//! Pure and `env`-free — mirrors [`crate::delegates`]: free functions over borrowed values with the
//! caller injecting ids, reading neither `env` nor `self`, so the `#[near]` entrypoint in
//! [`crate::lib`] stays the single `env`/store boundary. The contract constructs/validates the
//! transaction it authorizes from the structured [`PaymentIntent`]; it never blind-signs a
//! client-supplied hash.
//!
//! TWO responsibilities, both pure:
//!   1. [`build_near_payload`] — validate a well-formed NEAR-native transfer against the task token
//!      and return the parsed recipient.
//!   2. [`canonical_payload_bytes`] — build the domain-separated, borsh-canonical preimage for a
//!      per-spend audit anchor: `PAYLOAD_DOMAIN || borsh(version, task, commitment_id, recipient,
//!      amount_yocto)`. The `#[near]` layer hashes this with `env::sha256_array` and records the
//!      digest on the `Commitment` (this is why the bytes are built here but hashed there — hashing
//!      is an `env` call, byte-construction is not).
//!
//! The anchor is an INTEGRITY/AUDIT artifact, not a signature: a NEAR-native transfer is authorized
//! by issuing a `Promise`, not by signing a hash. The domain tag + `version` are a re-derivation /
//! versioning signal, not a security boundary. `intent.chain` selects HOW the hash re-derives:
//! NEAR-native = this sha256 scheme; EVM (Prompt 12) = un-prefixed `keccak256(RLP(tx))`. The EVM
//! signing digest must build its OWN replay-safe preimage — do not copy this one blindly.
//!
//! [`NearPayload`] is a transient return value; it is never stored and carries no Borsh-freeze
//! obligation. `amount > 0` is deliberately NOT checked here — [`crate::budget::try_reserve`] is the
//! single zero-amount authority.

use crate::error::PurserError;
use crate::types::{Chain, PaymentIntent, TokenSpec};
use near_sdk::AccountId;

/// Fixed-length (32-byte) domain tag. Fixed WIDTH removes any tag/payload boundary ambiguity (an
/// unframed variable-length prefix risks `v1` colliding with a future `v10`); the authoritative
/// schema version is the `u16` first borsh field, not this string.
pub const PAYLOAD_DOMAIN: [u8; 32] = *b"purser.near-native.transfer\0\0\0\0\0";

/// Canonical preimage schema version — the FIRST borsh field. Bump on ANY encoding change
/// (field add/reorder, type change); never silently change `v1`, or previously-stored
/// `payload_hash` values stop re-deriving.
pub const PAYLOAD_VERSION: u16 = 1;

/// The validated, contract-constructed NEAR-native payload: the parsed recipient. The signing /
/// audit hash is built from [`canonical_payload_bytes`] at the `#[near]` boundary once the
/// `commitment_id` exists.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NearPayload {
    pub recipient: AccountId,
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
    Ok(NearPayload { recipient })
}

/// Build the canonical, domain-separated preimage for a NEAR-native transfer's per-spend audit
/// anchor: `PAYLOAD_DOMAIN || borsh(version, task, commitment_id, recipient, amount_yocto)`.
///
/// Pure and total. The preimage binds the SEMANTIC fields the contract constructed and is itself
/// using to build the `Promise` (`recipient`, `amount_yocto`) plus identity (`task`,
/// `commitment_id`) so every reservation's anchor is unique and re-derivable off-chain. No enum, no
/// map — all primitives + length-prefixed strings — so the borsh encoding is maximally
/// determinism-safe. Borsh wire layout (the off-chain re-derivation contract): `u16` = 2B LE,
/// `String`/`AccountId` = u32-LE length + UTF-8, `u64` = 8B LE, `u128` = 16B LE; tuple fields in
/// order, no padding/prefix.
pub fn canonical_payload_bytes(
    task: &str,
    commitment_id: u64,
    recipient: &AccountId,
    amount_yocto: u128,
) -> Vec<u8> {
    // Single allocation: prepend the fixed domain, then borsh-serialize the body directly into the
    // same buffer (`Vec<u8>: Write`), avoiding a second intermediate `Vec` + copy.
    let mut bytes = Vec::with_capacity(PAYLOAD_DOMAIN.len() + 96);
    bytes.extend_from_slice(&PAYLOAD_DOMAIN);
    near_sdk::borsh::to_writer(
        &mut bytes,
        &(
            PAYLOAD_VERSION,
            task,
            commitment_id,
            recipient,
            amount_yocto,
        ),
    )
    .expect("borsh serialize to Vec is infallible");
    bytes
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
    fn valid_near_native_parses_recipient() {
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

    // ---- canonical payload bytes (the audit-anchor preimage) ----------------------

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// Independently hand-assemble the borsh wire layout (the off-chain re-derivation contract) so
    /// any drift in field order / endianness / length-prefixing fails here — a pure golden vector.
    fn hand_assembled_body(
        version: u16,
        task: &str,
        cid: u64,
        recipient: &str,
        amount: u128,
    ) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&version.to_le_bytes()); // u16 LE
        v.extend_from_slice(&(task.len() as u32).to_le_bytes()); // String: u32 LE len
        v.extend_from_slice(task.as_bytes()); //         + UTF-8
        v.extend_from_slice(&cid.to_le_bytes()); // u64 LE
        v.extend_from_slice(&(recipient.len() as u32).to_le_bytes()); // AccountId == String
        v.extend_from_slice(recipient.as_bytes());
        v.extend_from_slice(&amount.to_le_bytes()); // u128 LE
        v
    }

    #[test]
    fn canonical_bytes_are_domain_prefixed_and_match_the_wire_layout() {
        let got = canonical_payload_bytes("t1", 0, &acct("alice.near"), 100);
        let mut expected = PAYLOAD_DOMAIN.to_vec();
        expected.extend_from_slice(&hand_assembled_body(
            PAYLOAD_VERSION,
            "t1",
            0,
            "alice.near",
            100,
        ));
        // Full-vector equality against the independently hand-assembled layout; this already
        // implies the domain prefix and determinism, so no separate assertions for those.
        assert_eq!(
            got, expected,
            "canonical bytes drifted from the documented borsh wire layout"
        );
    }

    #[test]
    fn canonical_bytes_change_with_each_bound_field() {
        let base = canonical_payload_bytes("t1", 7, &acct("alice.near"), 42);
        assert_ne!(
            base,
            canonical_payload_bytes("t2", 7, &acct("alice.near"), 42),
            "task"
        );
        assert_ne!(
            base,
            canonical_payload_bytes("t1", 8, &acct("alice.near"), 42),
            "commitment_id"
        );
        assert_ne!(
            base,
            canonical_payload_bytes("t1", 7, &acct("bob.near"), 42),
            "recipient"
        );
        assert_ne!(
            base,
            canonical_payload_bytes("t1", 7, &acct("alice.near"), 43),
            "amount"
        );
    }
}
