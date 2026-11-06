//! S8 (TRD §10): a registered delegate cannot grow the contract's state without bound.
//!
//! Commitments and their idempotency entries are never pruned, so the only real bound is a count
//! of commitments ever created per task. These tests run against the production wasm on a
//! near-workspaces sandbox and assert the refusal strings the entrypoints share with `error.rs`.

mod common;

use common::*;
use purser_contract::{
    MSG_BELOW_MIN_PAYMENT, MSG_COMMITMENT_LIMIT, MSG_NO_SUCH_TASK, MSG_ONLY_OWNER,
};
use serde_json::json;

async fn one_delegate_crew(cap_units: u128) -> anyhow::Result<(Crew, near_workspaces::Account)> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let delegate = w.dev_create_account().await?;
    let crew = setup(w, prod_wasm().await, owner, cap_units, &[delegate.id()]).await?;
    Ok((crew, delegate))
}

async fn set_limits(crew: &Crew, min_payment: &str, max: u32) -> anyhow::Result<()> {
    crew.owner
        .call(crew.purser.id(), "set_task_limits")
        .args_json(json!({ "task_id": TASK, "min_payment": min_payment, "max_commitments": max }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn remaining(crew: &Crew) -> anyhow::Result<u128> {
    let v = view(crew, "remaining_budget", json!({ "task_id": TASK })).await?;
    Ok(v.as_str().unwrap().parse()?)
}

async fn limits(crew: &Crew) -> anyhow::Result<serde_json::Value> {
    view(crew, "get_task_limits", json!({ "task_id": TASK })).await
}

/// A task the owner never configured reports the defaults: no minimum and the default cap.
#[tokio::test]
async fn unconfigured_task_reports_the_default_limits() -> anyhow::Result<()> {
    let (crew, _) = one_delegate_crew(100).await?;
    let l = limits(&crew).await?;
    assert_eq!(l["min_payment"], "0");
    assert_eq!(
        l["max_commitments"],
        purser_contract::DEFAULT_MAX_COMMITMENTS
    );
    assert_eq!(l["created_count"], 0);
    let unknown = view(&crew, "get_task_limits", json!({ "task_id": "nope" })).await?;
    assert!(unknown.is_null(), "an unknown task has no limits");
    Ok(())
}

/// Exactly the minimum is admitted; one yocto below is refused with nothing persisted.
#[tokio::test]
async fn payment_below_the_minimum_is_refused_and_exactly_at_it_passes() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    set_limits(&crew, &units(2), 10).await?;

    let low = crew
        .purser
        .view("get_task_limits")
        .args_json(json!({ "task_id": TASK }))
        .await?;
    assert!(low.json::<serde_json::Value>()?["min_payment"] == units(2).as_str());

    let refused = propose(&delegate, &crew, 1, "below").await?;
    assert!(err_string(refused).contains(MSG_BELOW_MIN_PAYMENT));
    assert_eq!(
        limits(&crew).await?["created_count"],
        0,
        "refusal persists nothing"
    );
    assert_eq!(accounting(&crew).await?, (0, 0));

    let ok = propose(&delegate, &crew, 2, "at-min").await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    assert_eq!(limits(&crew).await?["created_count"], 1);
    Ok(())
}

/// The (cap+1)th proposal is refused even though the budget has plenty left.
#[tokio::test]
async fn commitment_limit_refuses_the_next_proposal() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    set_limits(&crew, "0", 3).await?;
    for i in 0..3 {
        let res = propose(&delegate, &crew, 1, &format!("r-{i}")).await?;
        assert!(res.is_success(), "{:?}", res.failures());
    }
    let refused = propose(&delegate, &crew, 1, "r-3").await?;
    assert!(err_string(refused).contains(MSG_COMMITMENT_LIMIT));
    assert_eq!(limits(&crew).await?["created_count"], 3);
    assert_eq!(accounting(&crew).await?, (3 * UNIT, 0));
    assert_eq!(
        remaining(&crew).await?,
        97 * UNIT,
        "refusal reserved nothing"
    );
    Ok(())
}

/// The loop S8 is about: payments whose transfer FAILS release their budget but leave their
/// commitment behind, so the count must not decrement or the delegate grows state for free.
#[tokio::test]
async fn failing_transfers_still_consume_the_commitment_limit() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    let ghost: near_workspaces::AccountId = format!("ghost.{}", crew.owner.id())
        .parse()
        .expect("valid account id");
    crew.owner
        .call(crew.purser.id(), "set_recipient_allowlist")
        .args_json(json!({ "task_id": TASK, "recipients": [ghost] }))
        .transact()
        .await?
        .into_result()?;
    set_limits(&crew, "0", 2).await?;

    for i in 0..2 {
        let res = delegate
            .call(crew.purser.id(), "propose_payment")
            .args_json(propose_args(&ghost, 1, &format!("ghost-{i}")))
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_success(), "{:?}", res.failures());
    }
    // Both transfers failed and released their budget...
    assert_eq!(accounting(&crew).await?, (0, 0));
    assert_eq!(remaining(&crew).await?, 100 * UNIT);
    // ...yet the third is refused: the count of commitments ever created did not move back.
    let refused = delegate
        .call(crew.purser.id(), "propose_payment")
        .args_json(propose_args(&ghost, 1, "ghost-2"))
        .max_gas()
        .transact()
        .await?;
    assert!(err_string(refused).contains(MSG_COMMITMENT_LIMIT));
    assert_eq!(limits(&crew).await?["created_count"], 2);
    Ok(())
}

/// `propose_payment` is not payable: an attached deposit is rejected by the runtime and nothing is reserved.
#[tokio::test]
async fn attached_deposit_is_rejected() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    let res = propose_tx(&delegate, &crew, 1, "paid")
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(err_string(res).contains("doesn't accept deposit"));
    assert_eq!(limits(&crew).await?["created_count"], 0);
    assert_eq!(accounting(&crew).await?, (0, 0));
    Ok(())
}

/// `set_task_limits` is owner-only and needs an existing task.
#[tokio::test]
async fn set_task_limits_is_owner_only_and_needs_a_task() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    let by_delegate = delegate
        .call(crew.purser.id(), "set_task_limits")
        .args_json(json!({ "task_id": TASK, "min_payment": "0", "max_commitments": 5 }))
        .transact()
        .await?;
    assert!(err_string(by_delegate).contains(MSG_ONLY_OWNER));

    let unknown = crew
        .owner
        .call(crew.purser.id(), "set_task_limits")
        .args_json(json!({ "task_id": "nope", "min_payment": "0", "max_commitments": 5 }))
        .transact()
        .await?;
    assert!(err_string(unknown).contains(MSG_NO_SUCH_TASK));
    assert_eq!(
        limits(&crew).await?["max_commitments"],
        purser_contract::DEFAULT_MAX_COMMITMENTS
    );
    Ok(())
}

/// Lowering the cap below what exists stops new admissions and never touches history; raising it resumes.
#[tokio::test]
async fn lowering_then_raising_the_limit_only_gates_new_admissions() -> anyhow::Result<()> {
    let (crew, delegate) = one_delegate_crew(100).await?;
    for i in 0..2 {
        assert!(propose(&delegate, &crew, 1, &format!("a-{i}"))
            .await?
            .is_success());
    }
    set_limits(&crew, "0", 1).await?; // already 2 created
    let refused = propose(&delegate, &crew, 1, "a-2").await?;
    assert!(err_string(refused).contains(MSG_COMMITMENT_LIMIT));
    assert_eq!(
        limits(&crew).await?["created_count"],
        2,
        "history untouched"
    );
    set_limits(&crew, "0", 10).await?;
    assert!(propose(&delegate, &crew, 1, "a-2").await?.is_success());
    assert_eq!(limits(&crew).await?["created_count"], 3);
    Ok(())
}
