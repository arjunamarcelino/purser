//! EVM transaction construction, signed-transaction assembly, fee math, validation and lane logic
//! (Prompt 12; docs/plans/2026-11-06-feat-evm-governed-payment-path-plan.md).
//!
//! Pure and `env`-free, like [`crate::payload`] and [`crate::budget`]: free functions over borrowed values.
//! Hashing is injected as a plain `fn(&[u8]) -> [u8; 32]` ([`Keccak`]) so this module never touches the
//! host; the `#[near]` layer passes `env::keccak256_array`, the tests pass the `sha3` oracle. Nothing here
//! signs anything: the digest it builds is handed to the MPC signer by the entrypoint, which is the ONLY
//! `sign` call site for an EVM path.
//!
//! "Never blind-sign": [`build_original`] and [`build_cancel`] take only values the contract already holds
//! (the stored `PaymentIntent`, the lane nonce, the owner's fee config) and validate them BEFORE a digest
//! exists. The transaction shape is fixed: EIP-1559, `data = 0x`, empty access list, `gas_limit = 21000`
//! (a plain native transfer to an EOA).
//!
//! The digest is `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas,
//! gas_limit, to, value, data, access_list]))`; the signed form appends `yParity, r, s` to that list.

use crate::error::PurserError;
use crate::types::{CommitmentId, EvmCfg, EvmSig, Lane};

/// A keccak256 implementation. The contract passes the NEAR host function; tests pass `sha3`.
pub type Keccak = fn(&[u8]) -> [u8; 32];

/// Gas limit of every transaction the contract builds: a plain value transfer to an EOA.
pub const GAS_LIMIT: u64 = 21_000;
/// Replacement bump applied to BOTH fee fields of a cancel, in basis points (12.5%, rounded up). Geth's
/// default `PriceBump` is 10%; this clears it.
pub const CANCEL_BUMP_BPS: u128 = 1250;
/// The only chains the contract will ever build for (Sepolia). Never mainnet.
pub const TESTNET_CHAIN_IDS: [u64; 1] = [11_155_111];
/// Floor of `EvmCfg.min_unknown_age_ns`: five minutes.
pub const MIN_UNKNOWN_AGE_FLOOR_NS: u64 = 300 * 1_000_000_000;
/// A `Reserved` EVM commitment older than this may be marked Unknown (Ambiguous): longer than the signer's
/// yield timeout plus margin, so a live `sign` cannot still be in flight.
pub const RESERVED_AMBIGUOUS_MIN_AGE_NS: u64 = 3600 * 1_000_000_000;
/// The scheme version recorded in `Commitment.payload_version` for an EVM commitment.
pub const EVM_PAYLOAD_VERSION: u16 = 1;
/// Chain tag of the EVM scheme (the discriminator a verifier branches on).
pub const EVM_PAYLOAD_CHAIN_TAG: &str = "evm";
pub const EVM_PAYLOAD_HASH_ALG: &str = "keccak256";
pub const EVM_PAYLOAD_ENCODING: &str = "rlp-eip1559";
/// Machine-readable composition rule of `Commitment.payload_hash` for an EVM commitment.
pub const EVM_PAYLOAD_PREIMAGE_SPEC: &str = "keccak256( 0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit=21000, to, value, data=0x, access_list=[]]) ); un-prefixed; this is the digest the MPC signer signs";

/// The order `n` of the secp256k1 group, big-endian. A digest must be a scalar in `[1, n)`.
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// An unsigned EIP-1559 native transfer. `u128` bounds the fee and value fields (real EVM fields are
/// 256-bit; the bound is deliberate and recorded in docs/EVM-SPIKE.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Eip1559Unsigned {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
}

// ---- RLP ----------------------------------------------------------------------------------------

/// RLP of a byte string. Callers pass at most 32 bytes, so only the single-byte and short forms exist.
fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    match bytes {
        [b] if *b < 0x80 => out.push(*b),
        _ => {
            debug_assert!(bytes.len() <= 55);
            out.push(0x80 + bytes.len() as u8);
            out.extend_from_slice(bytes);
        }
    }
}

/// RLP of an unsigned integer given as big-endian bytes: leading zeros stripped, zero is `0x80`.
fn push_be_uint(out: &mut Vec<u8>, be: &[u8]) {
    let first = be.iter().position(|b| *b != 0).unwrap_or(be.len());
    push_string(out, &be[first..]);
}

fn push_uint(out: &mut Vec<u8>, v: u128) {
    push_be_uint(out, &v.to_be_bytes());
}

/// RLP list header for a payload of `len` bytes (short form up to 55, long form above).
fn push_list_header(out: &mut Vec<u8>, len: usize) {
    if len <= 55 {
        out.push(0xc0 + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let first = be.iter().position(|b| *b != 0).unwrap_or(be.len() - 1);
        out.push(0xf7 + (be.len() - first) as u8);
        out.extend_from_slice(&be[first..]);
    }
}

/// The nine shared fields, in order, ending with the empty `data` and empty access list.
fn push_fields(body: &mut Vec<u8>, tx: &Eip1559Unsigned) {
    push_uint(body, tx.chain_id as u128);
    push_uint(body, tx.nonce as u128);
    push_uint(body, tx.max_priority_fee_per_gas);
    push_uint(body, tx.max_fee_per_gas);
    push_uint(body, tx.gas_limit as u128);
    push_string(body, &tx.to);
    push_uint(body, tx.value);
    body.push(0x80); // data: empty
    body.push(0xc0); // access_list: empty
}

/// `0x02 || rlp([... , data = "", access_list = []])`, the exact bytes that are hashed.
pub fn encode_unsigned(tx: &Eip1559Unsigned) -> Vec<u8> {
    let mut body = Vec::with_capacity(96);
    push_fields(&mut body, tx);
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(0x02);
    push_list_header(&mut out, body.len());
    out.extend_from_slice(&body);
    out
}

/// `0x02 || rlp([... , data, access_list, yParity, r, s])`: the raw transaction a relayer broadcasts.
pub fn encode_signed(tx: &Eip1559Unsigned, sig: &EvmSig) -> Vec<u8> {
    let mut body = Vec::with_capacity(160);
    push_fields(&mut body, tx);
    push_uint(&mut body, sig.y_parity as u128);
    push_be_uint(&mut body, &sig.r);
    push_be_uint(&mut body, &sig.s);
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(0x02);
    push_list_header(&mut out, body.len());
    out.extend_from_slice(&body);
    out
}

/// The 32-byte signing digest.
pub fn sighash(tx: &Eip1559Unsigned, keccak: Keccak) -> [u8; 32] {
    keccak(&encode_unsigned(tx))
}

/// The transaction hash: `keccak256` of the signed encoding.
pub fn tx_hash(tx: &Eip1559Unsigned, sig: &EvmSig, keccak: Keccak) -> [u8; 32] {
    keccak(&encode_signed(tx, sig))
}

/// A digest is signable only as a secp256k1 scalar: non-zero and strictly below the group order.
pub fn sighash_in_range(h: &[u8; 32]) -> bool {
    h.iter().any(|b| *b != 0) && *h < SECP256K1_ORDER
}

/// The signable digest of `tx`, or [`PurserError::EvmSighashRange`] if it is not a valid scalar.
pub fn checked_sighash(tx: &Eip1559Unsigned, keccak: Keccak) -> Result<[u8; 32], PurserError> {
    let h = sighash(tx, keccak);
    if sighash_in_range(&h) {
        Ok(h)
    } else {
        Err(PurserError::EvmSighashRange)
    }
}

// ---- hex and addresses --------------------------------------------------------------------------

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Lowercase hex, no prefix.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// `0x` + lowercase hex.
pub fn to_hex0x(bytes: &[u8]) -> String {
    format!("0x{}", to_hex(bytes))
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Decode exactly `N` bytes from hex with an optional `0x` prefix. Case-insensitive; any other length or
/// character is `None`.
pub fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, pair) in s.chunks_exact(2).enumerate() {
        out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

/// Parse an EVM address: `0x` + 40 hex digits, case-insensitive (so an EIP-55 checksummed and a lowercase
/// spelling are one payee; the checksum itself is not enforced). The `0x` prefix is required.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    s.strip_prefix("0x")?;
    from_hex::<20>(s)
}

/// The EVM address of an uncompressed secp256k1 key (x || y): the last 20 bytes of `keccak256(key)`.
pub fn address_of(pubkey: &[u8; 64], keccak: Keccak) -> [u8; 20] {
    let h = keccak(pubkey);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

// ---- fees and validation ------------------------------------------------------------------------

/// `ceil(prev * (1 + CANCEL_BUMP_BPS / 10000))`: the smallest fee a replacement must carry. `None` on
/// overflow.
pub fn bump_fee(prev: u128) -> Option<u128> {
    let add = prev.checked_mul(CANCEL_BUMP_BPS)?.div_ceil(10_000);
    prev.checked_add(add)
}

/// Fee-pair rule shared by originals and cancels: `0 < tip <= max_fee <= ceiling`, `tip <= tip ceiling`.
fn check_fee_pair(
    max_fee: u128,
    tip: u128,
    fee_ceiling: u128,
    tip_ceiling: u128,
) -> Result<(), PurserError> {
    if tip == 0 || tip > max_fee || max_fee > fee_ceiling || tip > tip_ceiling {
        return Err(PurserError::EvmInvalidFee);
    }
    Ok(())
}

/// Validate and build an ORIGINAL transfer from values the contract holds. `fee = ceiling` (simplest and
/// un-stuckable). Refuses: a chain other than `cfg.chain_id`, a zero recipient, `value` below
/// `cfg.min_value` (or zero), an invalid fee pair. The digest is NOT computed here; callers run
/// [`checked_sighash`] on the result.
pub fn build_original(
    cfg: &EvmCfg,
    chain_id: u64,
    nonce: u64,
    to: [u8; 20],
    value: u128,
) -> Result<Eip1559Unsigned, PurserError> {
    if chain_id != cfg.chain_id || !TESTNET_CHAIN_IDS.contains(&chain_id) {
        return Err(PurserError::UnsupportedChain);
    }
    if to == [0u8; 20] {
        return Err(PurserError::InvalidRecipient);
    }
    if value == 0 || value < cfg.min_value {
        return Err(PurserError::EvmValueTooLow);
    }
    check_fee_pair(
        cfg.max_fee_ceiling,
        cfg.max_priority_ceiling,
        cfg.max_fee_ceiling,
        cfg.max_priority_ceiling,
    )?;
    Ok(Eip1559Unsigned {
        chain_id,
        nonce,
        max_priority_fee_per_gas: cfg.max_priority_ceiling,
        max_fee_per_gas: cfg.max_fee_ceiling,
        gas_limit: GAS_LIMIT,
        to,
        value,
    })
}

/// Validate and build the nonce-burn CANCEL of an original: the same nonce, a 0-value self-send to the lane
/// address, and explicit fees that must be `>= ceil(1.125 * original)` on BOTH fields and within the
/// current ceilings. A +12.5% cancel cannot unstick a tx priced below the base fee, so the caller picks a
/// target up to the ceiling.
#[allow(clippy::too_many_arguments)]
pub fn build_cancel(
    cfg: &EvmCfg,
    chain_id: u64,
    nonce: u64,
    lane_address: [u8; 20],
    orig_max_fee: u128,
    orig_tip: u128,
    max_fee: u128,
    tip: u128,
) -> Result<Eip1559Unsigned, PurserError> {
    if chain_id != cfg.chain_id || !TESTNET_CHAIN_IDS.contains(&chain_id) {
        return Err(PurserError::UnsupportedChain);
    }
    check_fee_pair(max_fee, tip, cfg.max_fee_ceiling, cfg.max_priority_ceiling)?;
    let min_fee = bump_fee(orig_max_fee).ok_or(PurserError::EvmInvalidFee)?;
    let min_tip = bump_fee(orig_tip).ok_or(PurserError::EvmInvalidFee)?;
    if max_fee < min_fee || tip < min_tip {
        return Err(PurserError::EvmInvalidFee);
    }
    Ok(Eip1559Unsigned {
        chain_id,
        nonce,
        max_priority_fee_per_gas: tip,
        max_fee_per_gas: max_fee,
        gas_limit: GAS_LIMIT,
        to: lane_address,
        value: 0,
    })
}

/// Validate an `EvmCfg` the owner is about to store.
pub fn validate_cfg(cfg: &EvmCfg) -> bool {
    TESTNET_CHAIN_IDS.contains(&cfg.chain_id)
        && cfg.max_priority_ceiling > 0
        && cfg.max_priority_ceiling <= cfg.max_fee_ceiling
        && cfg.min_value > 0
        && cfg.min_unknown_age_ns >= MIN_UNKNOWN_AGE_FLOOR_NS
}

// ---- lane ---------------------------------------------------------------------------------------

/// The nonce an acquisition would use: refused unless the lane is seeded and free.
pub fn lane_peek(lane: &Lane) -> Result<u64, PurserError> {
    let nonce = lane.next_nonce.ok_or(PurserError::EvmLaneUnseeded)?;
    if lane.in_flight.is_some() {
        return Err(PurserError::EvmLaneBusy);
    }
    Ok(nonce)
}

/// Hold the lane for `cid` (Reserved/Signed/Unknown). Returns the nonce the transaction must use.
pub fn lane_hold(lane: &mut Lane, cid: CommitmentId) -> Result<u64, PurserError> {
    let nonce = lane_peek(lane)?;
    lane.in_flight = Some(cid);
    Ok(nonce)
}

/// Free the lane when a commitment reaches Confirmed/Cancelled: `next_nonce = max(next_nonce, nonce + 1)`
/// (a `Cancelled -> Confirmed` contradiction reuses the same nonce, so it can never advance twice) and
/// `in_flight` is cleared ONLY if it still names `cid`.
pub fn lane_release(lane: &mut Lane, cid: CommitmentId, nonce: u64) -> Result<(), PurserError> {
    let next = nonce
        .checked_add(1)
        .ok_or(PurserError::ArithmeticOverflow)?;
    lane.next_nonce = Some(lane.next_nonce.map_or(next, |n| n.max(next)));
    if lane.in_flight == Some(cid) {
        lane.in_flight = None;
    }
    Ok(())
}

/// Owner seed: one-shot while `next_nonce` is `None`; a later re-seed only if the lane is empty and the
/// new value is not lower than the current one (a lowered nonce would reuse a burnt one).
pub fn lane_seed(lane: &mut Lane, nonce: u64) -> Result<(), PurserError> {
    if lane.in_flight.is_some() {
        return Err(PurserError::EvmNonceRefused);
    }
    if let Some(current) = lane.next_nonce {
        if nonce < current {
            return Err(PurserError::EvmNonceRefused);
        }
    }
    lane.next_nonce = Some(nonce);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::Value;
    use proptest::prelude::*;
    use sha3::{Digest, Keccak256};

    fn keccak(b: &[u8]) -> [u8; 32] {
        Keccak256::digest(b).into()
    }

    fn unhex(s: &str) -> Vec<u8> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn tx_from(v: &Value) -> Eip1559Unsigned {
        let n = |k: &str| v[k].as_str().unwrap().to_string();
        Eip1559Unsigned {
            chain_id: n("chain_id").parse().unwrap(),
            nonce: n("nonce").parse().unwrap(),
            max_priority_fee_per_gas: n("max_priority_fee_per_gas").parse().unwrap(),
            max_fee_per_gas: n("max_fee_per_gas").parse().unwrap(),
            gas_limit: n("gas_limit").parse().unwrap(),
            to: unhex(&n("to")).try_into().unwrap(),
            value: n("value").parse().unwrap(),
        }
    }

    /// Independent oracle: the parity `rlp` crate for the bytes, `sha3` for the hash.
    fn oracle(tx: &Eip1559Unsigned) -> (Vec<u8>, [u8; 32]) {
        let mut s = rlp::RlpStream::new_list(9);
        s.append(&tx.chain_id)
            .append(&tx.nonce)
            .append(&tx.max_priority_fee_per_gas)
            .append(&tx.max_fee_per_gas);
        s.append(&tx.gas_limit)
            .append(&tx.to.as_slice())
            .append(&tx.value)
            .append_empty_data()
            .begin_list(0);
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&s.out());
        (bytes.clone(), Keccak256::digest(&bytes).into())
    }

    /// The same oracle for the signed form (12 fields).
    fn oracle_signed(tx: &Eip1559Unsigned, sig: &EvmSig) -> (Vec<u8>, [u8; 32]) {
        let strip = |b: &[u8; 32]| -> Vec<u8> {
            let first = b.iter().position(|x| *x != 0).unwrap_or(32);
            b[first..].to_vec()
        };
        let mut s = rlp::RlpStream::new_list(12);
        s.append(&tx.chain_id)
            .append(&tx.nonce)
            .append(&tx.max_priority_fee_per_gas)
            .append(&tx.max_fee_per_gas);
        s.append(&tx.gas_limit)
            .append(&tx.to.as_slice())
            .append(&tx.value)
            .append_empty_data()
            .begin_list(0);
        s.append(&sig.y_parity)
            .append(&strip(&sig.r))
            .append(&strip(&sig.s));
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&s.out());
        (bytes.clone(), Keccak256::digest(&bytes).into())
    }

    fn vectors() -> Vec<Value> {
        let file: Value = near_sdk::serde_json::from_str(include_str!(
            "../tests/fixtures/evm-spike-vectors.json"
        ))
        .unwrap();
        file["vectors"].as_array().unwrap().clone()
    }

    fn cfg() -> EvmCfg {
        EvmCfg {
            chain_id: 11_155_111,
            max_fee_ceiling: 40_000_000_000,
            max_priority_ceiling: 2_000_000_000,
            min_value: 1_000,
            min_unknown_age_ns: MIN_UNKNOWN_AGE_FLOOR_NS,
        }
    }

    fn lane() -> Lane {
        Lane {
            path: "p".into(),
            chain_id: 11_155_111,
            pubkey: [7u8; 64],
            address: [9u8; 20],
            next_nonce: None,
            in_flight: None,
        }
    }

    // ---- encoder: the 36 vectors and the oracles (moved from the spike) -----------------------

    #[test]
    fn matches_every_viem_and_chainsig_vector() {
        let vectors = vectors();
        assert_eq!(vectors.len(), 36, "the fixture generator emits 36 vectors");
        let (mut short, mut long) = (0, 0);
        for v in &vectors {
            let tx = tx_from(v);
            let bytes = encode_unsigned(&tx);
            assert_eq!(
                bytes,
                unhex(v["unsigned_serialized"].as_str().unwrap()),
                "rlp bytes: {}",
                v["name"]
            );
            assert_eq!(
                sighash(&tx, keccak).to_vec(),
                unhex(v["sighash"].as_str().unwrap()),
                "sighash: {}",
                v["name"]
            );
            if bytes[1] >= 0xf8 {
                long += 1
            } else {
                short += 1
            }
        }
        assert!(
            short > 0 && long > 0,
            "both RLP list-header forms must be covered ({short} short, {long} long)"
        );
    }

    #[test]
    fn integer_boundaries_agree_with_the_rlp_crate() {
        let edges_u128 = [
            0u128,
            1,
            0x7f,
            0x80,
            0xff,
            0x100,
            u64::MAX as u128,
            u64::MAX as u128 + 1,
            u128::MAX,
        ];
        let edges_u64 = [0u64, 1, 0x7f, 0x80, 0xff, 0x100, u64::MAX];
        for &fee in &edges_u128 {
            for &n in &edges_u64 {
                let tx = Eip1559Unsigned {
                    chain_id: n,
                    nonce: n,
                    max_priority_fee_per_gas: fee,
                    max_fee_per_gas: fee,
                    gas_limit: n,
                    to: [0u8; 20],
                    value: fee,
                };
                let (bytes, hash) = oracle(&tx);
                assert_eq!(encode_unsigned(&tx), bytes);
                assert_eq!(sighash(&tx, keccak), hash);
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]
        #[test]
        fn random_transactions_match_the_rlp_crate_and_sha3(
            chain_id in any::<u64>(), nonce in any::<u64>(), tip in any::<u128>(), cap in any::<u128>(),
            gas in any::<u64>(), to in any::<[u8; 20]>(), value in any::<u128>(),
        ) {
            let tx = Eip1559Unsigned { chain_id, nonce, max_priority_fee_per_gas: tip, max_fee_per_gas: cap, gas_limit: gas, to, value };
            let (bytes, hash) = oracle(&tx);
            prop_assert_eq!(encode_unsigned(&tx), bytes);
            prop_assert_eq!(sighash(&tx, keccak), hash);
        }

        #[test]
        fn random_signed_transactions_match_the_rlp_crate_and_sha3(
            chain_id in any::<u64>(), nonce in any::<u64>(), tip in any::<u128>(), cap in any::<u128>(),
            gas in any::<u64>(), to in any::<[u8; 20]>(), value in any::<u128>(),
            r in any::<[u8; 32]>(), s in any::<[u8; 32]>(), y in 0u8..=1,
        ) {
            let tx = Eip1559Unsigned { chain_id, nonce, max_priority_fee_per_gas: tip, max_fee_per_gas: cap, gas_limit: gas, to, value };
            let sig = EvmSig { r, s, y_parity: y };
            let (bytes, hash) = oracle_signed(&tx, &sig);
            prop_assert_eq!(encode_signed(&tx, &sig), bytes);
            prop_assert_eq!(tx_hash(&tx, &sig, keccak), hash);
        }
    }

    // ---- signed assembly -----------------------------------------------------------------------

    #[test]
    fn signed_assembly_over_every_vector_extends_the_unsigned_fields_and_matches_the_oracle() {
        for (i, v) in vectors().iter().enumerate() {
            let tx = tx_from(v);
            // Distinct r/s shapes: full 32 bytes, leading zeros (minimal encoding), and a tiny scalar.
            let mut r = [0xabu8; 32];
            let mut s = [0xcdu8; 32];
            match i % 3 {
                1 => {
                    r[0] = 0;
                    r[1] = 0;
                    s[0] = 0;
                }
                2 => {
                    r = [0u8; 32];
                    r[31] = 0x05;
                    s = [0u8; 32];
                    s[31] = 0x81;
                }
                _ => {}
            }
            let sig = EvmSig {
                r,
                s,
                y_parity: (i % 2) as u8,
            };
            let raw = encode_signed(&tx, &sig);
            let (want, want_hash) = oracle_signed(&tx, &sig);
            assert_eq!(raw, want, "signed bytes: {}", v["name"]);
            assert_eq!(tx_hash(&tx, &sig, keccak), want_hash);
            assert_eq!(raw[0], 0x02, "typed-tx prefix");
            assert_ne!(raw, encode_unsigned(&tx));
        }
    }

    #[test]
    fn signed_y_parity_zero_is_the_empty_string_and_one_is_a_single_byte() {
        let tx = tx_from(&vectors()[0]);
        let sig0 = EvmSig {
            r: [1u8; 32],
            s: [2u8; 32],
            y_parity: 0,
        };
        let sig1 = EvmSig {
            y_parity: 1,
            ..sig0
        };
        let (a, b) = (encode_signed(&tx, &sig0), encode_signed(&tx, &sig1));
        // 0x80 (zero) vs 0x01: same length difference of zero bytes, a different byte in the same place
        assert_eq!(a.len(), b.len());
        let at = a.len() - (1 + 32 + 1 + 32);
        assert_eq!((a[at - 1], b[at - 1]), (0x80, 0x01));
    }

    // ---- hex, address -------------------------------------------------------------------------

    #[test]
    fn address_parsing_is_case_insensitive_and_strict() {
        let lower = parse_address("0x52908400098527886e0f7030069857d2e4169ee7").unwrap();
        let mixed = parse_address("0x52908400098527886E0F7030069857D2E4169EE7").unwrap();
        assert_eq!(lower, mixed);
        assert_eq!(
            to_hex0x(&lower),
            "0x52908400098527886e0f7030069857d2e4169ee7"
        );
        for bad in [
            "",
            "0x",
            "52908400098527886e0f7030069857d2e4169ee7", // no prefix
            "0X52908400098527886e0f7030069857d2e4169ee7", // upper X
            "0x52908400098527886e0f7030069857d2e4169ee", // 39 digits
            "0x52908400098527886e0f7030069857d2e4169ee78", // 41 digits
            "0x52908400098527886e0f7030069857d2e4169eeg", // non-hex
            " 0x52908400098527886e0f7030069857d2e4169ee7",
        ] {
            assert!(parse_address(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn address_of_is_the_last_20_bytes_of_the_keccak() {
        let key = [0x42u8; 64];
        let a = address_of(&key, keccak);
        assert_eq!(a.to_vec(), keccak(&key)[12..].to_vec());
    }

    #[test]
    fn hex_round_trips_and_rejects_wrong_lengths() {
        let b = [0u8, 1, 0xab, 0xff];
        assert_eq!(to_hex(&b), "0001abff");
        assert_eq!(from_hex::<4>("0x0001ABff"), Some(b));
        assert_eq!(from_hex::<4>("0001abff"), Some(b));
        assert_eq!(from_hex::<4>("0001abf"), None);
        assert_eq!(from_hex::<3>("0001abff"), None);
        assert_eq!(from_hex::<4>("0001abfg"), None);
    }

    // ---- fee math -------------------------------------------------------------------------------

    #[test]
    fn bump_is_ceil_of_12_5_percent_on_every_value() {
        assert_eq!(bump_fee(0), Some(0));
        assert_eq!(bump_fee(1), Some(2), "ceil(1.125)");
        assert_eq!(bump_fee(8), Some(9), "exact 12.5%");
        assert_eq!(bump_fee(7), Some(8), "ceil(7.875)");
        assert_eq!(bump_fee(9), Some(11), "ceil(10.125)");
        assert_eq!(bump_fee(1_000_000_000), Some(1_125_000_000));
        assert_eq!(
            bump_fee(u128::MAX),
            None,
            "overflow is refused, not wrapped"
        );
        assert_eq!(
            bump_fee(u128::MAX / 1250),
            Some(u128::MAX / 1250 + (u128::MAX / 1250).div_ceil(8))
        );
        assert_eq!(bump_fee(u128::MAX / 1250 + 1), None);
        // always at least geth's 10% price bump, for every non-zero value
        for p in 1u128..2000 {
            assert!(bump_fee(p).unwrap() * 10 >= p * 11, "{p}");
        }
    }

    proptest! {
        #[test]
        fn bump_is_the_least_value_at_or_above_1_125_times(p in 0u128..(u128::MAX / 10_000)) {
            let b = bump_fee(p).unwrap();
            // b >= 1.125 p and (b - 1) < 1.125 p, in integers: 8b >= 9p and 8(b-1) < 9p
            prop_assert!(b.checked_mul(8).unwrap() >= p.checked_mul(9).unwrap());
            if b > 0 {
                prop_assert!((b - 1).checked_mul(8).unwrap() < p.checked_mul(9).unwrap());
            }
        }
    }

    // ---- builder validation: every refused input ----------------------------------------------

    const TO: [u8; 20] = [0x11; 20];

    #[test]
    fn original_uses_the_ceiling_fees_a_fixed_gas_limit_and_the_given_fields() {
        let tx = build_original(&cfg(), 11_155_111, 7, TO, 5_000).unwrap();
        assert_eq!(tx.max_fee_per_gas, cfg().max_fee_ceiling);
        assert_eq!(tx.max_priority_fee_per_gas, cfg().max_priority_ceiling);
        assert_eq!(
            (tx.gas_limit, tx.nonce, tx.value, tx.to),
            (21_000, 7, 5_000, TO)
        );
    }

    #[test]
    fn original_refuses_every_bad_input() {
        let c = cfg();
        let ok = |chain, to, value| build_original(&c, chain, 0, to, value);
        assert_eq!(
            ok(1, TO, 5_000),
            Err(PurserError::UnsupportedChain),
            "mainnet"
        );
        assert_eq!(ok(0, TO, 5_000), Err(PurserError::UnsupportedChain));
        assert_eq!(
            ok(17000, TO, 5_000),
            Err(PurserError::UnsupportedChain),
            "not cfg chain"
        );
        assert_eq!(
            ok(11_155_111, [0u8; 20], 5_000),
            Err(PurserError::InvalidRecipient)
        );
        assert_eq!(ok(11_155_111, TO, 0), Err(PurserError::EvmValueTooLow));
        assert_eq!(
            ok(11_155_111, TO, 999),
            Err(PurserError::EvmValueTooLow),
            "below min_value"
        );
        assert!(ok(11_155_111, TO, 1_000).is_ok(), "exactly min_value");
        // a bad config is refused at build time too (defense in depth behind validate_cfg)
        for bad in [
            EvmCfg {
                max_priority_ceiling: 0,
                ..c
            },
            EvmCfg {
                max_priority_ceiling: c.max_fee_ceiling + 1,
                ..c
            },
            EvmCfg { chain_id: 1, ..c },
        ] {
            assert!(build_original(&bad, bad.chain_id, 0, TO, 5_000).is_err());
        }
    }

    #[test]
    fn cfg_validation_refuses_mainnet_zero_and_short_ages() {
        let c = cfg();
        assert!(validate_cfg(&c));
        assert!(!validate_cfg(&EvmCfg { chain_id: 1, ..c }));
        assert!(!validate_cfg(&EvmCfg { chain_id: 137, ..c }));
        assert!(!validate_cfg(&EvmCfg {
            max_priority_ceiling: 0,
            ..c
        }));
        assert!(!validate_cfg(&EvmCfg {
            max_priority_ceiling: c.max_fee_ceiling + 1,
            ..c
        }));
        assert!(!validate_cfg(&EvmCfg { min_value: 0, ..c }));
        assert!(!validate_cfg(&EvmCfg {
            min_unknown_age_ns: MIN_UNKNOWN_AGE_FLOOR_NS - 1,
            ..c
        }));
        assert!(validate_cfg(&EvmCfg {
            min_unknown_age_ns: MIN_UNKNOWN_AGE_FLOOR_NS,
            ..c
        }));
    }

    #[test]
    fn cancel_is_a_zero_value_self_send_at_the_same_nonce() {
        let c = cfg();
        let orig = build_original(&c, 11_155_111, 3, TO, 5_000).unwrap();
        let tx = build_cancel(&c, 11_155_111, 3, [9u8; 20], 1_000, 100, 1_125, 113).unwrap();
        assert_eq!(
            (tx.nonce, tx.value, tx.to, tx.gas_limit),
            (3, 0, [9u8; 20], 21_000)
        );
        assert_ne!(tx.to, orig.to);
        assert_eq!(
            (tx.max_fee_per_gas, tx.max_priority_fee_per_gas),
            (1_125, 113)
        );
    }

    #[test]
    fn cancel_refuses_every_fee_violation() {
        let c = cfg();
        let go = |fee, tip| build_cancel(&c, 11_155_111, 3, [9u8; 20], 1_000, 100, fee, tip);
        assert!(
            go(1_125, 113).is_ok(),
            "exactly ceil(1.125 x) on both fields"
        );
        assert_eq!(
            go(1_124, 113),
            Err(PurserError::EvmInvalidFee),
            "fee one below the bump"
        );
        assert_eq!(
            go(1_125, 112),
            Err(PurserError::EvmInvalidFee),
            "tip one below the bump"
        );
        assert_eq!(
            go(1_125, 1_126),
            Err(PurserError::EvmInvalidFee),
            "tip above max_fee"
        );
        assert_eq!(go(0, 0), Err(PurserError::EvmInvalidFee));
        assert_eq!(go(1_125, 0), Err(PurserError::EvmInvalidFee), "zero tip");
        assert_eq!(
            go(c.max_fee_ceiling + 1, 113),
            Err(PurserError::EvmInvalidFee),
            "above the fee ceiling"
        );
        assert_eq!(
            go(c.max_fee_ceiling, c.max_priority_ceiling + 1),
            Err(PurserError::EvmInvalidFee),
            "above the tip ceiling"
        );
        assert!(
            go(c.max_fee_ceiling, c.max_priority_ceiling).is_ok(),
            "at the ceilings"
        );
        assert_eq!(
            build_cancel(&c, 1, 3, [9u8; 20], 1_000, 100, 1_125, 113),
            Err(PurserError::UnsupportedChain)
        );
        // a bump that itself overflows is refused, not wrapped
        assert_eq!(
            build_cancel(&c, 11_155_111, 3, [9u8; 20], u128::MAX, 100, u128::MAX, 113),
            Err(PurserError::EvmInvalidFee)
        );
    }

    #[test]
    fn cancel_cannot_be_priced_only_on_one_field() {
        // a tip bump alone, or a fee bump alone, is not a replacement
        let c = cfg();
        assert!(build_cancel(&c, 11_155_111, 0, [9; 20], 1_000, 100, 1_000, 200).is_err());
        assert!(build_cancel(&c, 11_155_111, 0, [9; 20], 1_000, 100, 2_000, 100).is_err());
    }

    // ---- sighash scalar range ------------------------------------------------------------------

    #[test]
    fn sighash_must_be_a_secp256k1_scalar() {
        assert!(!sighash_in_range(&[0u8; 32]), "zero");
        let mut n = SECP256K1_ORDER;
        assert!(!sighash_in_range(&n), "n itself");
        n[31] -= 1;
        assert!(sighash_in_range(&n), "n - 1");
        assert!(!sighash_in_range(&[0xffu8; 32]), "2^256 - 1");
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(sighash_in_range(&one));
    }

    #[test]
    fn every_vector_sighash_is_in_range() {
        for v in vectors() {
            assert!(sighash_in_range(&sighash(&tx_from(&v), keccak)));
        }
    }

    // ---- lane ---------------------------------------------------------------------------------

    #[test]
    fn an_unseeded_lane_refuses_and_a_busy_lane_refuses() {
        let mut l = lane();
        assert_eq!(lane_hold(&mut l, 1), Err(PurserError::EvmLaneUnseeded));
        assert_eq!(l.in_flight, None, "a refusal holds nothing");
        lane_seed(&mut l, 5).unwrap();
        assert_eq!(lane_hold(&mut l, 1), Ok(5));
        assert_eq!(lane_hold(&mut l, 2), Err(PurserError::EvmLaneBusy));
        assert_eq!(
            l.in_flight,
            Some(1),
            "the second proposer did not steal the lane"
        );
        assert_eq!(l.next_nonce, Some(5), "holding does not advance the nonce");
    }

    #[test]
    fn release_advances_with_max_and_clears_only_its_own_hold() {
        let mut l = lane();
        lane_seed(&mut l, 5).unwrap();
        lane_hold(&mut l, 1).unwrap();
        // a stale release for another cid never frees the lane
        lane_release(&mut l, 99, 5).unwrap();
        assert_eq!(l.in_flight, Some(1));
        assert_eq!(l.next_nonce, Some(6), "but the nonce still advanced");
        lane_release(&mut l, 1, 5).unwrap();
        assert_eq!((l.in_flight, l.next_nonce), (None, Some(6)));
        // an older nonce can never move it backwards (Cancelled -> Confirmed reuses the same nonce)
        lane_release(&mut l, 1, 5).unwrap();
        lane_release(&mut l, 0, 2).unwrap();
        assert_eq!(l.next_nonce, Some(6), "no double advance, no regression");
        // the next acquisition uses the advanced nonce
        assert_eq!(lane_hold(&mut l, 2), Ok(6));
        // a contradiction on the OLD cid does not free the new holder
        lane_release(&mut l, 1, 5).unwrap();
        assert_eq!(l.in_flight, Some(2), "cid 2 still holds the lane");
    }

    #[test]
    fn release_refuses_a_nonce_that_would_overflow() {
        let mut l = lane();
        lane_seed(&mut l, 1).unwrap();
        assert_eq!(
            lane_release(&mut l, 1, u64::MAX),
            Err(PurserError::ArithmeticOverflow)
        );
        assert_eq!(l.next_nonce, Some(1));
    }

    #[test]
    fn seeding_is_one_shot_then_monotonic_and_only_on_an_empty_lane() {
        let mut l = lane();
        lane_seed(&mut l, 5).unwrap();
        assert_eq!(
            lane_seed(&mut l, 4),
            Err(PurserError::EvmNonceRefused),
            "lowered"
        );
        assert!(lane_seed(&mut l, 5).is_ok(), "same value is harmless");
        assert!(lane_seed(&mut l, 9).is_ok(), "raised on an empty lane");
        lane_hold(&mut l, 1).unwrap();
        assert_eq!(
            lane_seed(&mut l, 20),
            Err(PurserError::EvmNonceRefused),
            "not while a commitment is in flight"
        );
        assert_eq!(l.next_nonce, Some(9));
    }

    proptest! {
        /// Whatever order acquisitions and (possibly repeated, stale) releases arrive in, the nonce never
        /// goes backwards, and the lane is never held by two commitments at once.
        #[test]
        fn lane_nonce_is_monotonic_and_single_holder(ops in prop::collection::vec((0u8..3, 0u64..6, 0u64..8), 0..60)) {
            let mut l = lane();
            lane_seed(&mut l, 0).unwrap();
            let mut last = 0u64;
            for (op, cid, nonce) in ops {
                match op {
                    0 => { let _ = lane_hold(&mut l, cid); }
                    1 => { let _ = lane_release(&mut l, cid, nonce); }
                    _ => { let _ = lane_seed(&mut l, nonce); }
                }
                let n = l.next_nonce.unwrap();
                prop_assert!(n >= last, "nonce regressed {last} -> {n}");
                last = n;
            }
        }
    }
}
