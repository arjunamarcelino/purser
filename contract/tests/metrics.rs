//! The measuring harness behind `docs/METRICS.md` (`make metrics`; TECHNICAL §9C, PRD §8).
//!
//! Every number is printed as a `METRIC` line through `common::metric` and aggregated by
//! `scripts/metrics-report.mjs`; nothing here is hardcoded. The safety counts use oracles that are
//! independent of the contract's own accounting views (the merchant's balance, receipt events),
//! because `common::accounting` already asserts the invariant and counting its violations would
//! always read zero. Run it single-threaded (`--test-threads=1`) or the latency samples are noise.
//!
//! Sandbox only: latency is wall-clock in a local nearcore sandbox and says nothing about testnet.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use common::*;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Worker};
use purser_contract::{FAULT_MARKER, MSG_DELEGATE_NOT_AUTHORIZED, MSG_RECIPIENT_NOT_ALLOWED};
use serde_json::{json, Value};

/// Proposals measured for gas; round 0 creates storage, so the report quotes round >= 3.
const GAS_ROUNDS: usize = 6;
/// Samples per arm for the added-latency comparison.
const LAT_SAMPLES: usize = 30;
/// Admission-to-settlement block gaps sampled.
const BLOCK_SAMPLES: usize = 5;
/// Independent sandboxes in which three delegates race 30 each at 40 left.
const RACE_ROUNDS: usize = 5;
/// Within-budget requests from active delegates to an allowlisted recipient.
const VALID_REQUESTS: usize = 40;
/// Independent lost-callback scenarios.
const TIMEOUT_ROUNDS: usize = 3;

/// Create a funded sub-account of the sandbox root under a FIXED name, so receipt logs (which embed
/// account ids and are charged per byte) are identical run to run. Random `dev_create_account`
/// names add log-length noise to gas.
async fn fixed(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

/// `setup`, but with fixed account names. Returns the crew and its delegates.
async fn fixed_crew(
    w: Worker<Sandbox>,
    wasm: &[u8],
    cap_units: u128,
    delegates: &[&str],
) -> anyhow::Result<(Crew, Vec<Account>)> {
    let root = w.root_account()?;
    let owner = fixed(&root, "owner", 20).await?;
    let purser_acct = fixed(&root, "purser", 100).await?;
    let merchant = fixed(&root, "merchant", 1).await?;
    let purser = purser_acct.deploy(wasm).await?.into_result()?;
    purser
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer_id": "v1.signer-prod.testnet" }))
        .transact()
        .await?
        .into_result()?;
    let mut accounts = Vec::new();
    for d in delegates {
        accounts.push(fixed(&root, d, 20).await?);
    }
    let mut batch = owner.batch(purser.id()).call(
        near_workspaces::operations::Function::new("create_task")
            .args_json(json!({
                "task_id": TASK, "cap": units(cap_units), "token": "NearNative", "crew_cap": CREW_CAP,
            }))
            .gas(near_workspaces::types::Gas::from_tgas(20)),
    );
    for a in &accounts {
        batch = batch.call(
            near_workspaces::operations::Function::new("add_delegate")
                .args_json(json!({ "task_id": TASK, "account_id": a.id(), "derivation_path": format!("m/{}", a.id()) }))
                .gas(near_workspaces::types::Gas::from_tgas(20)),
        );
    }
    batch
        .call(
            near_workspaces::operations::Function::new("set_recipient_allowlist")
                .args_json(json!({ "task_id": TASK, "recipients": [merchant.id()] }))
                .gas(near_workspaces::types::Gas::from_tgas(20)),
        )
        .transact()
        .await?
        .into_result()?;
    Ok((
        Crew {
            worker: w,
            purser,
            owner,
            merchant,
        },
        accounts,
    ))
}

/// `gas_burnt` of the ONE Purser receipt carrying `event`. Selected by what it did, never by
/// position, and required to be unique (docs/solutions/performance-issues/sandbox-gas-measurement-pitfalls.md).
fn receipt_gas(res: &ExecutionFinalResult, purser: &AccountId, event: &str) -> u64 {
    let hits: Vec<_> = res
        .receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == purser && has_event(o, event))
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "exactly one {event} receipt, got {}",
        hits.len()
    );
    hits[0].gas_burnt.as_gas()
}

async fn storage_usage(crew: &Crew) -> anyhow::Result<u64> {
    Ok(crew.purser.view_account().await?.storage_usage)
}

/// Gas per authorization (the propose receipt and the settlement callback) and the storage one
/// admitted commitment adds, at fixed account names, over several rounds.
#[tokio::test]
async fn gas_and_storage_per_authorization() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let (crew, d) = fixed_crew(w, prod_wasm().await, 100, &["scout"]).await?;
    let mut prev = storage_usage(&crew).await?;
    for round in 0..GAS_ROUNDS {
        let res = propose(&d[0], &crew, 1, &format!("g-{round}")).await?;
        assert!(res.is_success(), "{:?}", res.failures());
        let r = round.to_string();
        let tags = [("unit", "gas"), ("round", r.as_str()), ("path", "near")];
        metric(
            "gas.propose",
            receipt_gas(&res, crew.purser.id(), "payment_reserved") as i128,
            &tags,
        );
        metric(
            "gas.settle",
            receipt_gas(&res, crew.purser.id(), "payment_confirmed") as i128,
            &tags,
        );
        let now = storage_usage(&crew).await?;
        if round >= 1 {
            let bytes = now - prev;
            // 1e19 yoctoNEAR locked per stored byte.
            let stake = (bytes as u128 * 10u128.pow(19)).to_string();
            metric(
                "storage.commitment_bytes",
                bytes as i128,
                &[("round", r.as_str()), ("stake_yocto", stake.as_str())],
            );
        }
        prev = now;
    }
    Ok(())
}

/// Added latency of a governed payment against a bare transfer of the same amount from the same
/// account, interleaved so sandbox drift hits both arms equally, plus the deterministic number:
/// blocks from admission to settlement.
#[tokio::test]
async fn added_latency_vs_bare_transfer() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let (crew, d) = fixed_crew(w, prod_wasm().await, 1000, &["scout"]).await?;
    let amount = NearToken::from_yoctonear(UNIT);
    // warm both paths (first call compiles/caches the contract)
    propose(&d[0], &crew, 1, "warm").await?.into_result()?;
    d[0].transfer_near(crew.merchant.id(), amount)
        .await?
        .into_result()?;

    for i in 0..LAT_SAMPLES {
        let idx = i.to_string();
        let t = Instant::now();
        let res = propose(&d[0], &crew, 1, &format!("l-{i}")).await?;
        let ms = t.elapsed().as_millis() as i128;
        assert!(res.is_success(), "{:?}", res.failures());
        metric(
            "lat.wall_ms",
            ms,
            &[("unit", "ms"), ("arm", "propose"), ("i", idx.as_str())],
        );

        let t = Instant::now();
        d[0].transfer_near(crew.merchant.id(), amount)
            .await?
            .into_result()?;
        let ms = t.elapsed().as_millis() as i128;
        metric(
            "lat.wall_ms",
            ms,
            &[("unit", "ms"), ("arm", "baseline"), ("i", idx.as_str())],
        );
    }

    for i in 0..BLOCK_SAMPLES {
        let res = propose(&d[0], &crew, 1, &format!("b-{i}")).await?;
        let find = |event: &str| {
            res.receipt_outcomes()
                .iter()
                .find(|o| &o.executor_id == crew.purser.id() && has_event(o, event))
                .unwrap_or_else(|| panic!("no {event} receipt"))
        };
        let admitted = height(&crew.worker, find("payment_reserved")).await?;
        let settled = height(&crew.worker, find("payment_confirmed")).await?;
        assert!(settled >= admitted);
        metric(
            "lat.blocks_admit_to_settle",
            (settled - admitted) as i128,
            &[("unit", "blocks"), ("i", &i.to_string())],
        );
    }
    Ok(())
}

/// `(delegate, request_id)` of every `payment_reserved` event across `results`, and the number of
/// `payment_confirmed` events, each receipt counted once.
fn reservation_events(results: &[&ExecutionFinalResult]) -> (BTreeMap<(String, String), u32>, u32) {
    let mut seen = BTreeSet::new();
    let mut reserved: BTreeMap<(String, String), u32> = BTreeMap::new();
    let mut confirmed = 0;
    for res in results {
        for o in res.receipt_outcomes() {
            if !seen.insert(o.transaction_hash) {
                continue;
            }
            for log in &o.logs {
                let Some(start) = log.find('{') else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&log[start..]) else {
                    continue;
                };
                let data = if v["data"].is_array() {
                    &v["data"][0]
                } else {
                    &v["data"]
                };
                match v["event"].as_str() {
                    Some("payment_reserved") => {
                        let key = (
                            data["delegate"].as_str().unwrap_or_default().to_string(),
                            data["request_id"].as_str().unwrap_or_default().to_string(),
                        );
                        *reserved.entry(key).or_default() += 1;
                    }
                    Some("payment_confirmed") => confirmed += 1,
                    _ => {}
                }
            }
        }
    }
    (reserved, confirmed)
}

/// Three delegates race 30 each at 40 left, in one block, then every request id is retried. The
/// merchant is the oracle: what it was actually paid must stay within the cap and equal the
/// confirmed events times the amount, and each `(delegate, request_id)` must be reserved once.
#[tokio::test]
async fn overruns_and_duplicates_under_a_concurrent_race() -> anyhow::Result<()> {
    let (mut overruns, mut duplicates, mut pairs_total) = (0i128, 0i128, 0i128);
    for round in 0..RACE_ROUNDS {
        let w = near_workspaces::sandbox().await?;
        let owner = w.dev_create_account().await?;
        let coordinator = deploy_driver(&w, owner.id()).await?;
        let mut drivers = Vec::new();
        for _ in 0..3 {
            drivers.push(deploy_driver(&w, coordinator.id()).await?);
        }
        let ids: Vec<_> = drivers.iter().map(|d| d.id()).collect();
        let crew = setup(w, prod_wasm().await, owner, 100, &ids).await?;
        let cap = 100 * UNIT;
        let before = balance(&crew.merchant).await?;

        let mut all = Vec::new();
        for (i, d) in drivers[..2].iter().enumerate() {
            all.push(propose(d.as_account(), &crew, 30, &format!("pre-{i}")).await?);
        }
        let leaves = drivers
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let p = driver_call(
                    crew.purser.id(),
                    "propose_payment",
                    propose_args(crew.merchant.id(), 30, &format!("race-{i}")),
                    75,
                );
                driver_call(d.id(), "fire", json!({ "calls": [p] }), 90)
            })
            .collect();
        all.push(fire(coordinator.as_account(), coordinator.id(), leaves).await?);
        // Retry every request id twice, from its own delegate (replays and refusals must both hold).
        for (i, d) in drivers.iter().enumerate() {
            for rid in [format!("pre-{i}"), format!("race-{i}")] {
                for _ in 0..2 {
                    all.push(propose(d.as_account(), &crew, 30, &rid).await?);
                }
            }
        }

        let paid = balance(&crew.merchant).await? - before;
        let refs: Vec<_> = all.iter().collect();
        let (reserved, confirmed) = reservation_events(&refs);
        assert_eq!(
            paid,
            confirmed as u128 * 30 * UNIT,
            "round {round}: merchant was paid something no confirmed event accounts for"
        );
        let distinct = reserved.len() as u128;
        let dup_events: u32 = reserved.values().map(|n| n.saturating_sub(1)).sum();
        let extra_transfers = (paid / (30 * UNIT)).saturating_sub(distinct);
        overruns += (paid > cap) as i128;
        duplicates += dup_events as i128 + extra_transfers as i128;
        pairs_total += reserved.len() as i128;
        accounting(&crew).await?; // also asserts (I); not what the count above rests on
    }
    metric(
        "count.overrun",
        overruns,
        &[("runs", &RACE_ROUNDS.to_string())],
    );
    metric(
        "count.duplicate",
        duplicates,
        &[("pairs", &pairs_total.to_string())],
    );
    Ok(())
}

/// A serial workload of valid requests (active delegate, allowlisted recipient, within budget):
/// every one must be admitted. Hostile requests interleaved with them must all be refused, so the
/// "wrongly blocked" count is not bought by loosening the gate.
#[tokio::test]
async fn valid_requests_are_never_wrongly_blocked() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let (crew, d) = fixed_crew(w, prod_wasm().await, 100, &["scout", "forge"]).await?;
    let outsider = fixed(&crew.worker.root_account()?, "outsider", 20).await?;
    let mut blocked = 0i128;
    for i in 0..VALID_REQUESTS {
        let res = propose(&d[i % 2], &crew, 1, &format!("v-{i}")).await?;
        if res.is_failure() {
            blocked += 1;
        }
        // hostile: a non-delegate caller, and a delegate paying a non-allowlisted account.
        if i % 8 == 0 {
            let r = propose(&outsider, &crew, 1, &format!("x-{i}")).await?;
            assert!(err_string(r).contains(MSG_DELEGATE_NOT_AUTHORIZED));
            let r = d[0]
                .call(crew.purser.id(), "propose_payment")
                .args_json(propose_args(outsider.id(), 1, &format!("y-{i}")))
                .max_gas()
                .transact()
                .await?;
            assert!(err_string(r).contains(MSG_RECIPIENT_NOT_ALLOWED));
        }
    }
    metric(
        "count.wrongly_blocked",
        blocked,
        &[("valid", &VALID_REQUESTS.to_string())],
    );
    Ok(())
}

/// Injected timeout: the fault build kills the settlement callback after the transfer executes.
/// Through silence, a retry and a revocation the reservation must be retained, never released, and
/// the retry must not pay twice.
#[tokio::test]
async fn timeouts_and_retries_never_release_or_duplicate() -> anyhow::Result<()> {
    let (mut released, mut duplicated, mut retained) = (0i128, 0i128, true);
    for _ in 0..TIMEOUT_ROUNDS {
        let w = near_workspaces::sandbox().await?;
        let owner = w.dev_create_account().await?;
        let scout = w.dev_create_account().await?;
        let buyer = w.dev_create_account().await?;
        let crew = setup(w, fault_wasm().await, owner, 100, &[scout.id(), buyer.id()]).await?;
        let before = balance(&crew.merchant).await?;

        let res = propose(&buyer, &crew, 30, "b1").await?;
        assert!(
            format!("{:?}", res.failures()).contains(FAULT_MARKER),
            "the callback must be the thing that died"
        );
        crew.worker.fast_forward(1_000).await?; // silence
        let retry = propose(&buyer, &crew, 30, "b1").await?;
        assert!(retry.is_failure(), "a retry while Pending must be refused");
        crew.owner
            .call(crew.purser.id(), "revoke_delegate")
            .args_json(json!({ "task_id": TASK, "account_id": buyer.id() }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;

        let (completed, outstanding) = accounting(&crew).await?;
        let paid = balance(&crew.merchant).await? - before;
        // Money left the contract once; it must still be counted as held.
        released += (outstanding + completed < paid) as i128;
        retained &= outstanding == 30 * UNIT;
        duplicated += (paid / (30 * UNIT)).saturating_sub(1) as i128;
    }
    metric(
        "timeout.release_on_silence",
        released,
        &[("runs", &TIMEOUT_ROUNDS.to_string())],
    );
    metric(
        "timeout.duplicate_on_retry",
        duplicated,
        &[("runs", &TIMEOUT_ROUNDS.to_string())],
    );
    metric(
        "timeout.reservation_retained",
        retained as i128,
        &[("runs", &TIMEOUT_ROUNDS.to_string())],
    );
    Ok(())
}
