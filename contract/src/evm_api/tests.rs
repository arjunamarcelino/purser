//! Host tests for the EVM `#[near]` surface under near-sdk's mocked VM.
//!
//! PromiseResult INJECTION: a `#[callback_result]` method is an ordinary method whose last argument is the
//! `Result<T, PromiseError>` the generated wrapper would have decoded from the promise result, so these tests
//! call `on_signed` / `on_cancel_signed` directly with `Ok(json)` or `Err(PromiseError::Failed)` for EVERY row
//! of the totality tables. The wrapper's own JSON decoding is exercised by the sandbox tests (mock signer).
//! Signatures are real: a `k256` test key signs the contract-built digest and the contract's own
//! `env::ecrecover` (the mocked host function) has to accept or reject it, so "valid" is never faked.

use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::serde_json;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseError};

use crate::RECONCILE_MIN_AGE_NS;

const OWNER: &str = "owner.test";
const RELAYER: &str = "relayer.test";
const DELEGATE: &str = "agent.test";
const SIGNER: &str = "signer.test";
const CONTRACT: &str = "purser.test";
const PATH: &str = "path-a";
const TASK: &str = "t1";
const CHAIN: u64 = 11_155_111;
const TO: &str = "0x52908400098527886E0F7030069857D2E4169EE7";
const FLOOR: u64 = evm_tx::MIN_UNKNOWN_AGE_FLOOR_NS;
const MIN_AGE: u64 = FLOOR;
const T0: u64 = 1_000;
/// A cancel priced at 2x the original's fee/tip (>= the 1.125x bump).
const CANCEL_FEE: u128 = 80_000_000_000;
const CANCEL_TIP: u128 = 4_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// `testing_env!` carries the mocked storage over from the previous context (so state can persist across
/// calls); a test that builds a fresh contract must start from empty storage.
fn reset_storage() {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
}

/// Reset the mocked VM (fresh logs) as `pred` at block time `ts`.
fn as_(pred: &str, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .block_timestamp(ts)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

struct Key {
    sk: SigningKey,
    pubkey: [u8; 64],
}

impl Key {
    fn new(seed: u8) -> Self {
        let sk = SigningKey::from_bytes(&[seed; 32].into()).unwrap();
        let point = sk.verifying_key().to_encoded_point(false);
        let pubkey: [u8; 64] = point.as_bytes()[1..].try_into().unwrap();
        Key { sk, pubkey }
    }
    fn sign(&self, digest: &[u8; 32]) -> EvmSig {
        let (sig, rid) = self.sk.sign_prehash_recoverable(digest).unwrap();
        let bytes = sig.to_bytes();
        EvmSig {
            r: bytes[..32].try_into().unwrap(),
            s: bytes[32..].try_into().unwrap(),
            y_parity: rid.to_byte(),
        }
    }
    fn near_string(&self) -> String {
        format!(
            "secp256k1:{}",
            near_sdk::bs58::encode(self.pubkey).into_string()
        )
    }
}

/// The signer's wire response for `sig`.
fn response(sig: &EvmSig) -> Value {
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("02{}", evm_tx::to_hex(&sig.r)) },
        "s": { "scalar": evm_tx::to_hex(&sig.s) },
        "recovery_id": sig.y_parity,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Arrival {
    Valid,
    /// Well-formed, but signed by another key.
    WrongKey,
    Err,
}

struct World {
    // Never dropped: `near_sdk::store` collections flush on drop, which would write the previous test world's
    // state into the NEXT mocked VM's storage.
    p: std::mem::ManuallyDrop<Purser>,
    key: Key,
    other: Key,
    now: u64,
}

fn intent(amount: u128) -> PaymentIntent {
    PaymentIntent {
        chain: Chain::Evm { chain_id: CHAIN },
        recipient: TO.to_string(),
        amount: yocto(amount),
        token: TokenSpec::NearNative,
        memo: None,
    }
}

impl World {
    /// Configured, EVM-enabled, delegate added, key cached, lane seeded at nonce 5, relayer set.
    fn new() -> Self {
        reset_storage();
        let key = Key::new(0x11);
        let other = Key::new(0x22);
        as_(OWNER, T0);
        let mut p = Purser::new(acct(OWNER), acct(SIGNER));
        p.create_task(TASK.into(), yocto(100_000), TokenSpec::NearNative, 3);
        p.set_evm_cfg(
            U64(CHAIN),
            U128(40_000_000_000),
            U128(2_000_000_000),
            U128(1_000),
            U64(MIN_AGE),
        );
        p.enable_evm_task(TASK.into());
        p.add_delegate(TASK.into(), acct(DELEGATE), PATH.into());
        p.set_relayer(acct(RELAYER));
        as_(CONTRACT, T0);
        p.on_derived_key(PATH.into(), U64(CHAIN), Ok(key.near_string()));
        as_(OWNER, T0);
        p.seed_evm_nonce(PATH.into(), U64(5));
        World {
            p: std::mem::ManuallyDrop::new(p),
            key,
            other,
            now: T0,
        }
    }

    fn at(&mut self, who: &str, dt: u64) {
        self.now += dt;
        as_(who, self.now);
    }

    fn propose(&mut self, amount: u128, req: &str) -> CommitmentId {
        self.at(DELEGATE, 1);
        match self
            .p
            .propose_payment(TASK.into(), intent(amount), req.into())
        {
            PromiseOrValue::Value(cid) => cid,
            PromiseOrValue::Promise(_) => self.p.next_commitment_id - 1,
        }
    }

    fn meta(&self, cid: CommitmentId) -> EvmMeta {
        self.p.evm_meta.get(&cid).unwrap().clone()
    }
    fn commit(&self, cid: CommitmentId) -> Commitment {
        self.p.commitments.get(&cid).unwrap().clone()
    }
    fn state(&self, cid: CommitmentId) -> ReservationState {
        self.commit(cid).state
    }
    fn task(&self) -> TaskBudget {
        self.p.tasks.get(&TASK.to_string()).unwrap().clone()
    }
    fn lane(&self) -> Lane {
        self.p.evm_lanes.get(&PATH.to_string()).unwrap().clone()
    }
    fn idem(&self, req: &str) -> Option<IdemState> {
        self.p
            .idempotency
            .get(&(acct(DELEGATE), req.to_string()))
            .copied()
    }

    /// Deliver the `sign` callback for `cid` as `how`.
    fn arrive(&mut self, cid: CommitmentId, req: &str, how: Arrival) {
        let digest = self.meta(cid).sighash;
        let res: Result<Value, PromiseError> = match how {
            Arrival::Valid => Ok(response(&self.key.sign(&digest))),
            Arrival::WrongKey => Ok(response(&self.other.sign(&digest))),
            Arrival::Err => Err(PromiseError::Failed),
        };
        self.at(CONTRACT, 1);
        assert_eq!(self.p.on_signed(cid, req.into(), res), cid);
    }

    fn arrive_cancel(&mut self, cid: CommitmentId, how: Arrival) {
        let digest = self.meta(cid).cancel.unwrap().sighash;
        let res: Result<Value, PromiseError> = match how {
            Arrival::Valid => Ok(response(&self.key.sign(&digest))),
            Arrival::WrongKey => Ok(response(&self.other.sign(&digest))),
            Arrival::Err => Err(PromiseError::Failed),
        };
        self.at(CONTRACT, 1);
        assert_eq!(self.p.on_cancel_signed(cid, res), cid);
    }

    fn landed(
        &self,
        success: bool,
        finality: Finality,
        sig: Option<SignatureInput>,
    ) -> ExternalOutcome {
        ExternalOutcome::Landed {
            success,
            finality,
            block_number: U64(123),
            block_hash: format!("0x{}", "ab".repeat(32)),
            signature: sig,
        }
    }

    fn attest(&mut self, cid: CommitmentId, hash: [u8; 32], success: bool, finality: Finality) {
        let o = self.landed(success, finality, None);
        self.at(RELAYER, 1);
        self.p.attest_external(cid, evm_tx::to_hex0x(&hash), o);
    }

    /// The owner raises the fee ceilings (an original is priced AT the ceiling, so a replacement can only
    /// exist above it; a config change never alters an already-built tx), then requests the cancel.
    fn request_cancel(&mut self, cid: CommitmentId) {
        self.at(OWNER, 1);
        self.raise_ceilings();
        let _ = self
            .p
            .request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
    }

    fn raise_ceilings_as_owner(&mut self) {
        self.at(OWNER, 1);
        self.raise_ceilings();
    }

    fn raise_ceilings(&mut self) {
        self.p.set_evm_cfg(
            U64(CHAIN),
            U128(2 * CANCEL_FEE),
            U128(2 * CANCEL_TIP),
            U128(1_000),
            U64(MIN_AGE),
        );
    }

    fn original_hash(&self, cid: CommitmentId) -> [u8; 32] {
        self.meta(cid).tx_hash.unwrap()
    }

    /// Propose and bring the commitment to `state` by the real paths.
    fn reach(&mut self, state: ReservationState, req: &str) -> CommitmentId {
        use ReservationState::*;
        let cid = self.propose(10_000, req);
        match state {
            Reserved => {}
            Signed => self.arrive(cid, req, Arrival::Valid),
            Unknown => self.arrive(cid, req, Arrival::Err),
            Confirmed => {
                self.arrive(cid, req, Arrival::Valid);
                let h = self.original_hash(cid);
                self.attest(cid, h, true, Finality::Finalized);
            }
            Cancelled => {
                // Unknown without a signature, then the cancel path: sign the cancel, attest it, release.
                self.arrive(cid, req, Arrival::Err);
                self.request_cancel(cid);
                self.arrive_cancel(cid, Arrival::Valid);
                let h = self.meta(cid).cancel.unwrap().tx_hash.unwrap();
                self.attest(cid, h, true, Finality::Finalized);
                self.at(OWNER, 1);
                self.p.confirm_release(cid);
            }
            Failed => {
                self.p.commitments.get_mut(&cid).unwrap().state = Failed;
            }
        }
        assert_eq!(self.state(cid), state, "setup reached {state:?}");
        cid
    }
}

fn sig_input(s: &EvmSig) -> SignatureInput {
    SignatureInput {
        r: evm_tx::to_hex(&s.r),
        s: evm_tx::to_hex(&s.s),
        y_parity: s.y_parity,
    }
}

fn panics_with(msg: &str, f: impl FnOnce()) {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .expect_err(&format!("expected a refusal: {msg}"));
    let text = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(
        text.contains(msg),
        "panic {text:?} does not contain {msg:?}"
    );
}

fn logs_have(name: &str) -> bool {
    get_logs()
        .iter()
        .any(|l| l.contains(&format!("\"event\":\"{name}\"")))
}

fn reason_logged(reason: &str) -> bool {
    get_logs()
        .iter()
        .any(|l| l.contains(&format!("\"reason\":\"{reason}\"")))
}

// ---- parsing ------------------------------------------------------------------------------------

#[test]
fn the_real_signer_vector_parses_to_exactly_64_bytes_and_other_shapes_are_refused() {
    // the live-signer test vector from the plan (path "x", predecessor purser.arjuna-purser.testnet)
    let raw = "secp256k1:67756ZjiVxANYvYhQagGaWj2APpo1C1UMq2ebVWoy3GMU3zmYaM9ho6DNyDxRjo1Uzo2UDMkmeutgZFKQhgpnd1W";
    let key = parse_derived_key(raw).expect("the live vector parses");
    assert_eq!(key.len(), 64);
    // round trip
    assert_eq!(
        format!("secp256k1:{}", near_sdk::bs58::encode(key).into_string()),
        raw
    );
    assert!(parse_derived_key("").is_none());
    assert!(parse_derived_key("secp256k1:").is_none());
    assert!(parse_derived_key("secp256k1:abc").is_none(), "short");
    assert!(parse_derived_key(&raw.replace("secp256k1:", "ed25519:")).is_none());
    assert!(parse_derived_key(&raw[10..]).is_none(), "no curve prefix");
    // a 32-byte ed25519 key under the right prefix
    let ed = format!(
        "ed25519:{}",
        near_sdk::bs58::encode([7u8; 32]).into_string()
    );
    assert!(parse_derived_key(&ed).is_none());
}

#[test]
fn the_sign_response_parser_accepts_only_the_exact_shape() {
    let k = Key::new(1);
    let sig = k.sign(&[9u8; 32]);
    let good = response(&sig);
    assert_eq!(parse_sign_response(&good), Some(sig));
    let mutate = |f: &dyn Fn(&mut Value)| {
        let mut v = good.clone();
        f(&mut v);
        parse_sign_response(&v)
    };
    assert!(
        mutate(&|v| v["recovery_id"] = json!(2)).is_none(),
        "recovery_id 2"
    );
    assert!(
        mutate(&|v| v["recovery_id"] = json!(3)).is_none(),
        "recovery_id 3"
    );
    assert!(
        mutate(&|v| v["recovery_id"] = json!("0")).is_none(),
        "string recovery_id"
    );
    assert!(mutate(&|v| v["scheme"] = json!("Ed25519")).is_none());
    assert!(
        mutate(&|v| v["big_r"]["affine_point"] = json!("02abcd")).is_none(),
        "short r"
    );
    assert!(
        mutate(&|v| v["big_r"]["affine_point"] = json!(format!("04{}", "11".repeat(32)))).is_none(),
        "bad point prefix"
    );
    assert!(
        mutate(&|v| v["s"]["scalar"] = json!("11".repeat(31))).is_none(),
        "short s"
    );
    assert!(
        mutate(&|v| v["s"]["scalar"] = json!("zz".repeat(32))).is_none(),
        "non-hex s"
    );
    assert!(
        mutate(&|v| v["s"]["scalar"] = json!("00".repeat(32))).is_none(),
        "zero s"
    );
    assert!(mutate(&|v| {
        v.as_object_mut().unwrap().remove("big_r");
    })
    .is_none());
    assert!(parse_sign_response(&json!({})).is_none());
    assert!(parse_sign_response(&json!("garbage")).is_none());
    assert!(parse_sign_response(&json!(null)).is_none());
}

#[test]
fn a_test_signature_survives_the_hosts_malleability_check() {
    // proves the harness: k256 output is accepted by env::ecrecover(.., malleability = true)
    let w = World::new();
    for d in 1..=16u8 {
        let digest = [d; 32];
        let sig = w.key.sign(&digest);
        assert!(recovers_to(&sig, &digest, &w.key.pubkey), "digest {d}");
        assert!(
            !recovers_to(&sig, &digest, &w.other.pubkey),
            "wrong key {d}"
        );
        assert!(
            !recovers_to(&sig, &[d ^ 1; 32], &w.key.pubkey),
            "wrong digest {d}"
        );
    }
    // a high-s twin of a valid signature is rejected (malleability)
    let sig = w.key.sign(&[3u8; 32]);
    use k256::elliptic_curve::PrimeField;
    let s = k256::Scalar::from_repr(sig.s.into()).unwrap();
    let mut neg = [0u8; 32];
    neg.copy_from_slice(&(-s).to_bytes());
    let high = EvmSig {
        s: neg,
        y_parity: sig.y_parity ^ 1,
        ..sig
    };
    assert!(
        !recovers_to(&high, &[3u8; 32], &w.key.pubkey),
        "high-s refused"
    );
}

// ---- setup surface ----------------------------------------------------------------------------

#[test]
fn setup_entrypoints_are_owner_only_and_validated() {
    let mut w = World::new();
    w.at(DELEGATE, 1);
    panics_with(MSG_ONLY_OWNER, || {
        w.p.set_evm_cfg(U64(CHAIN), U128(2), U128(1), U128(1), U64(MIN_AGE))
    });
    panics_with(MSG_ONLY_OWNER, || w.p.enable_evm_task(TASK.into()));
    panics_with(MSG_ONLY_OWNER, || w.p.seed_evm_nonce(PATH.into(), U64(9)));
    panics_with(MSG_ONLY_OWNER, || w.p.set_relayer(acct(DELEGATE)));
    w.at(OWNER, 1);
    // mainnet and any other non-testnet id refused; fee/min/age validated
    for (chain, fee, tip, min, age) in [
        (1u64, 2u128, 1u128, 1u128, MIN_AGE),
        (CHAIN, 2, 3, 1, MIN_AGE),
        (CHAIN, 2, 0, 1, MIN_AGE),
        (CHAIN, 2, 1, 0, MIN_AGE),
        (CHAIN, 2, 1, 1, MIN_AGE - 1),
    ] {
        panics_with(MSG_EVM_BAD_CFG, || {
            w.p.set_evm_cfg(U64(chain), U128(fee), U128(tip), U128(min), U64(age))
        });
    }
    panics_with(MSG_EVM_TASK_NOT_EMPTY, || w.p.enable_evm_task(TASK.into()));
    panics_with(MSG_NO_SUCH_TASK, || w.p.enable_evm_task("nope".into()));
    panics_with(MSG_RELAYER_IS_OWNER, || w.p.set_relayer(acct(OWNER)));
    // a derivation path belongs to one delegate for all time, across tasks and after a revoke
    w.p.create_task("t2".into(), yocto(10), TokenSpec::NearNative, 2);
    panics_with(MSG_PATH_IN_USE, || {
        w.p.add_delegate("t2".into(), acct("other.test"), PATH.into())
    });
    w.p.revoke_delegate(TASK.into(), acct(DELEGATE));
    panics_with(MSG_PATH_IN_USE, || {
        w.p.add_delegate("t2".into(), acct("other.test"), PATH.into())
    });
    // an EMPTY task can be enabled, and only once is the unit "wei"
    w.p.enable_evm_task("t2".into());
    assert_eq!(w.p.task_unit("t2".into()).as_deref(), Some("wei"));
    assert_eq!(w.p.task_unit("nope".into()), None);
    w.p.create_task("t3".into(), yocto(10), TokenSpec::NearNative, 2);
    assert_eq!(w.p.task_unit("t3".into()).as_deref(), Some("yocto"));
}

#[test]
fn set_relayer_is_blocked_while_an_evm_commitment_is_signed_or_unknown() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    w.at(OWNER, 1);
    panics_with(MSG_RELAYER_BUSY, || w.p.set_relayer(acct("new.test")));
    // once settled the owner may swap
    let h = w.original_hash(cid);
    w.attest(cid, h, true, Finality::Finalized);
    w.at(OWNER, 1);
    w.p.set_relayer(acct("new.test"));
    assert_eq!(w.p.get_relayer(), Some(acct("new.test")));
    assert!(logs_have("relayer_set"));
}

#[test]
fn the_derived_key_cache_is_write_once_and_total() {
    let mut w = World::new();
    let before = w.lane();
    // same key again, a different key, a failed call, garbage: events only, the lane is untouched
    for (res, reason) in [
        (Ok(w.key.near_string()), "already_cached"),
        (Ok(w.other.near_string()), "conflict"),
        (Err(PromiseError::Failed), "signer_error"),
        (Ok("garbage".to_string()), "invalid_key"),
    ] {
        w.at(CONTRACT, 1);
        w.p.on_derived_key(PATH.into(), U64(CHAIN), res);
        assert!(
            logs_have("derived_key_cached") && reason_logged(reason),
            "{reason}"
        );
        assert_eq!(w.lane(), before, "{reason}: write-once");
    }
    // a fresh path caches, with the address derived from the key
    w.at(CONTRACT, 1);
    assert!(w
        .p
        .on_derived_key("path-b".into(), U64(CHAIN), Ok(w.other.near_string())));
    let lane = w.p.evm_lane("path-b".into()).unwrap();
    assert_eq!(
        lane.address,
        evm_tx::to_hex0x(&evm_tx::address_of(&w.other.pubkey, keccak))
    );
    assert_eq!(lane.next_nonce, None);
    assert_eq!(lane.chain_id, U64(CHAIN));
}

#[test]
fn caching_requires_a_stored_delegate_of_an_evm_task() {
    let mut w = World::new();
    w.at(OWNER, 1);
    w.p.create_task("t2".into(), yocto(10), TokenSpec::NearNative, 2);
    panics_with(MSG_NOT_EVM_TASK, || {
        let _ = w.p.cache_derived_key("t2".into(), acct(DELEGATE));
    });
    panics_with(MSG_NO_SUCH_DELEGATE, || {
        let _ = w.p.cache_derived_key(TASK.into(), acct("stranger.test"));
    });
    panics_with(MSG_EVM_KEY_CACHED, || {
        let _ = w.p.cache_derived_key(TASK.into(), acct(DELEGATE));
    });
    w.at(DELEGATE, 1);
    panics_with(MSG_ONLY_OWNER, || {
        let _ = w.p.cache_derived_key(TASK.into(), acct(DELEGATE));
    });
    // a new delegate's path is accepted and returns the signer promise
    w.at(OWNER, 1);
    w.p.add_delegate(TASK.into(), acct("agent2.test"), "path-c".into());
    let _ = w.p.cache_derived_key(TASK.into(), acct("agent2.test"));
}

// ---- propose: the synchronous prefix ----------------------------------------------------------

#[test]
fn a_proposal_reserves_builds_from_the_stored_intent_and_holds_the_lane() {
    let mut w = World::new();
    let cid = w.propose(10_000, "r1");
    let (c, m, b, lane) = (w.commit(cid), w.meta(cid), w.task(), w.lane());
    assert_eq!(c.state, ReservationState::Reserved);
    assert_eq!(b.outstanding, yocto(10_000));
    assert_eq!(w.idem("r1"), Some(IdemState::Pending));
    assert_eq!((lane.in_flight, lane.next_nonce), (Some(cid), Some(5)));
    // the digest is exactly keccak(0x02 || rlp(tx)) of the fields the contract chose
    let tx = Eip1559Unsigned {
        chain_id: CHAIN,
        nonce: 5,
        max_priority_fee_per_gas: 2_000_000_000,
        max_fee_per_gas: 40_000_000_000,
        gas_limit: 21_000,
        to: evm_tx::parse_address(TO).unwrap(),
        value: 10_000,
    };
    assert_eq!(m.sighash, evm_tx::sighash(&tx, keccak));
    assert_eq!(c.payload_hash, Some(m.sighash));
    assert_eq!(c.payload_version, Some(evm_tx::EVM_PAYLOAD_VERSION));
    assert_eq!(m.from, w.lane().address);
    assert!(logs_have("payment_reserved"));
    // recipient is emitted normalized
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("0x52908400098527886e0f7030069857d2e4169ee7")));
}

#[test]
fn a_second_proposal_on_a_held_lane_is_refused_and_steals_nothing() {
    let mut w = World::new();
    let cid = w.propose(10_000, "r1");
    w.at(DELEGATE, 1);
    panics_with(MSG_EVM_LANE_BUSY, || {
        let _ =
            w.p.propose_payment(TASK.into(), intent(10_000), "r2".into());
    });
    assert_eq!(w.lane().in_flight, Some(cid));
    assert_eq!(w.task().outstanding, yocto(10_000));
    assert_eq!(w.idem("r2"), None);
}

#[test]
fn every_refused_proposal_input_is_refused_before_reserving() {
    let mut w = World::new();
    let cases: Vec<(PaymentIntent, &str)> = vec![
        (
            PaymentIntent {
                chain: Chain::Evm { chain_id: 1 },
                ..intent(5_000)
            },
            MSG_UNSUPPORTED_CHAIN,
        ),
        (
            PaymentIntent {
                chain: Chain::NearNative,
                ..intent(5_000)
            },
            MSG_UNSUPPORTED_CHAIN,
        ),
        (
            PaymentIntent {
                recipient: "0x0000000000000000000000000000000000000000".into(),
                ..intent(5_000)
            },
            MSG_INVALID_RECIPIENT,
        ),
        (
            PaymentIntent {
                recipient: "not-an-address".into(),
                ..intent(5_000)
            },
            MSG_INVALID_RECIPIENT,
        ),
        (
            PaymentIntent {
                recipient: TO.replace("0x", "").to_string(),
                ..intent(5_000)
            },
            MSG_INVALID_RECIPIENT,
        ),
        (intent(999), MSG_EVM_VALUE_TOO_LOW),
        (intent(0), MSG_EVM_VALUE_TOO_LOW),
        (
            PaymentIntent {
                token: TokenSpec::Nep141 {
                    contract: acct("tok.test"),
                },
                ..intent(5_000)
            },
            MSG_UNSUPPORTED_TOKEN,
        ),
        (
            PaymentIntent {
                memo: Some("x".repeat(MAX_MEMO_LEN + 1)),
                ..intent(5_000)
            },
            MSG_MEMO_TOO_LONG,
        ),
        (intent(100_001), MSG_EXCEEDS_BUDGET),
    ];
    for (i, (it, msg)) in cases.into_iter().enumerate() {
        w.at(DELEGATE, 1);
        panics_with(msg, || {
            let _ = w.p.propose_payment(TASK.into(), it, format!("bad-{i}"));
        });
        assert_eq!(
            w.task().outstanding,
            NearToken::ZERO,
            "{msg}: nothing reserved"
        );
        assert_eq!(w.lane().in_flight, None, "{msg}: lane free");
        assert_eq!(w.p.next_commitment_id, 0, "{msg}: no cid consumed");
    }
}

#[test]
fn gates_before_reserve_unseeded_no_key_low_gas_frozen_unauthorized_unconfigured() {
    // unseeded lane
    let mut w = World::new();
    w.p.evm_lanes.get_mut(&PATH.to_string()).unwrap().next_nonce = None;
    w.at(DELEGATE, 1);
    panics_with(MSG_EVM_LANE_UNSEEDED, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    // no cached key (a delegate whose path was never cached)
    let mut w = World::new();
    w.at(OWNER, 1);
    w.p.add_delegate(TASK.into(), acct("agent2.test"), "path-z".into());
    w.at("agent2.test", 1);
    panics_with(MSG_EVM_KEY_NOT_CACHED, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    // preflight: too little prepaid gas
    let mut w = World::new();
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(DELEGATE))
        .prepaid_gas(Gas::from_tgas(99))
        .build());
    panics_with(MSG_EVM_LOW_GAS, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    assert_eq!(w.task().outstanding, NearToken::ZERO);
    // preflight: spendable balance below the storage stake (the total balance would look fine)
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(DELEGATE))
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(yocto(1_000_000))
        .storage_usage(1024 * 300)
        .build());
    panics_with(MSG_EVM_LOW_BALANCE, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    assert_eq!(w.task().outstanding, NearToken::ZERO);
    // exactly 99 vs 100 Tgas boundary
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(DELEGATE))
        .prepaid_gas(Gas::from_tgas(100))
        .build());
    let _ =
        w.p.propose_payment(TASK.into(), intent(5_000), "r-ok".into());
    // frozen task, unauthorized caller, EVM not configured
    let mut w = World::new();
    w.p.tasks.get_mut(&TASK.to_string()).unwrap().frozen = true;
    w.at(DELEGATE, 1);
    panics_with(MSG_TASK_FROZEN, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    let mut w = World::new();
    w.at("stranger.test", 1);
    panics_with(MSG_DELEGATE_NOT_AUTHORIZED, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
    let mut w = World::new();
    w.p.evm_cfg = None;
    w.at(DELEGATE, 1);
    panics_with(MSG_EVM_NOT_CONFIGURED, || {
        let _ = w.p.propose_payment(TASK.into(), intent(5_000), "r".into());
    });
}

#[test]
fn an_evm_intent_on_a_near_task_is_still_unsupported() {
    let mut w = World::new();
    w.at(OWNER, 1);
    w.p.create_task("near".into(), yocto(100), TokenSpec::NearNative, 1);
    w.p.add_delegate("near".into(), acct("n.test"), "near-path".into());
    w.p.set_recipient_allowlist("near".into(), vec!["x.test".into()]);
    w.at("n.test", 1);
    panics_with(MSG_UNSUPPORTED_CHAIN, || {
        let _ =
            w.p.propose_payment("near".into(), intent(5_000), "r".into());
    });
}

#[test]
fn replays_after_signed_or_unknown_return_the_cid_and_normalize_the_address_casing() {
    for how in [Arrival::Valid, Arrival::Err, Arrival::WrongKey] {
        let mut w = World::new();
        let cid = w.propose(10_000, "r1");
        assert_eq!(w.idem("r1"), Some(IdemState::Pending));
        w.at(DELEGATE, 1);
        panics_with(MSG_IN_FLIGHT, || {
            let _ =
                w.p.propose_payment(TASK.into(), intent(10_000), "r1".into());
        });
        w.arrive(cid, "r1", how);
        assert_eq!(
            w.idem("r1"),
            Some(IdemState::Committed { commitment_id: cid }),
            "{how:?}: Committed at Signed OR Unknown"
        );
        // same request, different checksum casing -> the same cid, no second reservation
        let lower = PaymentIntent {
            recipient: TO.to_lowercase(),
            ..intent(10_000)
        };
        w.at(DELEGATE, 1);
        match w.p.propose_payment(TASK.into(), lower, "r1".into()) {
            PromiseOrValue::Value(again) => assert_eq!(again, cid),
            PromiseOrValue::Promise(_) => panic!("a replay must not sign again"),
        }
        assert_eq!(w.task().outstanding, yocto(10_000));
        // a different request under the same id is refused
        panics_with(MSG_REQUEST_ID_REUSED, || {
            let _ =
                w.p.propose_payment(TASK.into(), intent(10_001), "r1".into());
        });
    }
}

#[test]
fn reconcile_is_refused_for_every_evm_state() {
    use ReservationState::*;
    for st in [Reserved, Signed, Unknown, Confirmed, Cancelled] {
        let mut w = World::new();
        let cid = w.reach(st, "r1");
        w.at(OWNER, 2 * RECONCILE_MIN_AGE_NS);
        for confirmed in [true, false] {
            panics_with(MSG_RECONCILE_EVM, || w.p.reconcile(cid, confirmed));
        }
        assert_eq!(w.state(cid), st, "{st:?}: untouched");
    }
}

// ---- on_signed: EVERY row of the totality table ------------------------------------------------

/// One expectation per `(state on arrival, arrival)`.
struct Row {
    state: ReservationState,
    how: Arrival,
    /// state after the callback
    to: ReservationState,
    /// is a signature + hash recorded afterwards?
    sig_recorded: bool,
    /// event names / reasons that must be logged
    events: &'static [&'static str],
    /// the `reason` that must be logged, if any
    reason: Option<&'static str>,
    /// idempotency after (None = untouched by the callback)
    idem_committed: bool,
}

#[test]
fn on_signed_totality_table_every_row() {
    use ReservationState::*;
    let rows = [
        // Reserved
        Row {
            state: Reserved,
            how: Arrival::Valid,
            to: Signed,
            sig_recorded: true,
            events: &["payment_signed"],
            reason: None,
            idem_committed: true,
        },
        Row {
            state: Reserved,
            how: Arrival::WrongKey,
            to: Unknown,
            sig_recorded: false,
            events: &["payment_unknown"],
            reason: Some("invalid_signature"),
            idem_committed: true,
        },
        Row {
            state: Reserved,
            how: Arrival::Err,
            to: Unknown,
            sig_recorded: false,
            events: &["payment_unknown"],
            reason: Some("signer_error"),
            idem_committed: true,
        },
        // Unknown (no signature yet)
        Row {
            state: Unknown,
            how: Arrival::Valid,
            to: Unknown,
            sig_recorded: true,
            events: &["payment_signed"],
            reason: None,
            idem_committed: true,
        },
        Row {
            state: Unknown,
            how: Arrival::WrongKey,
            to: Unknown,
            sig_recorded: false,
            events: &["payment_unknown"],
            reason: Some("late_invalid_signature"),
            idem_committed: true,
        },
        Row {
            state: Unknown,
            how: Arrival::Err,
            to: Unknown,
            sig_recorded: false,
            events: &[],
            reason: None,
            idem_committed: true,
        },
        // Signed (signature already recorded by the first callback)
        Row {
            state: Signed,
            how: Arrival::Valid,
            to: Signed,
            sig_recorded: true,
            events: &[],
            reason: None,
            idem_committed: true,
        },
        Row {
            state: Signed,
            how: Arrival::WrongKey,
            to: Signed,
            sig_recorded: true,
            events: &["payment_unknown"],
            reason: Some("late_invalid_signature"),
            idem_committed: true,
        },
        Row {
            state: Signed,
            how: Arrival::Err,
            to: Signed,
            sig_recorded: true,
            events: &[],
            reason: None,
            idem_committed: true,
        },
        // Confirmed
        Row {
            state: Confirmed,
            how: Arrival::Valid,
            to: Confirmed,
            sig_recorded: true,
            events: &[],
            reason: None,
            idem_committed: true,
        },
        Row {
            state: Confirmed,
            how: Arrival::WrongKey,
            to: Confirmed,
            sig_recorded: true,
            events: &["payment_unknown"],
            reason: Some("late_invalid_signature"),
            idem_committed: true,
        },
        Row {
            state: Confirmed,
            how: Arrival::Err,
            to: Confirmed,
            sig_recorded: true,
            events: &[],
            reason: None,
            idem_committed: true,
        },
        // Cancelled (reached without ever recording the original's signature)
        Row {
            state: Cancelled,
            how: Arrival::Valid,
            to: Cancelled,
            sig_recorded: true,
            events: &["payment_signed"],
            reason: None,
            idem_committed: false,
        },
        Row {
            state: Cancelled,
            how: Arrival::WrongKey,
            to: Cancelled,
            sig_recorded: false,
            events: &["payment_unknown"],
            reason: Some("late_invalid_signature"),
            idem_committed: false,
        },
        Row {
            state: Cancelled,
            how: Arrival::Err,
            to: Cancelled,
            sig_recorded: false,
            events: &[],
            reason: None,
            idem_committed: false,
        },
        // Failed (unreachable on the EVM path; the callback is total over it anyway)
        Row {
            state: Failed,
            how: Arrival::Valid,
            to: Failed,
            sig_recorded: true,
            events: &["payment_signed", "payment_unknown"],
            reason: Some("signature_after_failed"),
            idem_committed: false,
        },
        Row {
            state: Failed,
            how: Arrival::WrongKey,
            to: Failed,
            sig_recorded: false,
            events: &["payment_unknown"],
            reason: Some("late_invalid_signature"),
            idem_committed: false,
        },
        Row {
            state: Failed,
            how: Arrival::Err,
            to: Failed,
            sig_recorded: false,
            events: &[],
            reason: None,
            idem_committed: false,
        },
    ];
    assert_eq!(rows.len(), 6 * 3, "6 states x 3 arrivals");
    for r in rows {
        let mut w = World::new();
        let cid = w.reach(r.state, "r1");
        let before = (w.task(), w.lane(), w.idem("r1"));
        w.arrive(cid, "r1", r.how);
        let label = format!("{:?} + {:?}", r.state, r.how);
        assert_eq!(w.state(cid), r.to, "{label}: state");
        let m = w.meta(cid);
        assert_eq!(
            m.sig.is_some() && m.tx_hash.is_some(),
            r.sig_recorded,
            "{label}: recorded"
        );
        if r.sig_recorded {
            // the recorded hash is the keccak of the signed encoding of the tx the contract built
            let raw = evm_tx::encode_signed(&original_tx(&m), &m.sig.unwrap());
            assert_eq!(m.tx_hash.unwrap(), keccak(&raw), "{label}: hash");
            assert_eq!(
                w.commit(cid).evm_tx,
                Some(evm_tx::to_hex0x(&m.tx_hash.unwrap())),
                "{label}: evm_tx"
            );
        }
        for e in r.events {
            assert!(logs_have(e), "{label}: event {e}");
        }
        if r.events.is_empty() {
            assert!(
                !logs_have("payment_signed") && !logs_have("payment_unknown"),
                "{label}: no event expected"
            );
        }
        if let Some(reason) = r.reason {
            assert!(reason_logged(reason), "{label}: reason {reason}");
        }
        if r.idem_committed {
            assert_eq!(
                w.idem("r1"),
                Some(IdemState::Committed { commitment_id: cid }),
                "{label}: idem"
            );
        } else {
            assert_eq!(
                w.idem("r1"),
                before.2,
                "{label}: idem untouched by the callback"
            );
        }
        // NEVER a release or a lane change from a signer outcome, in any row
        assert_eq!(
            w.task().outstanding,
            before.0.outstanding,
            "{label}: outstanding"
        );
        assert_eq!(w.task().completed, before.0.completed, "{label}: completed");
        assert_eq!(w.lane(), before.1, "{label}: lane");
        assert!(!w.task().frozen);
    }
}

#[test]
fn on_signed_garbled_responses_in_reserved_are_all_unknown_never_a_panic() {
    let garbled: Vec<Value> = vec![
        json!({}),
        json!(null),
        json!("a string"),
        json!([1, 2, 3]),
        json!({"scheme": "Secp256k1"}),
        json!({"scheme":"Secp256k1","big_r":{"affine_point":"zz"},"s":{"scalar":"00"},"recovery_id":0}),
    ];
    let mut cases = garbled;
    // recovery_id 2 and 3 on an otherwise valid signature
    for rid in [2u8, 3] {
        let probe = World::new();
        let mut w = probe;
        let cid = w.propose(10_000, "r1");
        let digest = w.meta(cid).sighash;
        let mut v = response(&w.key.sign(&digest));
        v["recovery_id"] = json!(rid);
        w.at(CONTRACT, 1);
        w.p.on_signed(cid, "r1".into(), Ok(v));
        assert_eq!(w.state(cid), ReservationState::Unknown, "recovery_id {rid}");
        assert!(w.meta(cid).sig.is_none());
    }
    // a valid signature for a DIFFERENT digest (replayed from another payment)
    let mut w = World::new();
    let cid = w.propose(10_000, "r1");
    let other = w.key.sign(&[0x5a; 32]);
    cases.push(response(&other));
    for v in cases {
        let mut w = World::new();
        let cid2 = w.propose(10_000, "r1");
        w.at(CONTRACT, 1);
        w.p.on_signed(cid2, "r1".into(), Ok(v));
        assert_eq!(w.state(cid2), ReservationState::Unknown);
        assert_eq!(w.task().outstanding, yocto(10_000), "stays reserved");
        assert_eq!(w.lane().in_flight, Some(cid2), "lane held");
        assert!(w.meta(cid2).sig.is_none());
    }
    let _ = cid;
}

#[test]
fn a_late_valid_signature_after_unknown_is_recorded_then_the_relayer_can_broadcast_it() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    assert!(w.p.get_signed_tx(cid).unwrap().original.raw_tx.is_none());
    w.arrive(cid, "r1", Arrival::Valid);
    let v = w.p.get_signed_tx(cid).unwrap();
    assert_eq!(v.state, ReservationState::Unknown, "state unchanged");
    let raw = v.original.raw_tx.unwrap();
    let hash = v.original.tx_hash.unwrap();
    // the view's hash is keccak(raw) and the raw is 0x02-typed
    let raw_bytes: Vec<u8> = (2..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap())
        .collect();
    assert_eq!(raw_bytes[0], 0x02);
    assert_eq!(evm_tx::to_hex0x(&keccak(&raw_bytes)), hash);
    // and attesting it now matches (Unknown + original landed, finalized -> Confirmed)
    let h = w.original_hash(cid);
    w.attest(cid, h, true, Finality::Finalized);
    assert_eq!(w.state(cid), ReservationState::Confirmed);
}

// ---- attest_external ------------------------------------------------------------------------------

#[test]
fn a_finalized_successful_original_confirms_and_advances_the_lane_exactly_once() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    let h = w.original_hash(cid);
    w.attest(cid, h, true, Finality::Finalized);
    assert_eq!(w.state(cid), ReservationState::Confirmed);
    let (b, l) = (w.task(), w.lane());
    assert_eq!(
        (b.outstanding, b.completed),
        (NearToken::ZERO, yocto(10_000))
    );
    assert_eq!((l.in_flight, l.next_nonce), (None, Some(6)));
    assert_eq!(w.commit(cid).actual_spent, Some(yocto(10_000)));
    assert!(logs_have("external_attested") && logs_have("payment_confirmed"));
    // idempotent: the same report again is a silent no-op (no event, nothing moves)
    w.attest(cid, h, true, Finality::Finalized);
    assert!(!logs_have("external_attested"), "no duplicate event");
    assert_eq!((w.task(), w.lane()), (b, l));
    // the next payment uses nonce 6
    let c2 = w.propose(10_000, "r2");
    assert_eq!(w.meta(c2).nonce, 6);
}

#[test]
fn safe_finality_is_recorded_but_never_changes_state() {
    for st in [ReservationState::Signed, ReservationState::Unknown] {
        let mut w = World::new();
        let cid = w.reach(ReservationState::Signed, "r1");
        if st == ReservationState::Unknown {
            w.at(RELAYER, MIN_AGE + 1);
            assert!(w.p.mark_unknown(cid));
        }
        let h = w.original_hash(cid);
        let before = (w.task(), w.lane());
        w.attest(cid, h, true, Finality::Safe);
        assert_eq!(w.state(cid), st, "{st:?}");
        assert!(logs_have("external_attested"));
        assert_eq!((w.task(), w.lane()), before);
    }
}

#[test]
fn a_reverted_original_burns_the_nonce_without_settling_value_and_needs_the_owner() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    let h = w.original_hash(cid);
    // not finalized: nothing
    w.attest(cid, h, false, Finality::Safe);
    assert_eq!(w.state(cid), ReservationState::Signed);
    // finalized revert: Signed -> Unknown, evidence recorded, budget STILL reserved
    w.attest(cid, h, false, Finality::Finalized);
    assert_eq!(w.state(cid), ReservationState::Unknown);
    assert_eq!(
        w.task().outstanding,
        yocto(10_000),
        "no value moved, nothing released by the relayer"
    );
    assert_eq!(w.task().completed, NearToken::ZERO);
    assert_eq!(
        w.p.get_signed_tx(cid).unwrap().evidence.as_deref(),
        Some("original_reverted")
    );
    assert!(reason_logged("reverted_original"));
    // the relayer cannot release; the owner can
    w.at(RELAYER, 1);
    panics_with(MSG_ONLY_OWNER, || w.p.confirm_release(cid));
    w.at(OWNER, 1);
    w.p.confirm_release(cid);
    assert_eq!(w.state(cid), ReservationState::Cancelled);
    assert_eq!(
        (w.task().outstanding, w.task().completed),
        (NearToken::ZERO, NearToken::ZERO)
    );
    let l = w.lane();
    assert_eq!(
        (l.in_flight, l.next_nonce),
        (None, Some(6)),
        "the burnt nonce is skipped"
    );
    assert_eq!(w.idem("r1"), Some(IdemState::Failed));
    assert!(logs_have("payment_cancelled"));
    // a repeat of the same revert report is a no-op
    w.attest(cid, h, false, Finality::Finalized);
    assert!(!logs_have("external_attested"));
}

#[test]
fn the_cancel_flow_signed_attested_released_then_a_late_original_is_a_contradiction_that_freezes() {
    let mut w = World::new();
    // a second delegate-sized payment so re-spending the released headroom breaks (I)
    let cid = w.propose(80_000, "r1");
    w.arrive(cid, "r1", Arrival::Err); // Unknown
    assert_eq!(w.state(cid), ReservationState::Unknown);
    // owner cannot release without evidence
    w.at(OWNER, 1);
    panics_with(MSG_NO_RELEASE_EVIDENCE, || w.p.confirm_release(cid));
    // cancel: the ceiling must be raised above the original first (it was priced AT the ceiling); the fee
    // rules are then enforced on both fields; only from Unknown; one only
    panics_with(MSG_EVM_INVALID_FEE, || {
        let _ =
            w.p.request_cancel(cid, U128(40_000_000_000), U128(2_000_000_000));
    });
    w.raise_ceilings();
    for (fee, tip) in [
        (44_999_999_999u128, CANCEL_TIP),
        (CANCEL_FEE, 2_249_999_999),
        (CANCEL_FEE, 0),
        (2 * CANCEL_FEE + 1, CANCEL_TIP),
        (CANCEL_FEE, 2 * CANCEL_TIP + 1),
    ] {
        panics_with(MSG_EVM_INVALID_FEE, || {
            let _ = w.p.request_cancel(cid, U128(fee), U128(tip));
        });
    }
    assert!(
        w.meta(cid).cancel.is_none(),
        "a refused cancel claims no slot"
    );
    // exactly ceil(1.125 x) on both fields is accepted
    let _ =
        w.p.request_cancel(cid, U128(45_000_000_000), U128(2_250_000_000));
    panics_with(MSG_CANCEL_EXISTS, || {
        let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
    });
    w.arrive_cancel(cid, Arrival::Valid);
    assert!(logs_have("cancel_signed"));
    let view = w.p.get_signed_tx(cid).unwrap();
    let cancel = view.cancel.clone().unwrap();
    assert_eq!(cancel.value, U128(0));
    assert_eq!(cancel.to, view.from, "a self-send");
    assert_eq!(view.nonce, U64(5), "same nonce as the original");
    let ch = w.meta(cid).cancel.unwrap().tx_hash.unwrap();
    // the relayer attests the cancel landed; evidence only, budget unchanged
    w.attest(cid, ch, true, Finality::Finalized);
    assert_eq!(w.state(cid), ReservationState::Unknown);
    assert_eq!(w.task().outstanding, yocto(80_000));
    assert_eq!(
        w.p.get_signed_tx(cid).unwrap().evidence.as_deref(),
        Some("cancel_landed")
    );
    // owner releases
    w.at(OWNER, 1);
    w.p.confirm_release(cid);
    assert_eq!(w.state(cid), ReservationState::Cancelled);
    assert_eq!(w.task().outstanding, NearToken::ZERO);
    assert_eq!(w.lane().next_nonce, Some(6));
    // the freed headroom is spent again
    let c2 = w.propose(80_000, "r2");
    assert_eq!(w.task().outstanding, yocto(80_000));
    // ... and the original lands anyway (its signature was public all along): late valid callback
    // records the hash so the relayer can attest it
    w.arrive(cid, "r1", Arrival::Valid);
    let oh = w.original_hash(cid);
    w.attest(cid, oh, true, Finality::Finalized);
    assert_eq!(
        w.state(cid),
        ReservationState::Confirmed,
        "Cancelled -> Confirmed"
    );
    let b = w.task();
    assert!(b.frozen, "80k landed + 80k reserved > 100k cap");
    assert_eq!(b.completed, yocto(80_000));
    assert_eq!(
        b.outstanding,
        yocto(80_000),
        "Cancelled had already released; not decremented again"
    );
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"contradicted\":true") && l.contains("\"frozen\":true")));
    let l = w.lane();
    assert_eq!(l.next_nonce, Some(6), "no double advance");
    assert_eq!(
        l.in_flight,
        Some(c2),
        "the contradiction does not free or steal the new holder's lane"
    );
    // a frozen task refuses new proposals but still attests (c2 can settle) and releases
    w.at(DELEGATE, 1);
    panics_with(MSG_TASK_FROZEN, || {
        let _ = w.p.propose_payment(TASK.into(), intent(1_000), "r3".into());
    });
    w.arrive(c2, "r2", Arrival::Valid);
    let h2 = w.original_hash(c2);
    w.attest(c2, h2, true, Finality::Finalized);
    assert_eq!(
        w.state(c2),
        ReservationState::Confirmed,
        "a frozen task still attests"
    );
    assert_eq!(w.lane().in_flight, None);
    // the same contradiction report again is a no-op
    w.attest(cid, oh, true, Finality::Finalized);
    assert!(!logs_have("external_attested"));
}

#[test]
fn request_cancel_is_only_from_unknown_by_owner_or_relayer_and_allowed_when_frozen() {
    use ReservationState::*;
    for st in [Reserved, Signed, Confirmed] {
        let mut w = World::new();
        let cid = w.reach(st, "r1");
        w.at(OWNER, 1);
        panics_with(MSG_NOT_CANCELLABLE, || {
            let _ =
                w.p.request_cancel(cid, U128(40_000_000_000), U128(2_000_000_000));
        });
    }
    let mut w = World::new();
    let cid = w.reach(Unknown, "r1");
    w.at(DELEGATE, 1);
    panics_with(MSG_ONLY_OWNER_OR_RELAYER, || {
        let _ =
            w.p.request_cancel(cid, U128(40_000_000_000), U128(2_000_000_000));
    });
    w.at(OWNER, 1);
    panics_with(MSG_NO_SUCH_COMMITMENT, || {
        let _ = w.p.request_cancel(99, U128(1), U128(1));
    });
    w.p.tasks.get_mut(&TASK.to_string()).unwrap().frozen = true;
    w.at(RELAYER, 1);
    w.raise_ceilings_as_owner();
    w.at(RELAYER, 1);
    let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
    // low gas is refused before the slot is claimed
    let mut w = World::new();
    let cid = w.reach(Unknown, "r1");
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(OWNER))
        .prepaid_gas(Gas::from_tgas(50))
        .build());
    panics_with(MSG_EVM_LOW_GAS, || {
        let _ =
            w.p.request_cancel(cid, U128(40_000_000_000), U128(2_000_000_000));
    });
    assert!(w.meta(cid).cancel.is_none());
}

#[test]
fn on_cancel_signed_totality_valid_invalid_err_by_state() {
    use ReservationState::*;
    // natural state: Unknown
    for (how, signed, event) in [
        (Arrival::Valid, true, Some("cancel_signed")),
        (Arrival::WrongKey, false, Some("payment_unknown")),
        (Arrival::Err, false, Some("payment_unknown")),
    ] {
        let mut w = World::new();
        let cid = w.reach(Unknown, "r1");
        w.request_cancel(cid);
        let before = (w.task(), w.lane());
        w.arrive_cancel(cid, how);
        assert_eq!(w.state(cid), Unknown, "{how:?}");
        // a failed answer frees the slot (retryable); a verified one keeps it
        assert_eq!(w.meta(cid).cancel.is_some(), signed, "{how:?}");
        if signed {
            assert!(w.meta(cid).cancel.unwrap().sig.is_some(), "{how:?}");
        }
        if let Some(e) = event {
            assert!(logs_have(e), "{how:?}: {e}");
        }
        assert_eq!(
            (w.task(), w.lane()),
            before,
            "{how:?}: a cancel outcome never moves budget"
        );
    }
    // a late valid cancel signature in a settled state is still recorded; Err is a silent no-op
    let mut w = World::new();
    let cid = w.reach(Unknown, "r1");
    w.request_cancel(cid);
    w.arrive(cid, "r1", Arrival::Valid);
    let h = w.original_hash(cid);
    w.attest(cid, h, true, Finality::Finalized); // original wins -> Confirmed
    assert_eq!(w.state(cid), Confirmed);
    let digest = w.meta(cid).cancel.unwrap().sighash;
    w.arrive_cancel(cid, Arrival::Err);
    assert!(
        !logs_have("payment_unknown"),
        "Err on a settled state emits nothing (it only frees the unsigned slot)"
    );
    assert!(w.meta(cid).cancel.is_none());
    assert_eq!(w.state(cid), Confirmed);
    // the same late answer arriving valid is recorded instead (a separate world: one callback per request)
    let mut w = World::new();
    let cid = w.reach(Unknown, "r1");
    w.request_cancel(cid);
    assert_eq!(w.meta(cid).cancel.unwrap().sighash, digest);
    w.arrive(cid, "r1", Arrival::Valid);
    let h = w.original_hash(cid);
    w.attest(cid, h, true, Finality::Finalized);
    w.arrive_cancel(cid, Arrival::Valid);
    assert!(w.meta(cid).cancel.unwrap().sig.is_some());
    assert!(logs_have("cancel_signed"));
    assert_eq!(w.state(cid), Confirmed);
}

#[test]
fn a_failed_cancel_signature_frees_the_slot_and_the_retry_reaches_release() {
    use ReservationState::*;
    for fail in [Arrival::Err, Arrival::WrongKey] {
        let mut w = World::new();
        let cid = w.reach(Unknown, "r1");
        w.request_cancel(cid);
        // in flight (callback pending): the slot is occupied, a second request is refused
        assert!(w.meta(cid).cancel.is_some());
        w.at(OWNER, 1);
        panics_with(MSG_CANCEL_EXISTS, || {
            let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
        });
        let digest_before = w.meta(cid).cancel.unwrap().sighash;
        let (task, lane) = (w.task(), w.lane());
        w.arrive_cancel(cid, fail);
        assert!(w.meta(cid).cancel.is_none(), "{fail:?}: slot freed");
        assert_eq!(
            (w.task(), w.lane()),
            (task, lane),
            "{fail:?}: no accounting"
        );
        assert_eq!(w.state(cid), Unknown);
        // retry with the same fees: same digest, new request
        w.at(OWNER, 1);
        let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
        assert_eq!(w.meta(cid).cancel.unwrap().sighash, digest_before);
        w.arrive_cancel(cid, Arrival::Valid);
        let h = w.meta(cid).cancel.unwrap().tx_hash.unwrap();
        w.attest(cid, h, true, Finality::Finalized);
        assert_eq!(w.meta(cid).evidence, Some(ReleaseEvidence::CancelLanded));
        w.at(OWNER, 1);
        w.p.confirm_release(cid);
        assert_eq!(w.state(cid), Cancelled, "{fail:?}");
        assert_eq!(w.task().outstanding, yocto(0));
    }
}

#[test]
fn a_cancel_with_a_recorded_signature_refuses_a_second_request_and_is_never_cleared() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    w.request_cancel(cid);
    w.arrive_cancel(cid, Arrival::Valid);
    let cm = w.meta(cid).cancel.unwrap();
    w.at(OWNER, 1);
    panics_with(MSG_CANCEL_EXISTS, || {
        let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
    });
    // a duplicate failing callback (cannot happen on chain; defence in depth) leaves a verified cancel alone
    w.arrive_cancel(cid, Arrival::Err);
    w.arrive_cancel(cid, Arrival::WrongKey);
    assert_eq!(w.meta(cid).cancel.unwrap(), cm);
}

#[test]
fn a_cancel_signature_recovered_by_attestation_survives_a_late_failed_callback() {
    // The signer failed to answer us, but the cancel was signed and mined: the relayer recovers the
    // signature through attest_external while the slot is still occupied; the (late) Err callback must
    // not wipe it.
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    w.request_cancel(cid);
    let cm = w.meta(cid).cancel.unwrap();
    let sig = w.key.sign(&cm.sighash);
    let tx = cancel_tx(&w.meta(cid), &cm);
    let hash = evm_tx::tx_hash(&tx, &sig, keccak);
    let o = w.landed(true, Finality::Finalized, Some(sig_input(&sig)));
    w.at(RELAYER, 1);
    w.p.attest_external(cid, evm_tx::to_hex0x(&hash), o);
    assert_eq!(w.meta(cid).cancel.unwrap().sig, Some(sig));
    w.arrive_cancel(cid, Arrival::Err);
    assert_eq!(w.meta(cid).cancel.unwrap().tx_hash, Some(hash));
    assert_eq!(w.meta(cid).evidence, Some(ReleaseEvidence::CancelLanded));
}

#[test]
fn attestations_are_gated_matched_and_validated() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    let h = w.original_hash(cid);
    let outcome = w.landed(true, Finality::Finalized, None);
    // gate: only the relayer or the owner
    for who in [DELEGATE, "stranger.test", CONTRACT] {
        w.at(who, 1);
        panics_with(MSG_ONLY_OWNER_OR_RELAYER, || {
            w.p.attest_external(cid, evm_tx::to_hex0x(&h), outcome.clone())
        });
    }
    w.at(RELAYER, 1);
    // a hash the contract did not sign
    panics_with(MSG_UNKNOWN_TX_HASH, || {
        w.p.attest_external(cid, evm_tx::to_hex0x(&[7u8; 32]), outcome.clone())
    });
    // malformed hashes
    for bad in ["", "0x12", "zz", &"0".repeat(63)] {
        panics_with(MSG_INVALID_TX_HASH, || {
            w.p.attest_external(cid, bad.to_string(), outcome.clone())
        });
    }
    panics_with(MSG_NO_SUCH_COMMITMENT, || {
        w.p.attest_external(99, evm_tx::to_hex0x(&h), outcome.clone())
    });
    assert_eq!(
        w.state(cid),
        ReservationState::Signed,
        "nothing above changed it"
    );
    // the owner may attest too
    w.at(OWNER, 1);
    w.p.attest_external(cid, evm_tx::to_hex0x(&h), outcome);
    assert_eq!(w.state(cid), ReservationState::Confirmed);
}

#[test]
fn attestation_for_a_non_evm_commitment_is_refused() {
    let mut w = World::new();
    w.at(OWNER, 1);
    w.p.create_task("near".into(), yocto(100), TokenSpec::NearNative, 1);
    w.p.add_delegate("near".into(), acct("n.test"), "near-path".into());
    w.p.set_recipient_allowlist("near".into(), vec!["x.test".into()]);
    w.at("n.test", 1);
    let _ = w.p.propose_payment(
        "near".into(),
        PaymentIntent {
            chain: Chain::NearNative,
            recipient: "x.test".into(),
            amount: yocto(1),
            token: TokenSpec::NearNative,
            memo: None,
        },
        "n1".into(),
    );
    w.at(RELAYER, 1);
    let o = w.landed(true, Finality::Finalized, None);
    panics_with(MSG_NOT_EVM_COMMITMENT, || {
        w.p.attest_external(0, evm_tx::to_hex0x(&[1u8; 32]), o)
    });
    panics_with(MSG_NOT_EVM_COMMITMENT, || {
        let _ = w.p.mark_unknown(0);
    });
}

#[test]
fn an_unknown_commitment_without_a_signature_accepts_a_verified_signature_in_the_attestation() {
    // The signer's answer was garbled, but the transaction landed with the contract's digest signed.
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    let m = w.meta(cid);
    let sig = w.key.sign(&m.sighash);
    let hash = evm_tx::tx_hash(&original_tx(&m), &sig, keccak);
    let input = |s: &EvmSig| SignatureInput {
        r: evm_tx::to_hex(&s.r),
        s: evm_tx::to_hex(&s.s),
        y_parity: s.y_parity,
    };
    // a signature by another key is refused, as is one for a different digest or with a wrong hash
    let bad = [
        (w.other.sign(&m.sighash), hash),
        (w.key.sign(&[1u8; 32]), hash),
        (sig, [3u8; 32]),
    ];
    for (s, h) in bad {
        w.at(RELAYER, 1);
        let o = w.landed(true, Finality::Finalized, Some(input(&s)));
        panics_with(MSG_UNKNOWN_TX_HASH, || {
            w.p.attest_external(cid, evm_tx::to_hex0x(&h), o)
        });
        assert!(
            w.meta(cid).sig.is_none(),
            "a refused attestation records nothing"
        );
    }
    // the genuine one is accepted, recorded, and (finalized + success) confirms
    w.at(RELAYER, 1);
    let o = w.landed(true, Finality::Finalized, Some(input(&sig)));
    w.p.attest_external(cid, evm_tx::to_hex0x(&hash), o);
    assert_eq!(w.state(cid), ReservationState::Confirmed);
    assert_eq!(w.meta(cid).tx_hash, Some(hash));
    // the signature path is NOT available once a hash is known, nor in other states
    let mut w2 = World::new();
    let c2 = w2.reach(ReservationState::Reserved, "r1");
    let m2 = w2.meta(c2);
    let s2 = w2.key.sign(&m2.sighash);
    let h2 = evm_tx::tx_hash(&original_tx(&m2), &s2, keccak);
    w2.at(RELAYER, 1);
    let o = w2.landed(true, Finality::Finalized, Some(input(&s2)));
    panics_with(MSG_UNKNOWN_TX_HASH, || {
        w2.p.attest_external(c2, evm_tx::to_hex0x(&h2), o)
    });
    assert_eq!(w2.state(c2), ReservationState::Reserved);
}

#[test]
fn a_signed_cancel_signature_can_also_be_recovered_through_an_attestation() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    w.request_cancel(cid);
    w.arrive_cancel(cid, Arrival::Err); // the cancel's signature never came back; the slot is freed
    assert!(w.meta(cid).cancel.is_none());
    // the retry (same fees, so the same digest) is in flight when the first attempt's signature is recovered
    w.at(OWNER, 1);
    let _ = w.p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP));
    let (m, cm) = (w.meta(cid), w.meta(cid).cancel.unwrap());
    let sig = w.key.sign(&cm.sighash);
    let hash = evm_tx::tx_hash(&cancel_tx(&m, &cm), &sig, keccak);
    w.at(RELAYER, 1);
    let o = w.landed(
        true,
        Finality::Finalized,
        Some(SignatureInput {
            r: evm_tx::to_hex(&sig.r),
            s: evm_tx::to_hex(&sig.s),
            y_parity: sig.y_parity,
        }),
    );
    w.p.attest_external(cid, evm_tx::to_hex0x(&hash), o);
    assert_eq!(w.meta(cid).evidence, Some(ReleaseEvidence::CancelLanded));
    assert_eq!(w.state(cid), ReservationState::Unknown, "evidence only");
    w.at(OWNER, 1);
    w.p.confirm_release(cid);
    assert_eq!(w.state(cid), ReservationState::Cancelled);
}

#[test]
fn a_cancel_hash_against_a_signed_commitment_is_rejected() {
    // Reachable only by forcing the state: a cancel can only be requested from Unknown.
    let mut w = World::new();
    let cid = w.reach(ReservationState::Unknown, "r1");
    w.request_cancel(cid);
    w.arrive_cancel(cid, Arrival::Valid);
    let ch = w.meta(cid).cancel.unwrap().tx_hash.unwrap();
    w.p.commitments.get_mut(&cid).unwrap().state = ReservationState::Signed;
    w.at(RELAYER, 1);
    let o = w.landed(true, Finality::Finalized, None);
    panics_with(MSG_UNKNOWN_TX_HASH, || {
        w.p.attest_external(cid, evm_tx::to_hex0x(&ch), o)
    });
}

#[test]
fn confirm_release_needs_unknown_and_evidence_and_the_owner() {
    use ReservationState::*;
    for st in [Reserved, Signed, Confirmed, Cancelled] {
        let mut w = World::new();
        let cid = w.reach(st, "r1");
        w.at(OWNER, 1);
        panics_with(MSG_NOT_CANCELLABLE, || w.p.confirm_release(cid));
    }
    let mut w = World::new();
    let cid = w.reach(Unknown, "r1");
    w.at(OWNER, 1);
    panics_with(MSG_NO_RELEASE_EVIDENCE, || w.p.confirm_release(cid));
    panics_with(MSG_NO_SUCH_COMMITMENT, || w.p.confirm_release(99));
    w.at(RELAYER, 1);
    panics_with(MSG_ONLY_OWNER, || w.p.confirm_release(cid));
}

// ---- mark_unknown ------------------------------------------------------------------------------

#[test]
fn mark_unknown_signed_needs_the_configured_age_and_owner_or_relayer() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    let signed_at = w.meta(cid).signed_at_ns.unwrap();
    // not permissionless
    w.at(DELEGATE, 0);
    panics_with(MSG_ONLY_OWNER_OR_RELAYER, || {
        let _ = w.p.mark_unknown(cid);
    });
    // too early, one ns before the age
    as_(RELAYER, signed_at + MIN_AGE - 1);
    panics_with(MSG_TOO_EARLY_UNKNOWN, || {
        let _ = w.p.mark_unknown(cid);
    });
    assert_eq!(w.state(cid), ReservationState::Signed);
    // exactly at the age
    as_(RELAYER, signed_at + MIN_AGE);
    assert!(w.p.mark_unknown(cid));
    assert_eq!(w.state(cid), ReservationState::Unknown);
    assert_eq!(
        w.task().outstanding,
        yocto(10_000),
        "Unknown stays reserved"
    );
    assert!(reason_logged("timeout"));
    // a blind resend is a no-op
    as_(RELAYER, signed_at + MIN_AGE + 1);
    assert!(!w.p.mark_unknown(cid));
    assert!(!logs_have("payment_unknown"));
}

#[test]
fn mark_unknown_reserved_needs_an_hour() {
    let mut w = World::new();
    let cid = w.propose(10_000, "r1");
    let created = w.commit(cid).created_at;
    as_(RELAYER, created + evm_tx::RESERVED_AMBIGUOUS_MIN_AGE_NS - 1);
    panics_with(MSG_TOO_EARLY_UNKNOWN, || {
        let _ = w.p.mark_unknown(cid);
    });
    assert_eq!(
        w.idem("r1"),
        Some(IdemState::Pending),
        "a refused call changes nothing"
    );
    as_(OWNER, created + evm_tx::RESERVED_AMBIGUOUS_MIN_AGE_NS);
    assert!(w.p.mark_unknown(cid));
    assert_eq!(w.state(cid), ReservationState::Unknown);
    assert!(reason_logged("ambiguous"));
    assert_eq!(w.task().outstanding, yocto(10_000));
    assert_eq!(
        w.idem("r1"),
        Some(IdemState::Committed { commitment_id: cid }),
        "Reserved -> Unknown moves idempotency like on_signed's ambiguous path"
    );
    // the delegate's retry replays the cid instead of hitting MSG_IN_FLIGHT
    w.at(DELEGATE, 1);
    match w
        .p
        .propose_payment(TASK.into(), intent(10_000), "r1".into())
    {
        PromiseOrValue::Value(again) => assert_eq!(again, cid),
        PromiseOrValue::Promise(_) => panic!("a replay must not sign again"),
    }
    // a late valid signature after that is recorded (not lost)
    w.arrive(cid, "r1", Arrival::Valid);
    assert!(w.meta(cid).sig.is_some());
    assert_eq!(w.state(cid), ReservationState::Unknown);
}

#[test]
fn mark_unknown_is_a_no_op_on_settled_states() {
    use ReservationState::*;
    for st in [Unknown, Confirmed, Cancelled] {
        let mut w = World::new();
        let cid = w.reach(st, "r1");
        as_(OWNER, w.now + 10 * evm_tx::RESERVED_AMBIGUOUS_MIN_AGE_NS);
        assert!(!w.p.mark_unknown(cid), "{st:?}");
        assert_eq!(w.state(cid), st);
    }
}

// ---- views --------------------------------------------------------------------------------------

#[test]
fn views_expose_decimal_strings_and_the_evm_scheme() {
    let mut w = World::new();
    let cid = w.reach(ReservationState::Signed, "r1");
    let lane = w.p.evm_lane(PATH.into()).unwrap();
    assert_eq!(lane.in_flight, Some(cid));
    let json = serde_json::to_value(&lane).unwrap();
    assert_eq!(json["chain_id"], "11155111", "chain id is a decimal string");
    assert_eq!(json["next_nonce"], "5");
    let v = serde_json::to_value(w.p.get_signed_tx(cid).unwrap()).unwrap();
    assert_eq!(v["nonce"], "5");
    assert_eq!(v["original"]["max_fee_per_gas"], "40000000000");
    assert_eq!(v["original"]["value"], "10000");
    assert!(v["original"]["raw_tx"]
        .as_str()
        .unwrap()
        .starts_with("0x02"));
    assert!(v["cancel"].is_null());
    let cfg = serde_json::to_value(w.p.get_evm_cfg().unwrap()).unwrap();
    assert_eq!(cfg["cancel_bump_bps"], "1250");
    assert_eq!(cfg["gas_limit"], "21000");
    let s = w.p.evm_payload_scheme();
    assert_eq!(
        (s.chain.as_str(), s.hash_algorithm.as_str(), s.version),
        ("evm", "keccak256", 1)
    );
    assert!(w.p.evm_lane("nope".into()).is_none());
    assert!(w.p.get_signed_tx(99).is_none());
    // the NEAR scheme view is unchanged
    assert_eq!(w.p.payload_scheme().chain, "near-native");
}

// ---- the sign call is the only one, and its arguments are exactly the verified shape ------------

#[test]
fn the_only_sign_call_site_is_the_in_contract_builder() {
    // S1-style tripwire over the source: one `"sign"` function call, built from `sign_promise`, which takes
    // only a stored path and a contract-built digest. No other file may name the method.
    let api = include_str!("../evm_api.rs");
    let lib = include_str!("../lib.rs");
    let sites = api.matches("\"sign\".to_string()").count();
    assert_eq!(sites, 1, "exactly one `sign` function call");
    assert_eq!(
        api.matches("self.sign_promise(").count(),
        2,
        "original + cancel"
    );
    assert!(!lib.contains("\"sign\""), "lib.rs never calls the signer");
    for src in [
        include_str!("../evm_tx.rs"),
        include_str!("../budget.rs"),
        include_str!("../payload.rs"),
    ] {
        assert!(
            !src.contains("function_call"),
            "pure cores never create promises"
        );
    }
    // the args actually sent: decode the created receipt's function call under the mocked VM
    let digest = [0xabu8; 32];
    as_(DELEGATE, 1);
    let w = World::new();
    let before = near_sdk::test_utils::get_created_receipts().len();
    let _ = w.p.sign_promise("some/path", &digest);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let new_receipts = &receipts[before..];
    assert_eq!(new_receipts.len(), 1, "one receipt");
    assert_eq!(new_receipts[0].receiver_id.as_str(), SIGNER);
    let calls: Vec<_> = new_receipts[0]
        .actions
        .iter()
        .filter(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { .. }))
        .collect();
    assert_eq!(calls.len(), 1, "one function call");
    match calls[0] {
        near_sdk::mock::MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            prepaid_gas,
            ..
        } => {
            assert_eq!(method_name, b"sign");
            assert_eq!(attached_deposit.as_yoctonear(), 1);
            assert_eq!(*prepaid_gas, SIGN_GAS);
            let got: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(
                got,
                json!({"request": {
                    "path": "some/path",
                    "payload_v2": {"Ecdsa": "ab".repeat(32)},
                    "domain_id": 0,
                }}),
                "exactly the signer's request shape"
            );
        }
        _ => unreachable!(),
    }
    // bonus tripwire: the request shape is still built in exactly one place
    assert_eq!(api.matches("\"payload_v2\"").count(), 1);
}

// ==== Layer C: the real EVM composition under random interleavings ==============================
//
// Drives the actual `Purser` (propose, signer callbacks in any order/duplicated/garbled, relayer
// attestations, owner releases) under the mocked VM with NEAR's per-call semantics: state is loaded
// before each call and flushed after a SUCCESSFUL one; a panicking call is discarded (`mem::forget`),
// exactly like the runtime's rollback, and must have left every view unchanged. Signatures are real
// (`k256`), so "valid" is decided by the contract's own `ecrecover`.
//
// No second copy of the state machine: the properties are stated over what the chain may and may not
// do, using a ghost record of which proofs actually reached the contract:
//   P1 aggregates equal the ledger        P2 (I) holds unless the task is frozen, and frozen implies a
//   P3 nothing leaves the live set        contradiction was seen
//      without proof                      P4 one live commitment per lane, nonce strictly fresh
//   P5 Confirmed needs a finalized success attestation of the contract's own hash
//   P6 Cancelled needs attested evidence AND the owner's release
//   P7 Signed needs a valid signature     P8 a relayer can never release budget

mod model {
    use super::*;
    use proptest::prelude::*;
    use proptest::sample::Index;
    use std::cell::Cell;
    use std::collections::BTreeMap;

    thread_local!(static EXPECTING: Cell<bool> = const { Cell::new(false) });
    static HOOK: std::sync::Once = std::sync::Once::new();

    fn quiet_hook() {
        HOOK.call_once(|| {
            let default = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if !EXPECTING.with(Cell::get) {
                    default(info)
                }
            }));
        });
    }

    #[derive(Clone, Copy, Debug)]
    enum Op {
        Propose {
            amount: u16,
        },
        Deliver {
            pick: Index,
            how: u8,
        },
        DeliverCancel {
            pick: Index,
            how: u8,
        },
        MarkUnknown {
            pick: Index,
            as_owner: bool,
        },
        AttestOriginal {
            pick: Index,
            success: bool,
            finalized: bool,
            wrong_hash: bool,
        },
        AttestCancel {
            pick: Index,
            finalized: bool,
        },
        RequestCancel {
            pick: Index,
        },
        ConfirmRelease {
            pick: Index,
        },
        RelayerTriesRelease {
            pick: Index,
        },
        Tick {
            secs: u32,
        },
    }

    fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            6 => prop_oneof![1_000u16..=60_000, Just(60_000u16), Just(55_000u16)].prop_map(|amount| Op::Propose { amount }),
            8 => (any::<Index>(), prop_oneof![4 => Just(0u8), 1 => Just(1u8), 1 => Just(2u8), 1 => Just(3u8)]).prop_map(|(pick, how)| Op::Deliver { pick, how }),
            3 => (any::<Index>(), 0u8..4).prop_map(|(pick, how)| Op::DeliverCancel { pick, how }),
            3 => (any::<Index>(), any::<bool>()).prop_map(|(pick, as_owner)| Op::MarkUnknown { pick, as_owner }),
            5 => (any::<Index>(), prop::bool::weighted(0.8), prop::bool::weighted(0.8), prop::bool::weighted(0.1))
                .prop_map(|(pick, success, finalized, wrong_hash)| Op::AttestOriginal { pick, success, finalized, wrong_hash }),
            3 => (any::<Index>(), prop::bool::weighted(0.8)).prop_map(|(pick, finalized)| Op::AttestCancel { pick, finalized }),
            3 => any::<Index>().prop_map(|pick| Op::RequestCancel { pick }),
            3 => any::<Index>().prop_map(|pick| Op::ConfirmRelease { pick }),
            1 => any::<Index>().prop_map(|pick| Op::RelayerTriesRelease { pick }),
            4 => prop_oneof![1u32..=60, 290u32..=320, 3_590u32..=3_620].prop_map(|secs| Op::Tick { secs }),
        ]
    }

    #[derive(Clone, Copy, Default, Debug)]
    struct Ghost {
        valid_delivered: bool,
        final_success: bool,
        evidence: bool,
        owner_released: bool,
        contradicted: bool,
    }

    type Snap = (
        Option<TaskBudget>,
        Vec<(Option<Commitment>, Option<SignedTxView>)>,
        Option<LaneView>,
        Vec<Option<IdemState>>,
    );

    struct Run {
        key: Key,
        other: Key,
        now: u64,
        reqs: u32,
        ghosts: Vec<Ghost>,
        last_next_nonce: u64,
        saw_contradiction: bool,
    }

    fn snapshot(p: &Purser, n: u64, reqs: u32) -> Snap {
        (
            p.get_task(TASK.into()),
            (0..=n)
                .map(|i| (p.get_commitment(i), p.get_signed_tx(i)))
                .collect(),
            p.evm_lane(PATH.into()),
            (0..reqs)
                .map(|r| p.get_idempotency(acct(DELEGATE), format!("q{r}")))
                .collect(),
        )
    }

    impl Run {
        /// One NEAR call: load, run, flush on success; on panic discard and check nothing changed.
        fn call<R>(
            &mut self,
            who: &str,
            dt_ns: u64,
            f: impl FnOnce(&mut Purser) -> R,
        ) -> Result<Result<R, String>, TestCaseError> {
            self.now += dt_ns;
            let n = self.ghosts.len() as u64;
            as_(who, self.now);
            let before = {
                let p: Purser = env::state_read().unwrap();
                let s = snapshot(&p, n, self.reqs);
                std::mem::forget(p);
                s
            };
            as_(who, self.now);
            let mut p: Purser = env::state_read().unwrap();
            EXPECTING.with(|e| e.set(true));
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut p)));
            EXPECTING.with(|e| e.set(false));
            match r {
                Ok(v) => {
                    env::state_write(&p);
                    drop(p);
                    Ok(Ok(v))
                }
                Err(e) => {
                    let msg = e
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default();
                    let after = snapshot(&p, n, self.reqs);
                    std::mem::forget(p); // never flush a call the runtime would roll back
                    prop_assert_eq!(&before, &after, "panicking call mutated state: {}", msg);
                    Ok(Err(msg))
                }
            }
        }

        fn view(&self) -> Purser {
            as_(OWNER, self.now);
            env::state_read().unwrap()
        }
    }

    fn build() -> Run {
        // `testing_env!` carries storage over; every case starts empty.
        reset_storage();
        let key = Key::new(0x11);
        let other = Key::new(0x22);
        as_(OWNER, T0);
        let mut p = Purser::new(acct(OWNER), acct(SIGNER));
        p.create_task(TASK.into(), yocto(100_000), TokenSpec::NearNative, 3);
        p.set_evm_cfg(
            U64(CHAIN),
            U128(40_000_000_000),
            U128(2_000_000_000),
            U128(1_000),
            U64(MIN_AGE),
        );
        p.enable_evm_task(TASK.into());
        p.add_delegate(TASK.into(), acct(DELEGATE), PATH.into());
        p.set_relayer(acct(RELAYER));
        as_(CONTRACT, T0);
        p.on_derived_key(PATH.into(), U64(CHAIN), Ok(key.near_string()));
        as_(OWNER, T0);
        p.seed_evm_nonce(PATH.into(), U64(5));
        env::state_write(&p);
        drop(p);
        Run {
            key,
            other,
            now: T0,
            reqs: 0,
            ghosts: Vec::new(),
            last_next_nonce: 5,
            saw_contradiction: false,
        }
    }

    fn digest_of(v: &SignedTxView, cancel: bool) -> [u8; 32] {
        let tx = if cancel {
            v.cancel.as_ref().unwrap()
        } else {
            &v.original
        };
        evm_tx::from_hex::<32>(&tx.sighash).unwrap()
    }

    fn response_for(run: &Run, digest: &[u8; 32], how: u8) -> Result<Value, PromiseError> {
        match how {
            0 => Ok(response(&run.key.sign(digest))),
            1 => Ok(response(&run.other.sign(digest))),
            2 => Err(PromiseError::Failed),
            _ => Ok(json!({"scheme": "Secp256k1", "recovery_id": 2})),
        }
    }

    fn step(run: &mut Run, op: Op) -> Result<(), TestCaseError> {
        let n = run.ghosts.len();
        let pick = |p: &Index| (n > 0).then(|| p.index(n) as u64);
        let before = run.view();
        let b0 = before.get_task(TASK.into()).unwrap();
        let live_before: Vec<(u64, ReservationState)> = (0..n as u64)
            .map(|i| (i, before.get_commitment(i).unwrap().state))
            .collect();
        std::mem::forget(before);
        let (mut released_by_owner, mut settled_by_attest) = (false, false);

        match op {
            Op::Propose { amount } => {
                let req = format!("q{}", run.reqs);
                let r = run.call(DELEGATE, 1_000, |p| {
                    p.propose_payment(TASK.into(), intent(amount as u128), req.clone())
                })?;
                if r.is_ok() {
                    run.reqs += 1;
                    run.ghosts.push(Ghost::default());
                } else {
                    // a refused proposal consumed neither a request id nor a cid
                    let p = run.view();
                    prop_assert_eq!(p.get_commitment(n as u64), None);
                    std::mem::forget(p);
                }
            }
            Op::Deliver { pick: pk, how } => {
                if let Some(cid) = pick(&pk) {
                    let p = run.view();
                    let v = p.get_signed_tx(cid).unwrap();
                    std::mem::forget(p);
                    let res = response_for(run, &digest_of(&v, false), how);
                    let req = format!("q{cid}");
                    let r = run.call(CONTRACT, 1_000, |p| p.on_signed(cid, req, res))?;
                    prop_assert!(r.is_ok(), "on_signed must be total: {:?}", r);
                    if how == 0 {
                        run.ghosts[cid as usize].valid_delivered = true;
                    }
                }
            }
            Op::DeliverCancel { pick: pk, how } => {
                if let Some(cid) = pick(&pk) {
                    let p = run.view();
                    let v = p.get_signed_tx(cid).unwrap();
                    std::mem::forget(p);
                    if v.cancel.is_some() {
                        let res = response_for(run, &digest_of(&v, true), how);
                        let r = run.call(CONTRACT, 1_000, |p| p.on_cancel_signed(cid, res))?;
                        prop_assert!(r.is_ok(), "on_cancel_signed must be total: {:?}", r);
                    }
                }
            }
            Op::MarkUnknown { pick: pk, as_owner } => {
                if let Some(cid) = pick(&pk) {
                    let who = if as_owner { OWNER } else { RELAYER };
                    let _ = run.call(who, 1_000, |p| p.mark_unknown(cid))?;
                }
            }
            Op::AttestOriginal {
                pick: pk,
                success,
                finalized,
                wrong_hash,
            } => {
                if let Some(cid) = pick(&pk) {
                    let p = run.view();
                    let v = p.get_signed_tx(cid).unwrap();
                    std::mem::forget(p);
                    let real = v.original.tx_hash.clone();
                    let hash = match (&real, wrong_hash) {
                        (Some(h), false) => h.clone(),
                        _ => evm_tx::to_hex0x(&[0xee; 32]),
                    };
                    let f = if finalized {
                        Finality::Finalized
                    } else {
                        Finality::Safe
                    };
                    let o = ExternalOutcome::Landed {
                        success,
                        finality: f,
                        block_number: U64(1),
                        block_hash: format!("0x{}", "cd".repeat(32)),
                        signature: None,
                    };
                    let r =
                        run.call(RELAYER, 1_000, |p| p.attest_external(cid, hash.clone(), o))?;
                    if r.is_ok() && Some(&hash) == real.as_ref() && finalized {
                        let g = &mut run.ghosts[cid as usize];
                        if success {
                            g.final_success = true;
                            settled_by_attest = true;
                        } else {
                            g.evidence = true;
                        }
                    } else if !wrong_hash && real.is_some() {
                        // a correct hash is never refused (the call is total on every state)
                        prop_assert!(
                            r.is_ok(),
                            "attesting the contract's own hash was refused: {:?}",
                            r
                        );
                    }
                }
            }
            Op::AttestCancel {
                pick: pk,
                finalized,
            } => {
                if let Some(cid) = pick(&pk) {
                    let p = run.view();
                    let v = p.get_signed_tx(cid).unwrap();
                    std::mem::forget(p);
                    if let Some(h) = v.cancel.and_then(|c| c.tx_hash) {
                        let f = if finalized {
                            Finality::Finalized
                        } else {
                            Finality::Safe
                        };
                        let o = ExternalOutcome::Landed {
                            success: true,
                            finality: f,
                            block_number: U64(1),
                            block_hash: format!("0x{}", "cd".repeat(32)),
                            signature: None,
                        };
                        let r = run.call(RELAYER, 1_000, |p| p.attest_external(cid, h, o))?;
                        if r.is_ok() && finalized {
                            run.ghosts[cid as usize].evidence = true;
                        }
                    }
                }
            }
            Op::RequestCancel { pick: pk } => {
                if let Some(cid) = pick(&pk) {
                    // the owner raises the ceilings above the original (it was priced AT the ceiling)
                    let _ = run.call(OWNER, 1_000, |p| {
                        p.set_evm_cfg(
                            U64(CHAIN),
                            U128(2 * CANCEL_FEE),
                            U128(2 * CANCEL_TIP),
                            U128(1_000),
                            U64(MIN_AGE),
                        )
                    })?;
                    let _ = run.call(RELAYER, 1_000, |p| {
                        p.request_cancel(cid, U128(CANCEL_FEE), U128(CANCEL_TIP))
                            .detach()
                    })?;
                }
            }
            Op::ConfirmRelease { pick: pk } => {
                if let Some(cid) = pick(&pk) {
                    let r = run.call(OWNER, 1_000, |p| p.confirm_release(cid))?;
                    if r.is_ok() {
                        run.ghosts[cid as usize].owner_released = true;
                        released_by_owner = true;
                    }
                }
            }
            Op::RelayerTriesRelease { pick: pk } => {
                if let Some(cid) = pick(&pk) {
                    let r = run.call(RELAYER, 1_000, |p| p.confirm_release(cid))?;
                    prop_assert!(r.is_err(), "P8: a relayer released budget");
                }
            }
            Op::Tick { secs } => {
                run.now += secs as u64 * 1_000_000_000;
            }
        }

        // ---- properties over the resulting state ----
        let p = run.view();
        let b = p.get_task(TASK.into()).unwrap();
        let n = run.ghosts.len();
        let commits: Vec<Commitment> = (0..n as u64)
            .map(|i| p.get_commitment(i).unwrap())
            .collect();
        let lane = p.evm_lane(PATH.into()).unwrap();
        let metas: BTreeMap<u64, SignedTxView> = (0..n as u64)
            .map(|i| (i, p.get_signed_tx(i).unwrap()))
            .collect();
        std::mem::forget(p);

        // P1 aggregates equal the ledger
        let live = |s: ReservationState| {
            matches!(
                s,
                ReservationState::Reserved | ReservationState::Signed | ReservationState::Unknown
            )
        };
        let out: u128 = commits
            .iter()
            .filter(|c| live(c.state))
            .map(|c| c.reserved_amount.as_yoctonear())
            .sum();
        let done: u128 = commits
            .iter()
            .filter(|c| c.state == ReservationState::Confirmed)
            .map(|c| c.actual_spent.unwrap().as_yoctonear())
            .sum();
        prop_assert_eq!(b.outstanding.as_yoctonear(), out, "outstanding desynced");
        prop_assert_eq!(b.completed.as_yoctonear(), done, "completed desynced");

        // contradictions seen this step (Cancelled -> Confirmed)
        for (i, c) in commits.iter().enumerate() {
            if i < live_before.len()
                && live_before[i].1 == ReservationState::Cancelled
                && c.state == ReservationState::Confirmed
            {
                run.saw_contradiction = true;
                run.ghosts[i].contradicted = true;
            }
        }
        // P2 (I) unless frozen; frozen implies a contradiction
        if !b.frozen {
            prop_assert!(
                b.completed.as_yoctonear() + b.outstanding.as_yoctonear() <= b.cap.as_yoctonear(),
                "(I) broken on a task that is not frozen"
            );
        } else {
            prop_assert!(run.saw_contradiction, "frozen without a contradiction");
        }
        prop_assert!(!b0.frozen || b.frozen, "freeze is permanent");

        // P3 nothing leaves the live set without proof; no release on silence
        let mut leaving = 0;
        for (i, (_, st0)) in live_before.iter().enumerate() {
            let st1 = commits[i].state;
            if live(*st0) && !live(st1) {
                leaving += 1;
                match st1 {
                    ReservationState::Confirmed => {
                        prop_assert!(settled_by_attest, "Confirmed without an attestation step")
                    }
                    ReservationState::Cancelled => {
                        prop_assert!(released_by_owner, "Cancelled without the owner's release")
                    }
                    other => prop_assert!(false, "live -> {:?}", other),
                }
            }
        }
        prop_assert!(leaving <= 1);
        if !settled_by_attest && !released_by_owner {
            prop_assert!(
                b.outstanding >= b0.outstanding,
                "outstanding fell without proof"
            );
        }
        // P5 / P6 / P7 per commitment
        for (i, c) in commits.iter().enumerate() {
            let g = run.ghosts[i];
            match c.state {
                ReservationState::Confirmed => prop_assert!(
                    g.final_success,
                    "Confirmed {} without a finalized success attestation",
                    i
                ),
                ReservationState::Cancelled => prop_assert!(
                    g.owner_released && g.evidence,
                    "Cancelled {} without evidence + owner",
                    i
                ),
                ReservationState::Signed => {
                    prop_assert!(g.valid_delivered, "Signed {} without a valid signature", i)
                }
                _ => {}
            }
            if c.state == ReservationState::Confirmed && g.contradicted {
                prop_assert!(g.final_success);
            }
            prop_assert_eq!(
                c.reserved_amount.as_yoctonear(),
                metas[&(i as u64)].original.value.0
            );
        }
        // P4 one live commitment per lane; the lane names it; nonces strictly fresh and never repeated
        let live_ids: Vec<u64> = commits
            .iter()
            .filter(|c| live(c.state))
            .map(|c| c.id)
            .collect();
        prop_assert!(
            live_ids.len() <= 1,
            "two live commitments on one lane: {:?}",
            live_ids
        );
        prop_assert_eq!(lane.in_flight, live_ids.first().copied());
        let next = lane.next_nonce.unwrap().0;
        prop_assert!(next >= run.last_next_nonce, "nonce regressed");
        run.last_next_nonce = next;
        let mut nonces = BTreeMap::new();
        for (i, v) in &metas {
            prop_assert!(
                nonces.insert(v.nonce.0, *i).is_none(),
                "nonce {} reused",
                v.nonce.0
            );
            prop_assert!(
                v.nonce.0 < next || live_ids.contains(i),
                "an advanced lane skipped nothing"
            );
        }
        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(150))]

        #[test]
        fn evm_invariants_hold_over_random_interleavings(ops in prop::collection::vec(op_strategy(), 1..48)) {
            quiet_hook();
            let mut run = build();
            for op in ops {
                step(&mut run, op)?;
            }
        }
    }
}
