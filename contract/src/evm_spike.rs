//! EVM sighash FEASIBILITY SPIKE (stretch; docs/plans/2026-11-05-feat-evm-sighash-feasibility-spike-plan.md).
//!
//! Compiled ONLY with the `evm-spike` feature, which `build.rs` refuses without
//! `PURSER_ALLOW_EVM_SPIKE=1` and which `scripts/check-wasm-clean.sh` refuses to ship. It answers one
//! question: can the contract build an EIP-1559 transaction, RLP-encode it and hash it within NEAR size
//! and gas limits? That is the prerequisite for never blind-signing an EVM payment.
//!
//! What it is NOT: it is not wired into `propose_payment`, `open_reservation` or `payload_scheme()`, and
//! `Chain::Evm` is still rejected. [`sighash`] is `pub(crate)`: nothing outside this crate can ask the
//! contract for a signable digest over caller-supplied fields. The two raw exports below exist only so a
//! sandbox test can read gas; they are stateless, take no deposit and make no promise. They are plain
//! `extern "C"` exports (not `#[near]`), so they never appear in the ABI or in `packages/types`.
//!
//! The digest is `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas,
//! gas_limit, to, value, data, access_list]))` with `data` and `access_list` always empty: exactly the
//! native-transfer shape a payment needs. keccak is the NEAR host function (no wasm bytes); only the RLP
//! encoder is code.

// The raw exports below exist only on wasm32, like near-sdk's own; on the host (unit tests, clippy, ABI generation)
// the helpers they call are used by the tests only.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use near_sdk::env;

/// Embedded in every spike wasm (and logged by the exports so `lto` cannot drop it).
/// `scripts/check-wasm-clean.sh` keeps its own copy of this string; a test keeps them equal.
pub const EVM_SPIKE_MARKER: &str = "PURSER_EVM_SPIKE_MEASUREMENT_ONLY";

/// Upper bound on the amortization loop: the exports are public in a sandbox wasm, so cap the work.
const MAX_REPEAT: u32 = 1000;
/// Fixed binary input: chain_id u64 | nonce u64 | max_priority_fee u128 | max_fee u128 | gas_limit u64 |
/// to [u8;20] | value u128 | repeat u32, all big-endian. No JSON, so parsing adds no size to the delta.
const INPUT_LEN: usize = 8 + 8 + 16 + 16 + 8 + 20 + 16 + 4;

/// An unsigned EIP-1559 native transfer. `u128` bounds the fee and value fields (real EVM fields are 256-bit;
/// the bound is deliberate and recorded in the spike's "does not establish" list).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Eip1559Unsigned {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
}

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

/// RLP of an unsigned integer: minimal big-endian bytes, zero is the empty string (`0x80`).
fn push_uint(out: &mut Vec<u8>, v: u128) {
    let be = v.to_be_bytes();
    let first = be.iter().position(|b| *b != 0).unwrap_or(be.len());
    push_string(out, &be[first..]);
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

/// `0x02 || rlp([... , data = "", access_list = []])`, the exact bytes that are hashed.
pub(crate) fn encode_unsigned(tx: &Eip1559Unsigned) -> Vec<u8> {
    let mut body = Vec::with_capacity(96);
    push_uint(&mut body, tx.chain_id as u128);
    push_uint(&mut body, tx.nonce as u128);
    push_uint(&mut body, tx.max_priority_fee_per_gas);
    push_uint(&mut body, tx.max_fee_per_gas);
    push_uint(&mut body, tx.gas_limit as u128);
    push_string(&mut body, &tx.to);
    push_uint(&mut body, tx.value);
    body.push(0x80); // data: empty
    body.push(0xc0); // access_list: empty
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(0x02);
    push_list_header(&mut out, body.len());
    out.extend_from_slice(&body);
    out
}

/// The 32-byte signing hash. keccak256 is the NEAR host function.
pub(crate) fn sighash(tx: &Eip1559Unsigned) -> [u8; 32] {
    env::keccak256_array(encode_unsigned(tx))
}

fn be<const N: usize>(input: &[u8], at: usize) -> [u8; N] {
    input[at..at + N]
        .try_into()
        .unwrap_or_else(|_| env::panic_str("evm spike: bad slice"))
}

fn parse(input: &[u8]) -> (Eip1559Unsigned, u32) {
    if input.len() != INPUT_LEN {
        env::panic_str("evm spike: input must be exactly 96 bytes");
    }
    let tx = Eip1559Unsigned {
        chain_id: u64::from_be_bytes(be(input, 0)),
        nonce: u64::from_be_bytes(be(input, 8)),
        max_priority_fee_per_gas: u128::from_be_bytes(be(input, 16)),
        max_fee_per_gas: u128::from_be_bytes(be(input, 32)),
        gas_limit: u64::from_be_bytes(be(input, 48)),
        to: be(input, 56),
        value: u128::from_be_bytes(be(input, 76)),
    };
    (tx, u32::from_be_bytes(be(input, 92)))
}

/// Hash `repeat` times (clamped to 1..=1000). Iteration 1 hashes the input exactly, so `repeat = 1` is the
/// plain sighash. Every later iteration changes the nonce and folds the previous digest into `value`, so each
/// round is a different input: the optimizer cannot hoist or fold the loop, and gas must grow with `repeat`.
fn run(mut tx: Eip1559Unsigned, repeat: u32) -> [u8; 32] {
    let mut digest = [0u8; 32];
    for _ in 0..repeat.clamp(1, MAX_REPEAT) {
        digest = sighash(core::hint::black_box(&tx));
        tx.nonce = tx.nonce.wrapping_add(1);
        tx.value ^= u128::from_be_bytes(be(&digest, 0));
    }
    digest
}

/// Spike export: the sighash of the 96-byte input (see `INPUT_LEN`), looped `repeat` times; returns 32 bytes.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn evm_spike_sighash() {
    env::log_str(EVM_SPIKE_MARKER);
    let input = env::input().unwrap_or_else(|| env::panic_str("evm spike: no input"));
    let (tx, repeat) = parse(&input);
    env::value_return(&run(tx, repeat));
}

/// Spike export: parses the same input and does nothing else; the fixed-cost baseline for gas.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn evm_spike_noop() {
    env::log_str(EVM_SPIKE_MARKER);
    let input = env::input().unwrap_or_else(|| env::panic_str("evm spike: no input"));
    let _ = parse(&input);
    env::value_return(&[0u8; 32]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::Value;
    use proptest::prelude::*;
    use sha3::{Digest, Keccak256};

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

    #[test]
    fn matches_every_viem_and_chainsig_vector() {
        let file: Value = near_sdk::serde_json::from_str(include_str!(
            "../tests/fixtures/evm-spike-vectors.json"
        ))
        .unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 30, "fixture is too small to mean anything");
        let (mut short, mut long) = (0, 0);
        for v in vectors {
            let tx = tx_from(v);
            let bytes = encode_unsigned(&tx);
            assert_eq!(
                bytes,
                unhex(v["unsigned_serialized"].as_str().unwrap()),
                "rlp bytes: {}",
                v["name"]
            );
            assert_eq!(
                sighash(&tx).to_vec(),
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
                assert_eq!(sighash(&tx), hash);
            }
        }
    }

    #[test]
    fn the_looped_export_path_matches_an_independent_reference() {
        let start = Eip1559Unsigned {
            chain_id: 11155111,
            nonce: 7,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 21000,
            to: [0x11; 20],
            value: 10u128.pow(16),
        };
        let mut reference = start;
        for n in 1..=7u32 {
            let want = oracle(&reference).1;
            reference.nonce += 1;
            reference.value ^= u128::from_be_bytes(want[..16].try_into().unwrap());
            assert_eq!(run(start, n), want, "repeat = {n}");
        }
        assert_ne!(
            run(start, 1),
            run(start, 2),
            "later rounds must differ, or the loop could be folded"
        );
        assert_eq!(
            run(start, 0),
            run(start, 1),
            "repeat is clamped to at least 1"
        );
        assert_eq!(
            run(start, u32::MAX),
            run(start, MAX_REPEAT),
            "repeat is clamped to the cap"
        );
    }

    #[test]
    fn input_layout_round_trips() {
        let mut input = Vec::new();
        input.extend_from_slice(&11155111u64.to_be_bytes());
        input.extend_from_slice(&7u64.to_be_bytes());
        input.extend_from_slice(&5u128.to_be_bytes());
        input.extend_from_slice(&9u128.to_be_bytes());
        input.extend_from_slice(&21000u64.to_be_bytes());
        input.extend_from_slice(&[0xab; 20]);
        input.extend_from_slice(&1000u128.to_be_bytes());
        input.extend_from_slice(&3u32.to_be_bytes());
        assert_eq!(input.len(), INPUT_LEN);
        let (tx, repeat) = parse(&input);
        assert_eq!(
            (
                tx.chain_id,
                tx.nonce,
                tx.max_priority_fee_per_gas,
                tx.max_fee_per_gas
            ),
            (11155111, 7, 5, 9)
        );
        assert_eq!(
            (tx.gas_limit, tx.to, tx.value, repeat),
            (21000, [0xab; 20], 1000, 3)
        );
    }

    #[test]
    fn marker_matches_the_check_script() {
        let script = include_str!("../../scripts/check-wasm-clean.sh");
        assert!(
            script.contains(&format!("'{EVM_SPIKE_MARKER}'")),
            "scripts/check-wasm-clean.sh must carry the same marker"
        );
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
            prop_assert_eq!(sighash(&tx), hash);
        }
    }
}
