//! Integration tests for the Prompt-3 control plane: task creation, the delegate
//! (crew) registry, owner access control, crew-cap enforcement, and honest revocation.
//!
//! These exercise the real `#[near]` entrypoints end-to-end on a `near-workspaces`
//! sandbox (the pure core is covered by the in-module `cargo test --lib` suite). The
//! predecessor-based refusal of `propose_payment` itself is covered in Prompt 4 when that
//! method exists; here the authorization *predicate* is proven via the
//! `is_delegate_authorized` view, and predecessor gating is proven via the owner-gated
//! `create_task`/`add_delegate`/`revoke_delegate` tests (which read predecessor now).
//!
//! Refusals are asserted by substring against the canonical `purser_contract::MSG_*`
//! constants (the runtime wraps the literal in a "Smart contract panicked: …" envelope),
//! so the entrypoint and the test share one source of truth and cannot drift.

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

/// Fresh sandbox + deployed, initialized contract. Returns the worker, the contract, an
/// `owner` account (the contract owner), and a `stranger` (non-owner) account.
async fn setup() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(wasm().await).await?;
    let owner = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    contract
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer_id": "v1.signer-prod.testnet" }))
        .transact()
        .await?
        .into_result()?;
    Ok((worker, contract, owner, stranger))
}

/// Owner creates a task with the given cap/crew_cap (NearNative token). Asserts success.
async fn create_task(
    owner: &Account,
    c: &Contract,
    task_id: &str,
    cap: &str,
    crew_cap: u8,
) -> anyhow::Result<()> {
    let res = owner
        .call(c.id(), "create_task")
        .args_json(
            json!({ "task_id": task_id, "cap": cap, "token": "NearNative", "crew_cap": crew_cap }),
        )
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "create_task failed: {:?}", res.failures());
    Ok(())
}

async fn add_delegate(
    owner: &Account,
    c: &Contract,
    task_id: &str,
    account_id: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(owner
        .call(c.id(), "add_delegate")
        .args_json(
            json!({ "task_id": task_id, "account_id": account_id, "derivation_path": "m/44/0" }),
        )
        .max_gas()
        .transact()
        .await?)
}

async fn is_authorized(c: &Contract, task_id: &str, account_id: &str) -> anyhow::Result<bool> {
    Ok(c.view("is_delegate_authorized")
        .args_json(json!({ "task_id": task_id, "account_id": account_id }))
        .await?
        .json::<bool>()?)
}

fn err_string(res: near_workspaces::result::ExecutionFinalResult) -> String {
    format!("{:?}", res.into_result().unwrap_err())
}

/// Oracle: the stored `active_crew` counter must always equal the true count of active
/// delegates recomputed from `list_delegates` — the denormalization invariant that the
/// hand-maintained `+1`/`-1` could otherwise silently break.
async fn assert_crew_consistent(c: &Contract, task_id: &str) -> anyhow::Result<()> {
    let delegates: Vec<serde_json::Value> = c
        .view("list_delegates")
        .args_json(json!({ "task_id": task_id, "from_index": 0, "limit": 1000 }))
        .await?
        .json()?;
    let active = delegates.iter().filter(|d| d["active"] == true).count() as u64;
    let task: serde_json::Value = c
        .view("get_task")
        .args_json(json!({ "task_id": task_id }))
        .await?
        .json()?;
    assert_eq!(
        task["active_crew"].as_u64().unwrap(),
        active,
        "active_crew counter desynced from the recomputed active-delegate count"
    );
    Ok(())
}

// ---- DONE WHEN cases --------------------------------------------------------------

/// Authorized delegate passes the predicate; unregistered fails; revoke flips it back.
#[tokio::test]
async fn auth_predicate_and_revoke() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 3).await?;

    assert!(add_delegate(&owner, &c, "t1", "scout.test")
        .await?
        .is_success());
    assert!(
        is_authorized(&c, "t1", "scout.test").await?,
        "registered active delegate should pass"
    );
    assert!(
        !is_authorized(&c, "t1", "stranger.test").await?,
        "unregistered account must fail"
    );

    // revoke → predicate false, and list_delegates shows active=false
    let res = owner
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "revoke failed: {:?}", res.failures());
    assert!(res.json::<bool>()?, "revoke should report was_active=true");
    assert!(
        !is_authorized(&c, "t1", "scout.test").await?,
        "revoked delegate must fail auth"
    );

    let delegates: serde_json::Value = c
        .view("list_delegates")
        .args_json(json!({ "task_id": "t1", "from_index": 0, "limit": 100 }))
        .await?
        .json()?;
    assert_eq!(delegates[0]["account_id"], "scout.test");
    assert_eq!(
        delegates[0]["active"], false,
        "list_delegates must surface the revoked member as inactive"
    );
    Ok(())
}

/// Crew-cap is enforced on the active count; a revoked slot frees room for a new member.
#[tokio::test]
async fn crew_cap_and_free_slot() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 2).await?;

    assert!(add_delegate(&owner, &c, "t1", "scout.test")
        .await?
        .is_success());
    assert!(add_delegate(&owner, &c, "t1", "forge.test")
        .await?
        .is_success());

    // third active delegate exceeds crew_cap=2
    let over = add_delegate(&owner, &c, "t1", "buyer.test").await?;
    assert!(over.is_failure());
    assert!(err_string(over).contains(purser_contract::MSG_CREW_CAP_REACHED));

    // revoke one → a *different* account can take the freed seat
    owner
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(
        add_delegate(&owner, &c, "t1", "buyer.test")
            .await?
            .is_success(),
        "freed slot should admit a new delegate"
    );
    Ok(())
}

/// Non-owner cannot create/add/revoke.
#[tokio::test]
async fn non_owner_cannot_mutate() -> anyhow::Result<()> {
    let (_w, c, owner, stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 2).await?;
    assert!(add_delegate(&owner, &c, "t1", "scout.test")
        .await?
        .is_success());

    let bad_create = stranger
        .call(c.id(), "create_task")
        .args_json(json!({ "task_id": "t2", "cap": "50", "token": "NearNative", "crew_cap": 1 }))
        .max_gas()
        .transact()
        .await?;
    assert!(bad_create.is_failure());
    assert!(err_string(bad_create).contains(purser_contract::MSG_ONLY_OWNER));

    let bad_add = stranger
        .call(c.id(), "add_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "forge.test", "derivation_path": "" }))
        .max_gas()
        .transact()
        .await?;
    assert!(bad_add.is_failure());
    assert!(err_string(bad_add).contains(purser_contract::MSG_ONLY_OWNER));

    let bad_revoke = stranger
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?;
    assert!(bad_revoke.is_failure());
    assert!(err_string(bad_revoke).contains(purser_contract::MSG_ONLY_OWNER));

    // state unchanged: t2 never created, scout still active
    let ids: Vec<String> = c
        .view("list_task_ids")
        .args_json(json!({ "from_index": 0, "limit": 100 }))
        .await?
        .json()?;
    assert_eq!(ids, vec!["t1".to_string()]);
    assert!(is_authorized(&c, "t1", "scout.test").await?);
    Ok(())
}

/// Duplicate task_id and degenerate inputs are refused.
#[tokio::test]
async fn create_task_input_validation() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 2).await?;

    let dup = owner
        .call(c.id(), "create_task")
        .args_json(json!({ "task_id": "t1", "cap": "100", "token": "NearNative", "crew_cap": 2 }))
        .max_gas()
        .transact()
        .await?;
    assert!(dup.is_failure());
    assert!(err_string(dup).contains(purser_contract::MSG_TASK_EXISTS));

    for (args, needle) in [
        (
            json!({ "task_id": "", "cap": "100", "token": "NearNative", "crew_cap": 1 }),
            purser_contract::MSG_INVALID_TASK_ID,
        ),
        (
            json!({ "task_id": "zero", "cap": "0", "token": "NearNative", "crew_cap": 1 }),
            purser_contract::MSG_CAP_POSITIVE,
        ),
        (
            json!({ "task_id": "nocrew", "cap": "100", "token": "NearNative", "crew_cap": 0 }),
            purser_contract::MSG_CREW_CAP_MIN,
        ),
    ] {
        let res = owner
            .call(c.id(), "create_task")
            .args_json(args)
            .max_gas()
            .transact()
            .await?;
        assert!(res.is_failure());
        assert!(err_string(res).contains(needle), "expected `{needle}`");
    }
    Ok(())
}

/// Re-adding an existing delegate is refused; a re-revoke is an idempotent no-op.
#[tokio::test]
async fn readd_refused_and_revoke_idempotent() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 3).await?;
    assert!(add_delegate(&owner, &c, "t1", "scout.test")
        .await?
        .is_success());

    let dup = add_delegate(&owner, &c, "t1", "scout.test").await?;
    assert!(dup.is_failure());
    assert!(err_string(dup).contains(purser_contract::MSG_DELEGATE_EXISTS));

    // first revoke returns true, second returns false (idempotent, no double-decrement)
    let r1: bool = owner
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert!(r1);
    let r2: bool = owner
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert!(!r2, "re-revoke must be an idempotent no-op");

    // active_crew back to 0 → crew_cap=3 still admits new members (no double-decrement corruption)
    assert!(add_delegate(&owner, &c, "t1", "forge.test")
        .await?
        .is_success());
    Ok(())
}

/// Views + NEP-297 events: get_task/remaining_budget/list_task_ids, and EVENT_JSON logs.
#[tokio::test]
async fn views_and_events() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;

    let created = owner
        .call(c.id(), "create_task")
        .args_json(json!({ "task_id": "t1", "cap": "100", "token": "NearNative", "crew_cap": 2 }))
        .max_gas()
        .transact()
        .await?;
    assert!(created.is_success());
    assert!(
        created.logs().iter().any(|l| l.contains("task_created")
            && l.contains("EVENT_JSON")
            && l.contains("NearNative")),
        "create_task must emit a NEP-297 task_created event carrying the token; logs: {:?}",
        created.logs()
    );

    // get_task + remaining_budget
    let task: serde_json::Value = c
        .view("get_task")
        .args_json(json!({ "task_id": "t1" }))
        .await?
        .json()?;
    assert_eq!(task["cap"], "100");
    assert_eq!(task["completed"], "0");
    assert_eq!(task["outstanding"], "0");
    assert_eq!(task["active_crew"], 0);
    let remaining: String = c
        .view("remaining_budget")
        .args_json(json!({ "task_id": "t1" }))
        .await?
        .json()?;
    assert_eq!(remaining, "100");
    let ids: Vec<String> = c
        .view("list_task_ids")
        .args_json(json!({ "from_index": 0, "limit": 100 }))
        .await?
        .json()?;
    assert_eq!(ids, vec!["t1".to_string()]);

    let added = add_delegate(&owner, &c, "t1", "scout.test").await?;
    assert!(added.logs().iter().any(|l| l.contains("delegate_added")));
    // active_crew tracked
    let task: serde_json::Value = c
        .view("get_task")
        .args_json(json!({ "task_id": "t1" }))
        .await?
        .json()?;
    assert_eq!(task["active_crew"], 1);

    let revoked = owner
        .call(c.id(), "revoke_delegate")
        .args_json(json!({ "task_id": "t1", "account_id": "scout.test" }))
        .max_gas()
        .transact()
        .await?;
    assert!(revoked
        .logs()
        .iter()
        .any(|l| l.contains("delegate_revoked")));
    let task: serde_json::Value = c
        .view("get_task")
        .args_json(json!({ "task_id": "t1" }))
        .await?
        .json()?;
    assert_eq!(task["active_crew"], 0);

    // unknown task → remaining 0, empty delegates, no panic
    let r0: String = c
        .view("remaining_budget")
        .args_json(json!({ "task_id": "nope" }))
        .await?
        .json()?;
    assert_eq!(r0, "0");
    let empty: Vec<serde_json::Value> = c
        .view("list_delegates")
        .args_json(json!({ "task_id": "nope", "from_index": 0, "limit": 100 }))
        .await?
        .json()?;
    assert!(empty.is_empty());
    Ok(())
}

/// The `active_crew` counter stays equal to the recomputed active-delegate count across a
/// full add / add / revoke / re-revoke / add churn (P2-2 denormalization oracle).
#[tokio::test]
async fn active_crew_oracle() -> anyhow::Result<()> {
    let (_w, c, owner, _stranger) = setup().await?;
    create_task(&owner, &c, "t1", "100", 3).await?;
    assert_crew_consistent(&c, "t1").await?; // 0

    add_delegate(&owner, &c, "t1", "scout.test")
        .await?
        .into_result()?;
    add_delegate(&owner, &c, "t1", "forge.test")
        .await?
        .into_result()?;
    assert_crew_consistent(&c, "t1").await?; // 2

    let revoke = |acct: &'static str| {
        owner
            .call(c.id(), "revoke_delegate")
            .args_json(json!({ "task_id": "t1", "account_id": acct }))
            .max_gas()
            .transact()
    };
    revoke("scout.test").await?.into_result()?;
    revoke("scout.test").await?.into_result()?; // idempotent re-revoke — must not double-decrement
    assert_crew_consistent(&c, "t1").await?; // 1

    add_delegate(&owner, &c, "t1", "buyer.test")
        .await?
        .into_result()?;
    assert_crew_consistent(&c, "t1").await?; // 2
    Ok(())
}
