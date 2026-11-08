//! In-place upgrade check for the S8 change: the new wasm must read state written by the previous
//! release with NO migration (the per-task limits live in a separate map under an appended storage
//! prefix, never in a struct field).
//!
//! Needs the previous release's wasm, so it is `#[ignore]`d. Reproduce it with one command, which
//! builds the previous release (default: merge-base with origin/main) in a temporary git worktree
//! and runs this test against it (~5 min; CI runs it as the `upgrade-check` job):
//!
//! ```text
//! make upgrade-check            # or: scripts/upgrade-check.sh [GIT_REF]
//! ```
//!
//! Scope: history written before the limits existed is NOT counted toward `created_count`. A task
//! that predates them reads 0 after the upgrade and gets a fresh allowance beyond its existing
//! commitments; a previous release that already has them keeps its count (both asserted below, so
//! any git ref works as the previous release). By hand, with a wasm you built yourself:
//!
//! ```text
//! PURSER_WASM_PREV=/path/to/previous/purser_contract.wasm cargo test --test upgrade -- --ignored
//! ```

mod common;

use common::*;
use serde_json::json;

#[tokio::test]
#[ignore = "needs PURSER_WASM_PREV (the previous release's wasm)"]
async fn the_new_wasm_reads_state_written_by_the_previous_release() -> anyhow::Result<()> {
    let prev_path = std::env::var("PURSER_WASM_PREV")
        .expect("set PURSER_WASM_PREV to the previous release's purser_contract.wasm");
    let prev = std::fs::read(&prev_path)?;

    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let delegate = w.dev_create_account().await?;
    let crew = setup(w, &prev, owner, 100, &[delegate.id()]).await?;

    // State written by the OLD code: a task, a delegate, an allowlist, a confirmed commitment.
    let before = propose(&delegate, &crew, 10, "old-0").await?;
    assert!(before.is_success(), "{:?}", before.failures());
    let old_commitment = view(&crew, "get_commitment", json!({ "commitment_id": 0 })).await?;
    assert_eq!(old_commitment["state"], "Confirmed");

    // A release from before the limits has no `get_task_limits` view, so its history counts as 0.
    let created_before = view(&crew, "get_task_limits", json!({ "task_id": TASK }))
        .await
        .map_or(0, |l| l["created_count"].as_u64().unwrap());

    // Deploy the NEW wasm over the same account. No migration call.
    crew.purser
        .as_account()
        .deploy(prod_wasm().await)
        .await?
        .into_result()?;

    // Everything the old code wrote still reads, byte for byte.
    assert_eq!(
        view(&crew, "get_commitment", json!({ "commitment_id": 0 })).await?,
        old_commitment
    );
    assert_eq!(accounting(&crew).await?, (10 * UNIT, 0));
    assert_eq!(
        view(
            &crew,
            "is_delegate_authorized",
            json!({ "task_id": TASK, "account_id": delegate.id() })
        )
        .await?,
        json!(true)
    );

    // The limits read the defaults and the count carries over unchanged; history from before the
    // limits is NOT counted (documented limitation: old tasks get a fresh allowance).
    let limits = view(&crew, "get_task_limits", json!({ "task_id": TASK })).await?;
    assert_eq!(limits["created_count"], created_before);
    assert_eq!(
        limits["max_commitments"],
        purser_contract::DEFAULT_MAX_COMMITMENTS
    );

    // A replay of the old request still returns the old commitment (idempotency survived).
    let replay = propose(&delegate, &crew, 10, "old-0").await?;
    assert!(replay.is_success(), "{:?}", replay.failures());
    assert_eq!(accounting(&crew).await?, (10 * UNIT, 0), "no second spend");

    // New traffic works and takes the next commitment id.
    let fresh = propose(&delegate, &crew, 5, "new-1").await?;
    assert!(fresh.is_success(), "{:?}", fresh.failures());
    assert_eq!(
        view(&crew, "get_commitment", json!({ "commitment_id": 1 })).await?["state"],
        "Confirmed"
    );
    assert_eq!(accounting(&crew).await?, (15 * UNIT, 0));
    assert_eq!(
        view(&crew, "get_task_limits", json!({ "task_id": TASK })).await?["created_count"],
        created_before + 1
    );
    Ok(())
}
