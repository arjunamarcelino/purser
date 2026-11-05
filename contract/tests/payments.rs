//! Integration tests for the Prompt-4 load-bearing NEAR-native payment flow: the
//! `propose_payment` reserve-before-sign path and its `on_near_settled` settlement callback,
//! exercised end-to-end on a `near-workspaces` sandbox.
//!
//! Scope is the Prompt-4 DONE-WHEN plus the "sign only what you can read" payload work:
//!   1. a legit payment succeeds, settles, and the accounting is correct (+ reports the tx hash
//!      and measured gas — the happy path is also the validator for the `#[callback_result]`
//!      empty-transfer-result deserialization);
//!   2. an over-budget payment is refused with "exceeds task budget" and the budget is unchanged;
//!   3. the recorded `payload_hash` is independently re-derivable off-chain (tamper-evidence);
//!   4. pre-reserve refusals leave the budget untouched + burn no cid: swapped/non-allowlisted
//!      recipient (deny-by-default), zero amount, wrong token.
//!
//! The genuinely-concurrent / in-flight-retry / replay / revoke / timeout attack suite is Prompt 6.
//! Refusals are asserted by substring against the canonical `purser_contract::MSG_*` constants.

use near_workspaces::network::Sandbox;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

// Compile the contract to wasm exactly once, shared across all tests in this binary.
static WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn wasm() -> &'static Vec<u8> {
    WASM.get_or_init(|| async {
        near_workspaces::compile_project(".")
            .await
            .expect("compile contract to wasm")
    })
    .await
}

/// Fresh sandbox with: a deployed+initialized contract, an `owner`, a registered+active
/// `delegate`, and an allowlisted `recipient`. Task "t1" has cap 1_000_000 (yocto) and crew_cap 3.
async fn setup() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(wasm().await).await?;
    let owner = worker.dev_create_account().await?;
    let delegate = worker.dev_create_account().await?;
    let recipient = worker.dev_create_account().await?;

    contract
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer_id": "v1.signer-prod.testnet" }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(contract.id(), "create_task")
        .args_json(
            json!({ "task_id": "t1", "cap": "1000000", "token": "NearNative", "crew_cap": 3 }),
        )
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    owner
        .call(contract.id(), "add_delegate")
        .args_json(
            json!({ "task_id": "t1", "account_id": delegate.id(), "derivation_path": "m/44/0" }),
        )
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    owner
        .call(contract.id(), "set_recipient_allowlist")
        .args_json(json!({ "task_id": "t1", "recipients": [recipient.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    Ok((worker, contract, owner, delegate, recipient))
}

/// A delegate `propose_payment` call for the given amount/recipient/request_id (NEAR-native).
async fn propose(
    delegate: &Account,
    c: &Contract,
    recipient: &Account,
    amount: &str,
    request_id: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(delegate
        .call(c.id(), "propose_payment")
        .args_json(json!({
            "task": "t1",
            "request_id": request_id,
            "intent": {
                "chain": "NearNative",
                "recipient": recipient.id(),
                "amount": amount,
                "token": "NearNative",
                "memo": null,
            }
        }))
        .max_gas()
        .transact()
        .await?)
}

async fn view_json(
    c: &Contract,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

fn err_string(res: near_workspaces::result::ExecutionFinalResult) -> String {
    format!("{:?}", res.into_result().unwrap_err())
}

// ---- DONE-WHEN cases --------------------------------------------------------------

/// A single legit payment succeeds: it settles to Confirmed, remaining budget drops by the
/// amount, the accounting is correct, and a tx hash + measured gas are reported.
#[tokio::test]
async fn legit_payment_succeeds_and_accounts() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;

    let res = propose(&delegate, &c, &recipient, "400000", "r1").await?;
    assert!(
        res.is_success(),
        "propose_payment failed: {:?}",
        res.failures()
    );

    // DONE-WHEN: report the tx hash (off-chain observation — the contract can't read its own
    // receipt id) and the MEASURED gas (not the 10 Tgas callback estimate).
    println!("near_tx (off-chain) = {}", res.outcome().transaction_hash);
    println!(
        "total_gas_burnt     = {} Tgas",
        res.total_gas_burnt.as_tgas()
    );

    // lifecycle events emitted.
    assert!(
        res.logs()
            .iter()
            .any(|l| l.contains("payment_reserved") && l.contains("payload_hash")),
        "payment_reserved event must carry payload_hash; logs: {:?}",
        res.logs()
    );
    assert!(
        res.logs().iter().any(|l| l.contains("payment_confirmed")),
        "missing payment_confirmed event (did the callback settle?); logs: {:?}",
        res.logs()
    );

    // accounting: settled → completed == amount, outstanding == 0, remaining dropped by amount.
    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["completed"], "400000");
    assert_eq!(task["outstanding"], "0");
    let remaining = view_json(&c, "remaining_budget", json!({ "task_id": "t1" })).await?;
    assert_eq!(remaining, "600000");

    // commitment settled Confirmed; near_tx is None on-chain (filled off-chain by the indexer).
    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(cmt["state"], "Confirmed");
    assert_eq!(cmt["actual_spent"], "400000");
    assert_eq!(cmt["near_tx"], serde_json::Value::Null);

    // request status is readable without a panicking re-propose (agent-native).
    let idem = view_json(
        &c,
        "get_idempotency",
        json!({ "account_id": delegate.id(), "request_id": "r1" }),
    )
    .await?;
    assert_eq!(idem["Committed"]["commitment_id"], 0);

    Ok(())
}

/// A payment exceeding remaining budget is refused with "exceeds task budget", the budget is
/// byte-for-byte unchanged, and no commitment is created (the cid is not consumed).
#[tokio::test]
async fn over_budget_payment_refused_and_budget_unchanged() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;

    // remaining == cap == 1_000_000; one yocto over must be refused.
    let res = propose(&delegate, &c, &recipient, "1000001", "r2").await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_EXCEEDS_BUDGET));

    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["completed"], "0", "budget mutated on refused reserve");
    assert_eq!(
        task["outstanding"], "0",
        "budget mutated on refused reserve"
    );

    // no commitment burned, cid not consumed.
    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(
        cmt,
        serde_json::Value::Null,
        "a commitment was created on a refused reserve"
    );

    Ok(())
}

/// Fail-closed recipient confinement (APP-FLOW §8 Flow F — tampered/swapped recipient): a
/// within-budget payment to an account that is NOT on the allowlist is refused deny-by-default,
/// the budget is byte-for-byte untouched, and no commitment is created. This is the representative
/// "refused-before-reserve ⇒ budget unchanged + no cid burned" proof for all pre-reserve refusals.
#[tokio::test]
async fn swapped_recipient_is_rejected_and_budget_unchanged() -> anyhow::Result<()> {
    let (w, c, _owner, delegate, _recipient) = setup().await?;
    let outsider = w.dev_create_account().await?; // swapped-in; never allowlisted

    let res = propose(&delegate, &c, &outsider, "100", "r3").await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_RECIPIENT_NOT_ALLOWED));

    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(
        task["completed"], "0",
        "refused-before-reserve must not touch the budget"
    );
    assert_eq!(
        task["outstanding"], "0",
        "refused-before-reserve must not touch the budget"
    );
    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(
        cmt,
        serde_json::Value::Null,
        "a commitment/cid was burned on a refused reserve"
    );
    Ok(())
}

/// Independently re-derive the NEAR-native `payload_hash` from a given scheme (`domain`, `version`)
/// plus the documented borsh wire layout, hashing with the `sha2` crate directly. Deliberately uses
/// a SEPARATE implementation (the `sha2` crate + a hand-assembled preimage) rather than the
/// contract's own `env::sha256_array` / `canonical_payload_bytes`, so the oracle is genuinely
/// independent: a bug in the contract's byte-construction or hashing is caught here instead of being
/// reproduced by it.
///
/// INTENTIONAL DUPLICATE of the wire layout (not a shared helper) — the unit-test twin
/// `payload::tests::hand_assembled_body` re-implements the same layout on purpose, so each is an
/// *independent* oracle across crates; sharing a helper (or calling `canonical_payload_bytes`) would
/// couple it to the code under test. Keep the two in sync by hand if the canonical layout changes.
fn rederive_payload_hash(
    domain: &[u8],
    version: u16,
    task: &str,
    commitment_id: u64,
    recipient: &str,
    amount_yocto: u128,
) -> [u8; 32] {
    let mut preimage = domain.to_vec();
    preimage.extend_from_slice(&version.to_le_bytes()); // u16 LE
    preimage.extend_from_slice(&(task.len() as u32).to_le_bytes()); // String: u32 LE len
    preimage.extend_from_slice(task.as_bytes()); //         + UTF-8
    preimage.extend_from_slice(&commitment_id.to_le_bytes()); // u64 LE
    preimage.extend_from_slice(&(recipient.len() as u32).to_le_bytes()); // AccountId == String
    preimage.extend_from_slice(recipient.as_bytes());
    preimage.extend_from_slice(&amount_yocto.to_le_bytes()); // u128 LE
    Sha256::digest(&preimage).into()
}

/// Minimal hex decoder so the view-driven re-derivation test uses ZERO repo constants — exactly
/// what a non-Rust client has.
fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// "Sign only what you can read": a NON-Rust verifier re-derives `payload_hash` from on-chain reads
/// ALONE — the `payload_scheme()` view for the composition rule + the commitment for the inputs —
/// and confirms it byte-for-byte with an independent `sha2` oracle. Also covers: the anchor survives
/// the lifecycle (still correct at `Confirmed`), `payload_version` is recorded and matches the live
/// scheme, the hash/version pairing is both-present, and the stored RAW recipient re-derives
/// identically to the parsed form (AccountId parsing is normalization-free).
#[tokio::test]
async fn payload_hash_rederivable_from_scheme_view_alone() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;
    propose(&delegate, &c, &recipient, "400000", "r1")
        .await?
        .into_result()?; // settles to Confirmed as cid 0

    // Scheme fetched the way a TS/Python verifier would — from the deployed contract, not source.
    let scheme = view_json(&c, "payload_scheme", json!({})).await?;
    assert_eq!(scheme["chain"], "near-native");
    assert_eq!(scheme["hash_algorithm"], "sha256");
    assert_eq!(scheme["encoding"], "borsh");
    assert!(scheme["preimage"].as_str().unwrap().contains("borsh("));
    let domain = hex_decode(scheme["domain_hex"].as_str().unwrap());
    assert_eq!(domain.len(), 32, "domain must be the fixed 32-byte tag");
    let version = scheme["version"].as_u64().unwrap() as u16;

    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(cmt["state"], "Confirmed");
    assert_eq!(
        cmt["payload_version"].as_u64().unwrap() as u16,
        version,
        "commitment's recorded version must match the live scheme"
    );
    assert!(
        cmt["payload_hash"].is_array() && cmt["payload_version"].is_number(),
        "hash and version must be present together"
    );
    let got: [u8; 32] = serde_json::from_value(cmt["payload_hash"].clone())
        .expect("payload_hash must be a recorded 32-byte array, not null");

    // Independent oracle (sha2 crate + hand-assembled layout), scheme sourced ONLY from the view —
    // proving the view is sufficient for a source-free client.
    let rcpt = recipient.id().as_str();
    assert_eq!(
        got,
        rederive_payload_hash(&domain, version, "t1", 0, rcpt, 400_000),
        "scheme view is insufficient to re-derive the on-chain payload_hash (tamper-evidence broken)"
    );

    // raw == parsed: the stored raw intent.recipient re-derives to the same hash.
    let stored_raw = cmt["intent"]["recipient"].as_str().unwrap();
    assert_eq!(stored_raw, rcpt);
    assert_eq!(
        rederive_payload_hash(&domain, version, "t1", 0, stored_raw, 400_000),
        got
    );
    Ok(())
}

/// Zero amount is refused pre-reserve; the budget is untouched and no commitment is burned.
/// (`NearToken` is `u128` — a "negative" amount is unrepresentable at the type level; zero is the
/// boundary the contract must reject.)
#[tokio::test]
async fn zero_amount_rejected_and_budget_unchanged() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;
    let res = propose(&delegate, &c, &recipient, "0", "r4").await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_ZERO_AMOUNT));
    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["outstanding"], "0");
    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(cmt, serde_json::Value::Null);
    Ok(())
}

/// A wrong-token intent (NEP-141 on a NearNative task) is refused pre-reserve; budget untouched.
#[tokio::test]
async fn wrong_token_intent_rejected() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;
    let res = delegate
        .call(c.id(), "propose_payment")
        .args_json(json!({
            "task": "t1",
            "request_id": "r5",
            "intent": {
                "chain": "NearNative",
                "recipient": recipient.id(),
                "amount": "100",
                "token": { "Nep141": { "contract": "usdc.testnet" } },
                "memo": null,
            }
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_UNSUPPORTED_TOKEN));
    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["outstanding"], "0");
    Ok(())
}

/// A retry must replay the SAME request: an identical retry returns the prior cid with no second
/// transfer, but reusing a settled `request_id` for a different intent is refused instead of
/// reporting the earlier payment as this one's success.
#[tokio::test]
async fn replay_with_a_different_intent_is_refused() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;
    let first = propose(&delegate, &c, &recipient, "400000", "r1").await?;
    assert!(first.is_success(), "{:?}", first.failures());
    let cid: u64 = first.json()?;
    let before = recipient.view_account().await?.balance;

    let other = propose(&delegate, &c, &recipient, "300000", "r1").await?;
    assert!(err_string(other).contains(purser_contract::MSG_REQUEST_ID_REUSED));

    let same = propose(&delegate, &c, &recipient, "400000", "r1").await?;
    assert!(same.is_success(), "{:?}", same.failures());
    assert_eq!(same.json::<u64>()?, cid);
    assert_eq!(recipient.view_account().await?.balance, before);
    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["completed"], "400000");
    assert_eq!(task["outstanding"], "0");
    Ok(())
}

/// Honest revocation of a payee: after the owner removes a previously-allowlisted recipient, a
/// payment to it is refused deny-by-default, the budget is untouched, and no commitment is burned.
#[tokio::test]
async fn removed_recipient_can_no_longer_be_paid() -> anyhow::Result<()> {
    let (_w, c, owner, delegate, recipient) = setup().await?; // recipient allowlisted in setup
    owner
        .call(c.id(), "remove_recipient_allowlist")
        .args_json(json!({ "task_id": "t1", "recipients": [recipient.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let res = propose(&delegate, &c, &recipient, "100", "r6").await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_RECIPIENT_NOT_ALLOWED));
    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(task["outstanding"], "0");
    let cmt = view_json(&c, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(cmt, serde_json::Value::Null);
    Ok(())
}

/// Only the owner may remove allowlist entries; a delegate's attempt is refused and the recipient
/// stays payable (the removal did not take effect).
#[tokio::test]
async fn remove_recipient_allowlist_rejects_non_owner() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, recipient) = setup().await?;
    let res = delegate
        .call(c.id(), "remove_recipient_allowlist")
        .args_json(json!({ "task_id": "t1", "recipients": [recipient.id()] }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_ONLY_OWNER));
    // removal did not happen → recipient still payable.
    assert!(propose(&delegate, &c, &recipient, "100", "r7")
        .await?
        .is_success());
    Ok(())
}

/// The `is_recipient_allowed` view mirrors the deny-by-default gate: true for an allowlisted payee,
/// false for an outsider, and false again after the owner removes it (read-parity, non-destructive).
#[tokio::test]
async fn is_recipient_allowed_mirrors_the_gate() -> anyhow::Result<()> {
    let (w, c, owner, _delegate, recipient) = setup().await?; // recipient allowlisted in setup
    let outsider = w.dev_create_account().await?;

    let allowed = view_json(
        &c,
        "is_recipient_allowed",
        json!({ "task_id": "t1", "account_id": recipient.id() }),
    )
    .await?;
    assert_eq!(allowed, serde_json::Value::Bool(true));
    let outsider_allowed = view_json(
        &c,
        "is_recipient_allowed",
        json!({ "task_id": "t1", "account_id": outsider.id() }),
    )
    .await?;
    assert_eq!(outsider_allowed, serde_json::Value::Bool(false));

    owner
        .call(c.id(), "remove_recipient_allowlist")
        .args_json(json!({ "task_id": "t1", "recipients": [recipient.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let after_removal = view_json(
        &c,
        "is_recipient_allowed",
        json!({ "task_id": "t1", "account_id": recipient.id() }),
    )
    .await?;
    assert_eq!(after_removal, serde_json::Value::Bool(false));
    Ok(())
}

// ---- owner reconcile (stuck-Reserved recovery) ------------------------------------
//
// These cover the owner-gate + state guards end-to-end. The happy force-confirm / force-release
// transitions reuse the budget-tested state machine (authorize+settle_confirmed / release_failed);
// a genuinely-stuck `Reserved` cannot be manufactured in-sandbox (the callback always runs when gas
// suffices, and attaching too little gas fails the whole call rather than only the callback), so the
// positive paths are proven at the unit level in `budget.rs`.

async fn reconcile(
    caller: &Account,
    c: &Contract,
    cid: u64,
    confirmed: bool,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(c.id(), "reconcile")
        .args_json(json!({ "commitment_id": cid, "confirmed": confirmed }))
        .max_gas()
        .transact()
        .await?)
}

/// `get_config` surfaces the reconcile time-lock and input limits so clients never hard-code them.
#[tokio::test]
async fn get_config_exposes_the_lock_and_limits() -> anyhow::Result<()> {
    let (_w, c, _owner, _delegate, _recipient) = setup().await?;
    let cfg = view_json(&c, "get_config", json!({})).await?;
    assert_eq!(
        cfg["reconcile_min_age_ns"],
        purser_contract::RECONCILE_MIN_AGE_NS.to_string()
    );
    assert_eq!(cfg["max_request_id_len"], 64);
    assert_eq!(cfg["max_memo_len"], 256);
    assert_eq!(cfg["max_task_id_len"], 64);
    Ok(())
}

/// Only the owner may reconcile (the owner gate fires before any lookup).
#[tokio::test]
async fn reconcile_rejects_non_owner() -> anyhow::Result<()> {
    let (_w, c, _owner, delegate, _recipient) = setup().await?;
    let res = reconcile(&delegate, &c, 0, true).await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_ONLY_OWNER));
    Ok(())
}

/// Reconciling an unknown commitment id is refused.
#[tokio::test]
async fn reconcile_rejects_unknown_commitment() -> anyhow::Result<()> {
    let (_w, c, owner, _delegate, _recipient) = setup().await?;
    let res = reconcile(&owner, &c, 999, true).await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_NO_SUCH_COMMITMENT));
    Ok(())
}

/// A commitment that already settled (Confirmed) is not reconcilable — only a stuck `Reserved` is.
#[tokio::test]
async fn reconcile_rejects_already_settled() -> anyhow::Result<()> {
    let (_w, c, owner, delegate, recipient) = setup().await?;
    propose(&delegate, &c, &recipient, "400000", "r1")
        .await?
        .into_result()?; // settles to Confirmed as cid 0
    let res = reconcile(&owner, &c, 0, true).await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_NOT_RECONCILABLE));
    Ok(())
}
