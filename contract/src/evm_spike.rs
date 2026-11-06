//! EVM sighash FEASIBILITY SPIKE (stretch; docs/plans/2026-11-05-feat-evm-sighash-feasibility-spike-plan.md).
//!
//! Compiled ONLY with the `evm-spike` feature, which `build.rs` refuses without
//! `PURSER_ALLOW_EVM_SPIKE=1` and which `scripts/check-wasm-clean.sh` refuses to ship. It answers one
//! question: can the contract build an EIP-1559 transaction, RLP-encode it and hash it within NEAR size
//! and gas limits? That is the prerequisite for never blind-signing an EVM payment.
//!
//! Since Prompt 12 the encoder itself lives in the always-compiled, pure [`crate::evm_tx`]; this module is
//! only the measurement harness around it (a looped hash, and one raw export). The 36 vectors and the
//! `rlp`/`sha3` oracles moved to `evm_tx`'s tests. The spike marker strings live ONLY here, so a default
//! build never contains them and `scripts/check-wasm-clean.sh` can refuse a spike wasm.
//!
//! What it is NOT: it adds nothing to `propose_payment`, `open_reservation` or any `#[near]` method. The
//! raw export below exists only so a sandbox test can read gas; it is stateless, takes no deposit and makes
//! no promise. It is a plain `extern "C"` export (not `#[near]`), so it never appears in the ABI or in
//! `packages/types`. keccak is the NEAR host function (no wasm bytes); only the RLP encoder is code.

// The raw exports below exist only on wasm32, like near-sdk's own; on the host (unit tests, clippy, ABI generation)
// the helpers they call are used by the tests only.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use crate::evm_tx::{self, Eip1559Unsigned};
use near_sdk::env;

/// Embedded in every spike wasm (and logged by the exports so `lto` cannot drop it).
/// `scripts/check-wasm-clean.sh` keeps its own copy of this string; a test keeps them equal.
pub const EVM_SPIKE_MARKER: &str = "PURSER_EVM_SPIKE_MEASUREMENT_ONLY";

/// Upper bound on the amortization loop: the exports are public in a sandbox wasm, so cap the work.
/// The host test pins the clamp and the sandbox test runs exactly this many rounds unclamped.
const MAX_REPEAT: u32 = 1000;
/// Fixed binary input (binary, not JSON, so parsing adds no wasm size to the delta under test): chain_id u64 | nonce u64 | max_priority_fee u128 | max_fee u128 | gas_limit u64 |
/// to [u8;20] | value u128 | repeat u32, all big-endian. No JSON, so parsing adds no size to the delta.
const INPUT_LEN: usize = 8 + 8 + 16 + 16 + 8 + 20 + 16 + 4;

/// The 32-byte signing hash, through the shared encoder. keccak256 is the NEAR host function.
pub(crate) fn sighash(tx: &Eip1559Unsigned) -> [u8; 32] {
    evm_tx::sighash(tx, |b| env::keccak256_array(b))
}

fn be<const N: usize>(input: &[u8], at: usize) -> [u8; N] {
    input[at..at + N]
        .try_into()
        .unwrap_or_else(|_| env::panic_str("evm spike: bad slice"))
}

fn parse(input: &[u8]) -> (Eip1559Unsigned, u32) {
    if input.len() != INPUT_LEN {
        env::panic_str(&format!(
            "evm spike: input must be exactly {INPUT_LEN} bytes"
        ));
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

/// Spike export: the sighash of the `INPUT_LEN`-byte input, looped `repeat` times; returns 32 bytes.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn evm_spike_sighash() {
    env::log_str(EVM_SPIKE_MARKER);
    let input = env::input().unwrap_or_else(|| env::panic_str("evm spike: no input"));
    let (tx, repeat) = parse(&input);
    env::value_return(&run(tx, repeat));
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha3::{Digest, Keccak256};

    /// The fold rule itself is checked against an independent reference in the sandbox test
    /// (`reference_digest`, repeat 2/3/10/100/1000); here: round 1 is the plain sighash, later rounds differ,
    /// and the clamp holds.
    #[test]
    fn the_loop_starts_at_the_plain_sighash_differs_per_round_and_clamps() {
        let start = Eip1559Unsigned {
            chain_id: 11155111,
            nonce: 7,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 21000,
            to: [0x11; 20],
            value: 10u128.pow(16),
        };
        let plain: [u8; 32] = Keccak256::digest(evm_tx::encode_unsigned(&start)).into();
        assert_eq!(run(start, 1), plain, "repeat = 1 is the plain sighash");
        assert_ne!(
            run(start, 1),
            run(start, 2),
            "round 2 must differ from round 1"
        );
        assert_eq!(run(start, 0), run(start, 1), "repeat 0 is clamped up to 1");
        assert_eq!(
            run(start, u32::MAX),
            run(start, MAX_REPEAT),
            "repeat above MAX_REPEAT is clamped to MAX_REPEAT"
        );
        assert_ne!(
            run(start, MAX_REPEAT),
            run(start, MAX_REPEAT - 1),
            "MAX_REPEAT itself is not clamped further"
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
}
