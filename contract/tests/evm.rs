//! Sandbox suite for the governed EVM payment path (Prompt 12) against the REAL promise flow: Purser calls a
//! mock MPC signer (`tests/fixtures/mock-signer`, a stand-in that really ECDSA-signs), verifies the response
//! with `env::ecrecover` against the cached derived key, and is driven by a relayer account that attests what
//! "happened on Sepolia". Nothing here touches a network or a real key.
//!
//! Every step asserts the `invariant` view (`holds`, or `frozen` for the one modelled contradiction breach).
//! Independent oracles: the `rlp` + `sha3` crates re-encode and re-hash every raw transaction the contract
//! hands out, and `k256` recovers its sender.
//!
//! Not reachable through the public surface (covered by the host totality tests in `src/evm_api/tests.rs`):
//! the callbacks are `#[private]`, so a late `Ok` after a timed-out `Err` cannot be injected here; the
//! reachable late-signature path (an `Unknown` commitment whose signature was lost, recovered through an
//! attestation that carries `(r, s, yParity)`) is tested in `a_lost_signature_is_recovered_only_when_it_verifies`.

mod common;

use common::*;
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, Scalar, U256};
use near_workspaces::result::ExecutionFinalResult;
use purser_contract::*;
use rlp::{Rlp, RlpStream};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256, Sha3_256};

/// `cfg.min_unknown_age_ns`: the contract's 5 minute floor.
const AGE_NS: u64 = 300 * 1_000_000_000;

// ---- independent EVM oracles ----------------------------------------------------------------------

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn pad32(v: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(v);
    out
}

fn strip(v: &[u8]) -> &[u8] {
    let n = v.iter().take_while(|b| **b == 0).count();
    &v[n..]
}

/// What an original or cancel must look like, built from the test's own knowledge.
#[derive(Debug, PartialEq, Eq)]
struct Tx {
    chain_id: u64,
    nonce: u64,
    tip: u128,
    max_fee: u128,
    to: Vec<u8>,
    value: u128,
}

impl Tx {
    fn fields(&self, s: &mut RlpStream) {
        s.append(&self.chain_id)
            .append(&self.nonce)
            .append(&self.tip)
            .append(&self.max_fee)
            .append(&21_000u64)
            .append(&self.to.as_slice())
            .append(&self.value)
            .append_empty_data()
            .begin_list(0);
    }

    fn sighash(&self) -> [u8; 32] {
        let mut s = RlpStream::new_list(9);
        self.fields(&mut s);
        let mut b = vec![0x02];
        b.extend_from_slice(&s.out());
        keccak(&b)
    }

    fn signed_raw(&self, r: &[u8; 32], s: &[u8; 32], y: u8) -> Vec<u8> {
        let mut st = RlpStream::new_list(12);
        self.fields(&mut st);
        st.append(&y).append(&strip(r)).append(&strip(s));
        let mut b = vec![0x02];
        b.extend_from_slice(&st.out());
        b
    }
}

/// Decode a raw type-2 transaction with the `rlp` crate: `(fields, r, s, yParity)`.
fn decode_raw(raw: &[u8]) -> (Tx, [u8; 32], [u8; 32], u8) {
    assert_eq!(raw[0], 0x02, "type-2 transaction");
    let r = Rlp::new(&raw[1..]);
    assert_eq!(r.item_count().unwrap(), 12);
    let tx = Tx {
        chain_id: r.val_at(0).unwrap(),
        nonce: r.val_at(1).unwrap(),
        tip: r.val_at(2).unwrap(),
        max_fee: r.val_at(3).unwrap(),
        to: r.val_at(5).unwrap(),
        value: r.val_at(6).unwrap(),
    };
    assert_eq!(r.val_at::<u64>(4).unwrap(), 21_000, "gas limit");
    assert!(r.at(7).unwrap().is_empty(), "data is empty");
    assert_eq!(r.at(8).unwrap().item_count().unwrap(), 0, "no access list");
    let (y, rr, ss): (u8, Vec<u8>, Vec<u8>) = (
        r.val_at(9).unwrap(),
        r.val_at(10).unwrap(),
        r.val_at(11).unwrap(),
    );
    (tx, pad32(&rr), pad32(&ss), y)
}

/// The sender address `ecrecover` gives for `sig` over `sighash`.
fn recover_sender(sighash: &[u8; 32], r: &[u8; 32], s: &[u8; 32], y: u8) -> Vec<u8> {
    let sig = Signature::from_scalars(FieldBytes::from(*r), FieldBytes::from(*s)).unwrap();
    let vk = VerifyingKey::recover_from_prehash(sighash, &sig, RecoveryId::from_byte(y).unwrap())
        .unwrap();
    keccak(&vk.to_encoded_point(false).as_bytes()[1..])[12..].to_vec()
}

/// Everything the relayer checks before it broadcasts a view's `raw_tx`, independently: keccak(raw) ==
/// tx_hash, the fields are what we expect, the oracle re-encodes the identical bytes, and the sender
/// recovers to the lane address. Returns the tx hash.
fn verify_tx(view: &Value, expect: &Tx, from: &str) -> String {
    let raw = unhex(view["raw_tx"].as_str().expect("raw_tx present"));
    let hash = view["tx_hash"].as_str().expect("tx_hash present");
    assert_eq!(
        format!("0x{}", hex(&keccak(&raw))),
        hash,
        "keccak(raw) == tx_hash"
    );
    let (tx, r, s, y) = decode_raw(&raw);
    assert_eq!(&tx, expect, "decoded fields");
    assert_eq!(
        expect.signed_raw(&r, &s, y),
        raw,
        "oracle re-encodes the same bytes"
    );
    assert_eq!(
        format!("0x{}", hex(&expect.sighash())),
        view["sighash"].as_str().unwrap()
    );
    assert_eq!(
        format!("0x{}", hex(&recover_sender(&expect.sighash(), &r, &s, y))),
        from,
        "sender recovers to the lane address"
    );
    hash.to_string()
}

/// The mock signer's signature for `(predecessor, path)`, recomputed independently (public fake root
/// 32 x 0x42 + the real tweak formula): what a relayer would read off the chain for a lost signature.
fn mock_sign(predecessor: &str, path: &str, digest: &[u8; 32]) -> ([u8; 32], [u8; 32], u8) {
    let root = Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from([0x42u8; 32]))).unwrap();
    let mut h = Sha3_256::new();
    h.update(b"near-mpc-recovery v0.1.0 epsilon derivation:");
    h.update(predecessor.as_bytes());
    h.update(b",");
    h.update(path.as_bytes());
    let tweak =
        <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(<[u8; 32]>::from(h.finalize())));
    let key = SigningKey::from_bytes(&(root + tweak).to_bytes()).unwrap();
    let (sig, rid) = key.sign_prehash_recoverable(digest).unwrap();
    let (sig, rid) = match sig.normalize_s() {
        Some(low) => (low, RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced())),
        None => (sig, rid),
    };
    let (r, s) = sig.split_bytes();
    (r.into(), s.into(), rid.to_byte())
}

// ---- flow helpers ---------------------------------------------------------------------------------

async fn fresh(path: &str, stage: Stage) -> anyhow::Result<EvmCrew> {
    evm_setup(near_workspaces::sandbox().await?, path, AGE_NS, stage).await
}

fn u(v: &Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

fn expect_original(c: &Value, value: u128, nonce: u64) -> Tx {
    Tx {
        chain_id: SEPOLIA,
        nonce,
        tip: u(&c["original"], "max_priority_fee_per_gas"),
        max_fee: u(&c["original"], "max_fee_per_gas"),
        to: unhex(EVM_TO),
        value,
    }
}

fn refused(res: ExecutionFinalResult, msg: &str) {
    assert!(res.is_failure(), "expected a refusal containing {msg:?}");
    let e = err_string(res);
    assert!(e.contains(msg), "expected {msg:?} in: {e}");
}

fn logged(res: &ExecutionFinalResult, needle: &str) -> bool {
    res.logs().iter().any(|l| l.contains(needle))
}

/// Fast-forward until the chain clock is past `signed_at + AGE`.
async fn age_past_unknown_floor(c: &EvmCrew) -> anyhow::Result<()> {
    let signed_at: u64 = c.signed_tx(0).await?["signed_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    let mut now = c.worker.view_block().await?.timestamp();
    while now < signed_at + AGE_NS + 1_000_000_000 {
        now = c.fast_forward(400).await?;
    }
    Ok(())
}

/// Propose (cid 0), sign OK, age past the floor, `mark_unknown` by the relayer. Leaves commitment 0 Unknown.
async fn stuck_unknown(c: &EvmCrew, value: u128) -> anyhow::Result<u64> {
    let (cid, _) = c.propose_ok(value, "stuck-1").await?;
    assert_eq!(c.state(cid).await?, "Signed");
    age_past_unknown_floor(c).await?;
    let res = c
        .call(&c.relayer, "mark_unknown", json!({ "commitment_id": cid }))
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert!(res.json::<bool>()?);
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(
        c.inv().await?,
        (0, value, false),
        "Unknown keeps the reservation"
    );
    Ok(cid)
}

/// Raise the ceilings (owner) so a cancel can carry the 12.5% bump over an original priced AT the old ones.
async fn raise_ceilings(c: &EvmCrew) -> anyhow::Result<()> {
    let res = c
        .call(
            &c.owner,
            "set_evm_cfg",
            json!({
                "chain_id": SEPOLIA.to_string(),
                "max_fee_ceiling": (MAX_FEE * 2).to_string(),
                "max_priority_ceiling": (MAX_TIP * 2).to_string(),
                "min_value": "1000000000",
                "min_unknown_age_ns": AGE_NS.to_string(),
            }),
        )
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    Ok(())
}

/// request_cancel at 1.5x the original; returns the cancel's tx hash after `on_cancel_signed` ran.
async fn cancel_signed(c: &EvmCrew, cid: u64, value: u128) -> anyhow::Result<String> {
    raise_ceilings(c).await?;
    let (fee, tip) = (MAX_FEE * 3 / 2, MAX_TIP * 3 / 2);
    let res = c
        .call(
            &c.relayer,
            "request_cancel",
            json!({
                "commitment_id": cid, "max_fee": fee.to_string(), "tip": tip.to_string(),
            }),
        )
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert!(logged(&res, "\"event\":\"cancel_signed\""));
    assert_eq!(
        c.inv().await?.1,
        value,
        "a cancel request moves no accounting"
    );
    let v = c.signed_tx(cid).await?;
    let nonce = v["nonce"].as_str().unwrap().parse()?;
    let cancel = Tx {
        chain_id: SEPOLIA,
        nonce,
        tip,
        max_fee: fee,
        to: unhex(v["from"].as_str().unwrap()), // a self-send...
        value: 0,                               // ...of nothing
    };
    Ok(verify_tx(
        &v["cancel"],
        &cancel,
        v["from"].as_str().unwrap(),
    ))
}

// ---- (a) happy path -------------------------------------------------------------------------------

#[tokio::test]
async fn happy_path_signs_verifies_attests_and_settles() -> anyhow::Result<()> {
    let c = fresh("evm/happy", Stage::Bare).await?;
    assert_eq!(
        c.view("task_unit", json!({ "task_id": TASK })).await?,
        "wei"
    );
    assert_eq!(c.inv().await?, (0, 0, false));

    // the cached key is exactly what the signer says, and the lane address is its keccak tail
    let res = c.cache_key().await?;
    assert!(logged(&res, "\"cached\":true"));
    let derived: String = c
        .signer
        .view("derived_public_key")
        .args_json(json!({ "path": c.path, "predecessor": c.purser.id(), "domain_id": 0 }))
        .await?
        .json()?;
    let pk = near_sdk::bs58::decode(derived.strip_prefix("secp256k1:").unwrap()).into_vec()?;
    let lane = c.lane().await?;
    assert_eq!(lane["pubkey"].as_str().unwrap(), hex(&pk));
    assert_eq!(
        lane["address"].as_str().unwrap(),
        format!("0x{}", hex(&keccak(&pk)[12..]))
    );
    assert!(lane["next_nonce"].is_null() && lane["in_flight"].is_null());
    // write-once: a second cache is refused
    refused(c.cache_key_raw().await?, MSG_EVM_KEY_CACHED);
    assert_eq!(c.inv().await?, (0, 0, false));

    let res = c
        .call(
            &c.owner,
            "seed_evm_nonce",
            json!({ "path": c.path, "nonce": SEED_NONCE.to_string() }),
        )
        .await?;
    assert!(res.is_success());
    assert_eq!(c.inv().await?, (0, 0, false));

    // propose -> the real sign promise -> on_signed verifies by ecrecover -> Signed
    let (cid, res) = c.propose_ok(EVM_VALUE, "pay-1").await?;
    assert!(
        logged(&res, "\"event\":\"payment_reserved\"")
            && logged(&res, "\"event\":\"payment_signed\"")
    );
    assert_eq!(c.state(cid).await?, "Signed");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    let lane = c.lane().await?;
    assert_eq!(lane["in_flight"], json!(cid));

    // the raw transaction verifies independently; the commitment carries its hash
    let v = c.signed_tx(cid).await?;
    let hash = verify_tx(
        &v["original"],
        &expect_original(&v, EVM_VALUE, SEED_NONCE),
        lane["address"].as_str().unwrap(),
    );
    assert_eq!(c.commitment(cid).await?["evm_tx"], hash);
    // the payload anchor of an EVM commitment is the very digest that was signed
    let anchor: Vec<u8> = serde_json::from_value(c.commitment(cid).await?["payload_hash"].clone())?;
    assert_eq!(anchor, unhex(v["original"]["sighash"].as_str().unwrap()));
    // a retry of the same request id returns the same cid and reserves nothing more
    let replay = c.propose(EVM_VALUE, "pay-1", 300).await?;
    assert_eq!(replay.json::<u64>()?, cid);
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));

    // the relayer attests the original, success, Finalized -> Confirmed and settled
    let res = c.attest(&c.relayer, cid, &hash, true, "Finalized").await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert!(logged(&res, "\"event\":\"payment_confirmed\""));
    assert_eq!(c.state(cid).await?, "Confirmed");
    assert_eq!(c.inv().await?, (EVM_VALUE, 0, false));
    let lane = c.lane().await?;
    assert!(lane["in_flight"].is_null());
    assert_eq!(lane["next_nonce"], (SEED_NONCE + 1).to_string());
    // and the next payment uses the next nonce
    let (cid2, _) = c.propose_ok(EVM_VALUE, "pay-2").await?;
    let v2 = c.signed_tx(cid2).await?;
    assert_eq!(v2["nonce"], (SEED_NONCE + 1).to_string());
    assert_eq!(c.inv().await?, (EVM_VALUE, EVM_VALUE, false));
    Ok(())
}

// ---- (b) stuck stays reserved ---------------------------------------------------------------------

#[tokio::test]
async fn a_stuck_payment_stays_reserved_across_blocks_and_only_trusted_callers_mark_it_unknown(
) -> anyhow::Result<()> {
    let c = fresh("evm/stuck", Stage::Seeded).await?;
    let (cid, _) = c.propose_ok(EVM_VALUE, "stuck-1").await?;
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));

    // silence is not proof: blocks pass, nothing releases, mark_unknown is refused as too early
    for _ in 0..3 {
        c.fast_forward(100).await?;
        assert_eq!(c.state(cid).await?, "Signed");
        assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    }
    refused(
        c.call(&c.relayer, "mark_unknown", json!({ "commitment_id": cid }))
            .await?,
        MSG_TOO_EARLY_UNKNOWN,
    );
    // the lane is held, so a second proposal is refused (and reserves nothing)
    refused(
        c.propose(EVM_VALUE, "stuck-2", 300).await?,
        MSG_EVM_LANE_BUSY,
    );
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));

    age_past_unknown_floor(&c).await?;
    // never permissionless
    refused(
        c.call(&c.delegate, "mark_unknown", json!({ "commitment_id": cid }))
            .await?,
        MSG_ONLY_OWNER_OR_RELAYER,
    );
    let res = c
        .call(&c.relayer, "mark_unknown", json!({ "commitment_id": cid }))
        .await?;
    assert!(res.is_success() && logged(&res, "\"reason\":\"timeout\""));
    assert!(res.json::<bool>()?);
    // Unknown keeps the whole reservation, and the lane stays held
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    assert_eq!(c.lane().await?["in_flight"], json!(cid));
    // a blind resend is a no-op, not an error
    let again = c
        .call(&c.owner, "mark_unknown", json!({ "commitment_id": cid }))
        .await?;
    assert!(again.is_success() && !again.json::<bool>()?);
    c.fast_forward(200).await?;
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    Ok(())
}

// ---- (c) cancel -> attested -> owner releases -----------------------------------------------------

#[tokio::test]
async fn a_landed_cancel_releases_only_through_the_owner_and_advances_the_lane(
) -> anyhow::Result<()> {
    let c = fresh("evm/cancel", Stage::Seeded).await?;
    let cid = stuck_unknown(&c, EVM_VALUE).await?;
    let orig_hash = c.signed_tx(cid).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();

    // the original was priced AT the ceilings, so a cancel cannot carry its bump yet
    let low = c
        .call(
            &c.relayer,
            "request_cancel",
            json!({
                "commitment_id": cid, "max_fee": MAX_FEE.to_string(), "tip": MAX_TIP.to_string(),
            }),
        )
        .await?;
    assert!(low.is_failure());
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    refused(
        c.call(
            &c.delegate,
            "request_cancel",
            json!({
                "commitment_id": cid, "max_fee": "1", "tip": "1",
            }),
        )
        .await?,
        MSG_ONLY_OWNER_OR_RELAYER,
    );
    // no evidence yet: the owner cannot release
    refused(
        c.call(&c.owner, "confirm_release", json!({ "commitment_id": cid }))
            .await?,
        MSG_NO_RELEASE_EVIDENCE,
    );

    let cancel_hash = cancel_signed(&c, cid, EVM_VALUE).await?;
    assert_ne!(cancel_hash, orig_hash);
    // one cancel in v1
    refused(c.call(&c.relayer, "request_cancel", json!({
        "commitment_id": cid, "max_fee": (MAX_FEE * 2).to_string(), "tip": (MAX_TIP * 2).to_string(),
    })).await?, MSG_CANCEL_EXISTS);
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));

    // the relayer attests the cancel landed: evidence only, still reserved, and it cannot release
    let res = c
        .attest(&c.relayer, cid, &cancel_hash, true, "Finalized")
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(c.signed_tx(cid).await?["evidence"], "cancel_landed");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    refused(
        c.call(
            &c.relayer,
            "confirm_release",
            json!({ "commitment_id": cid }),
        )
        .await?,
        MSG_ONLY_OWNER,
    );

    // the owner (second key) releases
    let res = c
        .call(&c.owner, "confirm_release", json!({ "commitment_id": cid }))
        .await?;
    assert!(res.is_success() && logged(&res, "\"event\":\"payment_cancelled\""));
    assert_eq!(c.state(cid).await?, "Cancelled");
    assert_eq!(
        c.inv().await?,
        (0, 0, false),
        "the reservation went back to the budget"
    );
    let lane = c.lane().await?;
    assert!(lane["in_flight"].is_null());
    assert_eq!(
        lane["next_nonce"],
        (SEED_NONCE + 1).to_string(),
        "the lane advanced past the burnt nonce"
    );
    // a second release is refused (not Unknown any more) and the lane is usable again
    refused(
        c.call(&c.owner, "confirm_release", json!({ "commitment_id": cid }))
            .await?,
        MSG_NOT_CANCELLABLE,
    );
    let (cid2, _) = c.propose_ok(EVM_VALUE, "after-cancel").await?;
    assert_eq!(
        c.signed_tx(cid2).await?["nonce"],
        (SEED_NONCE + 1).to_string()
    );
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    Ok(())
}

// ---- (d) original lands after the release ---------------------------------------------------------

#[tokio::test]
async fn an_original_landing_after_the_release_is_a_contradiction_that_freezes_but_still_attests(
) -> anyhow::Result<()> {
    let c = fresh("evm/contra", Stage::Seeded).await?;
    let cid = stuck_unknown(&c, EVM_VALUE).await?;
    let orig_hash = c.signed_tx(cid).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let cancel_hash = cancel_signed(&c, cid, EVM_VALUE).await?;
    assert!(c
        .attest(&c.relayer, cid, &cancel_hash, true, "Finalized")
        .await?
        .is_success());
    assert!(c
        .call(&c.owner, "confirm_release", json!({ "commitment_id": cid }))
        .await?
        .is_success());
    assert_eq!(c.inv().await?, (0, 0, false));

    // the freed budget is re-spent: 4.5e15 of the 5e15 cap
    let big = 4_500_000_000_000_000u128;
    let (cid2, _) = c.propose_ok(big, "respend").await?;
    assert_eq!(c.state(cid2).await?, "Signed");
    assert_eq!(c.inv().await?, (0, big, false));

    // ...then the original lands anyway (a third party broadcast it): the spend is recorded and the task freezes
    let res = c
        .attest(&c.relayer, cid, &orig_hash, true, "Finalized")
        .await?;
    assert!(
        res.is_success(),
        "attestation is total: {:?}",
        res.failures()
    );
    assert!(logged(&res, "\"contradicted\":true"));
    assert_eq!(c.state(cid).await?, "Confirmed");
    let (completed, outstanding, frozen) = c.inv().await?;
    assert_eq!((completed, outstanding, frozen), (EVM_VALUE, big, true));
    let inv = c.view("invariant", json!({ "task_id": TASK })).await?;
    assert_eq!(
        inv["holds"], false,
        "(I) is breached, and only because the task is frozen"
    );
    // the lane neither re-held nor re-advanced for the contradicted nonce
    assert_eq!(c.lane().await?["in_flight"], json!(cid2));
    assert_eq!(
        c.lane().await?["next_nonce"],
        (SEED_NONCE + 1).to_string() + ""
    );

    // a replay of the contradicting report is a silent no-op
    let again = c
        .attest(&c.relayer, cid, &orig_hash, true, "Finalized")
        .await?;
    assert!(again.is_success() && !logged(&again, "external_attested"));
    assert_eq!(c.inv().await?, (EVM_VALUE, big, true));
    // frozen: new proposals are refused, but the in-flight payment still attests and settles
    refused(c.propose(EVM_VALUE, "frozen", 300).await?, MSG_TASK_FROZEN);
    let h2 = c.signed_tx(cid2).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let res = c.attest(&c.relayer, cid2, &h2, true, "Finalized").await?;
    assert!(
        res.is_success(),
        "a frozen task still attests: {:?}",
        res.failures()
    );
    assert_eq!(c.state(cid2).await?, "Confirmed");
    assert_eq!(c.inv().await?, (EVM_VALUE + big, 0, true));
    Ok(())
}

// ---- (e) trust boundary ---------------------------------------------------------------------------

#[tokio::test]
async fn the_trust_boundary_refuses_wrong_hashes_strangers_replays_and_unsafe_shortcuts(
) -> anyhow::Result<()> {
    let c = fresh("evm/trust", Stage::Seeded).await?;
    let (cid, _) = c.propose_ok(EVM_VALUE, "t-1").await?;
    let hash = c.signed_tx(cid).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let stranger = c.worker.dev_create_account().await?;
    let wrong = format!("0x{}", "11".repeat(32));

    // who may attest
    for who in [&c.delegate, &stranger] {
        refused(
            c.attest(who, cid, &hash, true, "Finalized").await?,
            MSG_ONLY_OWNER_OR_RELAYER,
        );
    }
    // what may be attested: only hashes the contract signed, in a valid shape
    refused(
        c.attest(&c.relayer, cid, &wrong, true, "Finalized").await?,
        MSG_UNKNOWN_TX_HASH,
    );
    refused(
        c.attest(&c.relayer, cid, "0xzz", true, "Finalized").await?,
        MSG_INVALID_TX_HASH,
    );
    refused(
        c.call(
            &c.relayer,
            "attest_external",
            json!({ "commitment_id": 99, "tx_hash": hash,
            "outcome": { "Landed": { "success": true, "finality": "Finalized", "block_number": "1",
            "block_hash": format!("0x{}", "ab".repeat(32)), "signature": null } } }),
        )
        .await?,
        MSG_NO_SUCH_COMMITMENT,
    );
    // Safe is not final: recorded as an event, no state change
    let safe = c.attest(&c.relayer, cid, &hash, true, "Safe").await?;
    assert!(safe.is_success());
    assert_eq!(c.state(cid).await?, "Signed");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    // reconcile is refused for an EVM commitment, whatever the owner claims
    for confirmed in [true, false] {
        refused(
            c.call(
                &c.owner,
                "reconcile",
                json!({ "commitment_id": cid, "confirmed": confirmed }),
            )
            .await?,
            MSG_RECONCILE_EVM,
        );
    }
    // the relayer is pinned while a commitment is in flight, and may never be the owner
    refused(
        c.call(&c.owner, "set_relayer", json!({ "relayer": stranger.id() }))
            .await?,
        MSG_RELAYER_BUSY,
    );
    refused(
        c.call(&c.owner, "set_relayer", json!({ "relayer": c.owner.id() }))
            .await?,
        MSG_RELAYER_IS_OWNER,
    );
    // a lane in flight cannot be re-seeded
    refused(
        c.call(
            &c.owner,
            "seed_evm_nonce",
            json!({ "path": c.path, "nonce": "50" }),
        )
        .await?,
        MSG_EVM_NONCE_REFUSED,
    );
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));

    // settle, then replays: the same report is idempotent; a contradicting revert changes no value
    assert!(c
        .attest(&c.relayer, cid, &hash, true, "Finalized")
        .await?
        .is_success());
    assert_eq!(c.inv().await?, (EVM_VALUE, 0, false));
    let replay = c.attest(&c.relayer, cid, &hash, true, "Finalized").await?;
    assert!(replay.is_success() && !logged(&replay, "external_attested"));
    let revert = c.attest(&c.relayer, cid, &hash, false, "Finalized").await?;
    assert!(revert.is_success() && logged(&revert, "\"contradicted\":true"));
    assert_eq!(c.state(cid).await?, "Confirmed");
    assert_eq!(c.inv().await?, (EVM_VALUE, 0, false));

    // lowered / non-owner seeds are refused (a lowered nonce would reuse a burnt one)
    for (who, n) in [(&c.owner, "3"), (&c.owner, "7")] {
        refused(
            c.call(who, "seed_evm_nonce", json!({ "path": c.path, "nonce": n }))
                .await?,
            MSG_EVM_NONCE_REFUSED,
        );
    }
    refused(
        c.call(
            &c.relayer,
            "seed_evm_nonce",
            json!({ "path": c.path, "nonce": "50" }),
        )
        .await?,
        MSG_ONLY_OWNER,
    );
    // a raise on an empty lane is fine
    assert!(c
        .call(
            &c.owner,
            "seed_evm_nonce",
            json!({ "path": c.path, "nonce": "20" })
        )
        .await?
        .is_success());
    assert_eq!(c.lane().await?["next_nonce"], "20");

    // kind/cross-commitment mismatch: another commitment's hash names nothing here
    let (cid2, _) = c.propose_ok(EVM_VALUE, "t-2").await?;
    refused(
        c.attest(&c.relayer, cid2, &hash, true, "Finalized").await?,
        MSG_UNKNOWN_TX_HASH,
    );
    assert_eq!(c.state(cid2).await?, "Signed");
    assert_eq!(c.inv().await?, (EVM_VALUE, EVM_VALUE, false));
    Ok(())
}

// ---- (f) mock signer modes -----------------------------------------------------------------------

#[tokio::test]
async fn a_bad_signer_answer_is_unknown_never_failed_and_a_lost_signature_is_recovered_only_when_it_verifies(
) -> anyhow::Result<()> {
    for mode in ["Err", "WrongKey", "Garbled", "GarbledShort"] {
        let c = fresh(&format!("evm/mode-{mode}"), Stage::Seeded).await?;
        c.set_mode(mode).await?;
        let (cid, res) = c.propose_ok(EVM_VALUE, "m-1").await?;
        assert!(logged(&res, "\"event\":\"payment_unknown\""), "{mode}");
        assert!(!logged(&res, "payment_failed"), "{mode}");
        assert_eq!(c.state(cid).await?, "Unknown", "{mode}");
        assert_eq!(
            c.inv().await?,
            (0, EVM_VALUE, false),
            "{mode}: the reservation is held, not released"
        );
        assert_eq!(c.lane().await?["in_flight"], json!(cid), "{mode}");
        let v = c.signed_tx(cid).await?;
        assert!(
            v["original"]["raw_tx"].is_null(),
            "{mode}: nothing unverified is served"
        );
        // idempotency committed to the cid, so a retry cannot double-reserve
        let again = c.propose(EVM_VALUE, "m-1", 300).await?;
        assert_eq!(again.json::<u64>()?, cid, "{mode}");
        assert_eq!(c.inv().await?, (0, EVM_VALUE, false), "{mode}");
        // a blind mark_unknown before the age is refused (the commitment is already Unknown: a no-op, not an error)
        let again = c
            .call(&c.relayer, "mark_unknown", json!({ "commitment_id": cid }))
            .await?;
        assert!(again.is_success() && !again.json::<bool>()?, "{mode}");
        assert_eq!(c.inv().await?, (0, EVM_VALUE, false), "{mode}");
    }
    Ok(())
}

#[tokio::test]
async fn a_lost_signature_is_recovered_only_when_it_verifies() -> anyhow::Result<()> {
    let c = fresh("evm/lost", Stage::Seeded).await?;
    c.set_mode("Err").await?; // the signer "timed out": the callback saw Err, a signature may still be public
    let (cid, _) = c.propose_ok(EVM_VALUE, "lost-1").await?;
    assert_eq!(c.state(cid).await?, "Unknown");
    let v = c.signed_tx(cid).await?;
    let tx = expect_original(&v, EVM_VALUE, SEED_NONCE);
    let sighash = tx.sighash();
    assert_eq!(
        v["original"]["sighash"].as_str().unwrap(),
        format!("0x{}", hex(&sighash))
    );

    let attest_sig = |hash: &[u8; 32], (r, s, y): ([u8; 32], [u8; 32], u8)| {
        json!({ "commitment_id": cid, "tx_hash": format!("0x{}", hex(hash)), "outcome": { "Landed": {
            "success": true, "finality": "Finalized", "block_number": "5",
            "block_hash": format!("0x{}", "ab".repeat(32)),
            "signature": { "r": hex(&r), "s": hex(&s), "y_parity": y } } } })
    };
    // a signature from another path recovers to the wrong key: refused
    let (r, s, y) = mock_sign(c.purser.id().as_str(), "evm/some-other-path", &sighash);
    let bad_hash = keccak(&tx.signed_raw(&r, &s, y));
    refused(
        c.call(
            &c.relayer,
            "attest_external",
            attest_sig(&bad_hash, (r, s, y)),
        )
        .await?,
        MSG_UNKNOWN_TX_HASH,
    );
    // the right signature with a hash it does not produce: refused
    let good = mock_sign(c.purser.id().as_str(), &c.path, &sighash);
    refused(
        c.call(&c.relayer, "attest_external", attest_sig(&[0x22; 32], good))
            .await?,
        MSG_UNKNOWN_TX_HASH,
    );
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    // the right signature and its true hash: recorded, verified, and the landing settles
    let hash = keccak(&tx.signed_raw(&good.0, &good.1, good.2));
    let res = c
        .call(&c.relayer, "attest_external", attest_sig(&hash, good))
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(c.state(cid).await?, "Confirmed");
    assert_eq!(c.inv().await?, (EVM_VALUE, 0, false));
    let v = c.signed_tx(cid).await?;
    assert_eq!(
        verify_tx(&v["original"], &tx, v["from"].as_str().unwrap()),
        format!("0x{}", hex(&hash))
    );
    Ok(())
}

// ---- (g) a reverted landing does not settle value -------------------------------------------------

#[tokio::test]
async fn a_reverted_landing_moves_no_value_and_releases_only_through_the_owner(
) -> anyhow::Result<()> {
    let c = fresh("evm/revert", Stage::Seeded).await?;
    let (cid, _) = c.propose_ok(EVM_VALUE, "rv-1").await?;
    let hash = c.signed_tx(cid).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();
    // Safe + reverted changes nothing
    assert!(c
        .attest(&c.relayer, cid, &hash, false, "Safe")
        .await?
        .is_success());
    assert_eq!(c.state(cid).await?, "Signed");
    // Finalized + reverted: the nonce burned and no value moved, so NOT Confirmed and NOT released
    let res = c.attest(&c.relayer, cid, &hash, false, "Finalized").await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(c.state(cid).await?, "Unknown");
    assert_eq!(c.signed_tx(cid).await?["evidence"], "original_reverted");
    assert_eq!(
        c.inv().await?,
        (0, EVM_VALUE, false),
        "no completed spend, and still reserved"
    );
    assert_eq!(c.lane().await?["in_flight"], json!(cid));
    refused(
        c.call(
            &c.relayer,
            "confirm_release",
            json!({ "commitment_id": cid }),
        )
        .await?,
        MSG_ONLY_OWNER,
    );
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    let res = c
        .call(&c.owner, "confirm_release", json!({ "commitment_id": cid }))
        .await?;
    assert!(res.is_success());
    assert_eq!(c.state(cid).await?, "Cancelled");
    assert_eq!(c.inv().await?, (0, 0, false));
    assert_eq!(c.lane().await?["next_nonce"], (SEED_NONCE + 1).to_string());
    Ok(())
}

// ---- (h) preflight refusals reserve nothing -------------------------------------------------------

#[tokio::test]
async fn every_preflight_refusal_happens_before_any_reservation() -> anyhow::Result<()> {
    let c = fresh("evm/preflight", Stage::Bare).await?;
    refused(
        c.propose(EVM_VALUE, "p-1", 300).await?,
        MSG_EVM_KEY_NOT_CACHED,
    );
    assert_eq!(c.inv().await?, (0, 0, false));
    let _ = c.cache_key().await?;
    refused(
        c.propose(EVM_VALUE, "p-1", 300).await?,
        MSG_EVM_LANE_UNSEEDED,
    );
    assert_eq!(c.inv().await?, (0, 0, false));
    assert!(c
        .call(
            &c.owner,
            "seed_evm_nonce",
            json!({ "path": c.path, "nonce": SEED_NONCE.to_string() })
        )
        .await?
        .is_success());
    // too little prepaid gas for the sign + callback chain
    assert!(60 < EVM_MIN_PREPAID.as_tgas());
    refused(c.propose(EVM_VALUE, "p-1", 60).await?, MSG_EVM_LOW_GAS);
    assert_eq!(c.inv().await?, (0, 0, false));
    // the validator refuses before a digest exists: below min_value, wrong chain, wrong chain family
    refused(c.propose(1, "p-1", 300).await?, MSG_EVM_VALUE_TOO_LOW);
    let mut intent = c.intent(EVM_VALUE);
    intent["chain"] = json!({ "Evm": { "chain_id": 1 } });
    for bad in [intent, {
        let mut i = c.intent(EVM_VALUE);
        i["chain"] = json!("NearNative");
        i
    }] {
        let res = c
            .delegate
            .call(c.purser.id(), "propose_payment")
            .args_json(json!({ "task": TASK, "request_id": "p-1", "intent": bad }))
            .max_gas()
            .transact()
            .await?;
        refused(res, MSG_UNSUPPORTED_CHAIN);
    }
    assert_eq!(c.inv().await?, (0, 0, false));
    let listed = c
        .view(
            "list_commitments",
            json!({ "task_id": TASK, "from_index": 0, "limit": 10 }),
        )
        .await?;
    assert!(
        listed.as_array().unwrap().is_empty(),
        "no commitment was created"
    );
    assert!(c.lane().await?["in_flight"].is_null());
    // no cid was burnt and the request id is still fresh: the first real proposal is cid 0
    let (cid, _) = c.propose_ok(EVM_VALUE, "p-1").await?;
    assert_eq!(cid, 0);
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    Ok(())
}

// ---- gas: measured at receipt level, and the budgets are enforced ---------------------------------

use near_workspaces::result::ExecutionOutcome;

/// `gas_burnt` of the one receipt matching `pick` (never by position: a marker log, an executor, or a
/// parent/child link). Zero or several matches fail the test, so a drifted marker cannot pass vacuously.
fn burnt(res: &ExecutionFinalResult, what: &str, pick: impl Fn(&ExecutionOutcome) -> bool) -> u64 {
    let hits: Vec<_> = res.receipt_outcomes().iter().filter(|o| pick(o)).collect();
    assert_eq!(
        hits.len(),
        1,
        "{what}: expected exactly one matching receipt, got {}",
        hits.len()
    );
    hits[0].gas_burnt.as_gas()
}

fn has_log(o: &ExecutionOutcome, event: &str) -> bool {
    o.logs
        .iter()
        .any(|l| l.contains(&format!("\"event\":\"{event}\"")))
}

#[tokio::test]
async fn the_gas_budgets_hold_with_headroom_and_are_measured() -> anyhow::Result<()> {
    let tg = |g: u64| g as f64 / 1e12;
    // A: the happy flow
    let a = fresh("evm/gas-a", Stage::Seeded).await?;
    let (cid, propose) = a.propose_ok(EVM_VALUE, "g-1").await?;
    let signer = a.signer.id().clone();
    let purser = a.purser.id().clone();
    let propose_sync = burnt(&propose, "propose", |o| {
        o.executor_id == purser && has_log(o, "payment_reserved")
    });
    let sign = burnt(&propose, "sign", |o| o.executor_id == signer);
    let on_signed = burnt(&propose, "on_signed", |o| has_log(o, "payment_signed"));
    let hash = a.signed_tx(cid).await?["original"]["tx_hash"]
        .as_str()
        .unwrap()
        .to_string();
    let attest_res = a.attest(&a.relayer, cid, &hash, true, "Finalized").await?;
    assert!(attest_res.is_success());
    let attest = burnt(&attest_res, "attest_external", |o| {
        has_log(o, "external_attested")
    });
    assert_eq!(a.inv().await?, (EVM_VALUE, 0, false));

    // B: Err -> Unknown, then a cancel that signs
    let b = fresh("evm/gas-b", Stage::Seeded).await?;
    b.set_mode("Err").await?;
    let (cid_b, propose_err) = b.propose_ok(EVM_VALUE, "g-2").await?;
    let on_signed_err = burnt(&propose_err, "on_signed(Err)", |o| {
        has_log(o, "payment_unknown")
    });
    b.set_mode("Ok").await?;
    raise_ceilings(&b).await?;
    let cancel_res = b
        .call(&b.relayer, "request_cancel", json!({
            "commitment_id": cid_b, "max_fee": (MAX_FEE * 3 / 2).to_string(), "tip": (MAX_TIP * 3 / 2).to_string(),
        }))
        .await?;
    assert!(cancel_res.is_success(), "{:?}", cancel_res.failures());
    let cancel_sign_id = cancel_res
        .receipt_outcomes()
        .iter()
        .find(|o| o.executor_id == b.signer.id().clone())
        .expect("the cancel's sign receipt")
        .transaction_hash;
    let b_purser = b.purser.id().clone();
    let request_cancel = burnt(&cancel_res, "request_cancel", |o| {
        o.executor_id == b_purser && o.receipt_ids.contains(&cancel_sign_id)
    });
    let cancel_sign = burnt(&cancel_res, "cancel sign", |o| {
        o.executor_id == *b.signer.id()
    });
    let on_cancel_signed = burnt(&cancel_res, "on_cancel_signed", |o| {
        has_log(o, "cancel_signed")
    });
    assert_eq!(b.inv().await?, (0, EVM_VALUE, false));

    let rows = [
        ("propose_payment (EVM arm, sync part)", propose_sync),
        ("mock signer sign (synchronous mock)", sign),
        ("on_signed (Ok, ecrecover + store)", on_signed),
        ("on_signed (Err -> Unknown)", on_signed_err),
        ("request_cancel (sync part)", request_cancel),
        ("mock signer sign (cancel)", cancel_sign),
        ("on_cancel_signed (Ok)", on_cancel_signed),
        ("attest_external (Original, success, Finalized)", attest),
    ];
    println!("\n== EVM receipt-level gas_burnt (sandbox, mock signer) ==");
    for (name, g) in rows {
        println!("{name:<50} {:>9.3} Tgas", tg(g));
    }
    println!(
        "constants: SIGN_GAS {} | ON_SIGNED_GAS {} | EVM_MIN_PREPAID {} Tgas",
        SIGN_GAS.as_tgas(),
        ON_SIGNED_GAS.as_tgas(),
        EVM_MIN_PREPAID.as_tgas()
    );

    // The callbacks must fit their static budgets with >= 2x headroom (a real, heavier state or a repriced
    // host function must not tip an on_signed into a gas failure after the signer already answered).
    for (name, g) in [
        ("on_signed", on_signed.max(on_signed_err)),
        ("on_cancel_signed", on_cancel_signed),
    ] {
        assert!(
            g * 2 <= ON_SIGNED_GAS.as_gas(),
            "{name} burnt {} Tgas: under 2x headroom to ON_SIGNED_GAS {} Tgas",
            tg(g),
            ON_SIGNED_GAS.as_tgas()
        );
    }
    // A proposal that arrives with exactly the minimum prepaid gas can fund its own execution plus both
    // attached budgets, with 2x headroom on the synchronous part.
    assert!(
        propose_sync * 2 + SIGN_GAS.as_gas() + ON_SIGNED_GAS.as_gas() <= EVM_MIN_PREPAID.as_gas(),
        "EVM_MIN_PREPAID cannot fund propose + SIGN_GAS + ON_SIGNED_GAS"
    );
    assert!(
        request_cancel * 2 + SIGN_GAS.as_gas() + ON_SIGNED_GAS.as_gas() <= EVM_MIN_PREPAID.as_gas()
    );
    // The real signer yields and reserves 7 + 2 Tgas of the 15 Tgas minimum itself, so SIGN_GAS must leave
    // room above that floor for its own execution (the mock under-measures its cost).
    assert!(
        SIGN_GAS.as_tgas() >= 2 * 15 && ON_SIGNED_GAS.as_gas() > on_signed.max(on_cancel_signed)
    );
    Ok(())
}
