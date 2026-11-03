//! Integration tests for the Prompt-4 load-bearing NEAR-native payment flow: the
//! `propose_payment` reserve-before-sign path and its `on_near_settled` settlement callback,
//! exercised end-to-end on a `near-workspaces` sandbox.
//!
//! Scope is the Prompt-4 DONE-WHEN plus the fail-closed allowlist that was pulled forward:
//!   1. a legit payment succeeds, settles, and the accounting is correct (+ reports the tx hash
//!      and measured gas — the happy path is also the validator for the `#[callback_result]`
//!      empty-transfer-result deserialization);
//!   2. an over-budget payment is refused with "exceeds task budget" and the budget is unchanged;
//!   3. a non-allowlisted recipient is refused (deny-by-default).
//!
//! The genuinely-concurrent / in-flight-retry / replay / revoke / timeout attack suite is Prompt 6.
//! Refusals are asserted by substring against the canonical `purser_contract::MSG_*` constants.

use near_workspaces::network::Sandbox;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;
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
        res.logs().iter().any(|l| l.contains("payment_reserved")),
        "missing payment_reserved event; logs: {:?}",
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

/// Fail-closed recipient confinement: a within-budget payment to a non-allowlisted account is
/// refused (deny-by-default), and the budget is untouched.
#[tokio::test]
async fn non_allowlisted_recipient_refused() -> anyhow::Result<()> {
    let (w, c, _owner, delegate, _recipient) = setup().await?;
    let outsider = w.dev_create_account().await?; // never allowlisted

    let res = propose(&delegate, &c, &outsider, "100", "r3").await?;
    assert!(res.is_failure());
    assert!(err_string(res).contains(purser_contract::MSG_RECIPIENT_NOT_ALLOWED));

    let task = view_json(&c, "get_task", json!({ "task_id": "t1" })).await?;
    assert_eq!(
        task["outstanding"], "0",
        "refused-before-reserve must not touch the budget"
    );
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
