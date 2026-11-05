//! The Purser attack suite (Prompt 6; TECHNICAL §9B; DEMO-SCRIPT shot list): one named test per
//! demo case, on a near-workspaces sandbox against the real production wasm.
//!
//! "Concurrent" on NEAR means several `propose_payment` receipts execute while earlier proposals'
//! async continuations (transfer -> `on_near_settled`) are still pending. That is the window a
//! check-in-propose / reserve-in-callback design overspends in. Cases 2 and 4 fan the proposals
//! out through the race-driver fixture, so they land at Purser in ONE block, and then PROVE from
//! on-chain receipt heights that every admission ran before the first settlement
//! (`common::race_proof`). The external `transact_async` variants (2b, 4b) mirror the demo's
//! "agents fire at once" and are held to the same proof, with a bounded retry that fails loudly
//! instead of silently passing when the sandbox happens not to race.
//!
//! Every refusal is asserted against the canonical `purser_contract::MSG_*` constant.

mod common;

use std::task::Poll;
use std::time::Duration;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use purser_contract::{
    FAULT_MARKER, MSG_DELEGATE_NOT_AUTHORIZED, MSG_EXCEEDS_BUDGET, MSG_INVALID_RECIPIENT,
    MSG_IN_FLIGHT, MSG_RECIPIENT_NOT_ALLOWED, MSG_RECONCILE_TOO_EARLY, RECONCILE_MIN_AGE_NS,
};
use serde_json::{json, Value};

/// Bounded attempts for the externally-dispatched (non-deterministic) race variants.
const RACE_ATTEMPTS: usize = 5;
/// Upper bound on waiting for one async-dispatched transaction (sandbox blocks are ~1 s).
const SETTLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Upper bound on fast-forward rounds while waiting out the reconcile time-lock.
const MAX_FAST_FORWARDS: usize = 10;

async fn commitment(crew: &Crew, id: u64) -> anyhow::Result<Value> {
    view(crew, "get_commitment", json!({ "commitment_id": id })).await
}

async fn idempotency(crew: &Crew, who: &Account, rid: &str) -> anyhow::Result<Value> {
    view(
        crew,
        "get_idempotency",
        json!({ "account_id": who.id(), "request_id": rid }),
    )
    .await
}

async fn remaining(crew: &Crew) -> anyhow::Result<u128> {
    let v = view(crew, "remaining_budget", json!({ "task_id": TASK })).await?;
    Ok(v.as_str().unwrap().parse()?)
}

/// Wait for an async-dispatched transaction to finish, failing instead of hanging CI.
async fn settle(
    tx: near_workspaces::operations::TransactionStatus,
) -> anyhow::Result<ExecutionFinalResult> {
    tokio::time::timeout(SETTLE_TIMEOUT, async {
        loop {
            match tx.status().await? {
                Poll::Ready(r) => return Ok(r),
                Poll::Pending => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("transaction did not finish within {SETTLE_TIMEOUT:?}"))?
}

// ---- (1) legit purchases -----------------------------------------------------------------------

/// Three delegates each buy 30 of a 100 budget, one after another: all settle, the accounting is
/// exact, and exactly 90 units reached the merchant.
#[tokio::test]
async fn case_1_three_delegates_legit_purchases_succeed() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let crew_accts = [
        w.dev_create_account().await?,
        w.dev_create_account().await?,
        w.dev_create_account().await?,
    ];
    let ids: Vec<_> = crew_accts.iter().map(|a| a.id()).collect();
    let crew = setup(w, prod_wasm().await, owner, 100, &ids).await?;
    let before = balance(&crew.merchant).await?;

    let mut hashes = std::collections::HashSet::new();
    for (i, who) in crew_accts.iter().enumerate() {
        let res = propose(who, &crew, 30, &format!("buy-{i}")).await?;
        assert!(
            res.is_success(),
            "purchase {i} failed: {:?}",
            res.failures()
        );
        let confirmed = res
            .logs()
            .iter()
            .filter(|l| l.contains("\"event\":\"payment_confirmed\""))
            .count();
        assert_eq!(confirmed, 1, "one payment_confirmed per purchase");
        let c = commitment(&crew, i as u64).await?;
        assert_eq!(c["state"], "Confirmed");
        hashes.insert(c["payload_hash"].to_string());
        accounting(&crew).await?;
    }
    assert_eq!(accounting(&crew).await?, (90 * UNIT, 0));
    assert_eq!(remaining(&crew).await?, 10 * UNIT);
    assert_eq!(balance(&crew.merchant).await? - before, 90 * UNIT);
    assert_eq!(hashes.len(), 3, "each spend has its own payload_hash");
    Ok(())
}

// ---- (2) concurrent over-budget ----------------------------------------------------------------

/// The money shot. 40 left; Scout, Forge and Buyer each ask for 30 IN THE SAME BLOCK. Exactly
/// ⌊40/30⌋ = 1 is authorized, the other two are refused before any signature exists, and the
/// receipt heights prove all three admissions ran inside the async gap.
#[tokio::test]
async fn case_2_concurrent_overbudget_exactly_floor_r_over_a_admitted() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let coordinator = deploy_driver(&w, owner.id()).await?;
    let mut drivers = Vec::new();
    for _ in 0..3 {
        drivers.push(deploy_driver(&w, coordinator.id()).await?);
    }
    let ids: Vec<_> = drivers.iter().map(|d| d.id()).collect();
    let crew = setup(w, prod_wasm().await, owner, 100, &ids).await?;

    // Two legit purchases first: 100 -> 40 remaining.
    for (i, d) in drivers[..2].iter().enumerate() {
        let res = propose(d.as_account(), &crew, 30, &format!("pre-{i}")).await?;
        assert!(res.is_success(), "{:?}", res.failures());
    }
    let r = remaining(&crew).await?;
    assert_eq!(r, 40 * UNIT);
    let before = balance(&crew.merchant).await?;

    // One coordinator transaction -> 3 driver receipts (one block) -> 3 proposals (one block).
    let leaves = drivers
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let propose = driver_call(
                crew.purser.id(),
                "propose_payment",
                propose_args(crew.merchant.id(), 30, &format!("race-{i}")),
                75,
            );
            driver_call(d.id(), "fire", json!({ "calls": [propose] }), 90)
        })
        .collect();
    let res = fire(coordinator.as_account(), coordinator.id(), leaves).await?;
    println!("case 2 gas burnt: {} Tgas", res.total_gas_burnt.as_tgas());

    let proof = race_proof(&crew.worker, crew.purser.id(), &[&res]).await?;
    let a = 30 * UNIT;
    assert_eq!(proof.reserved() as u128, r / a, "exactly ⌊R/a⌋ authorized");
    assert_eq!(
        proof.refused(MSG_EXCEEDS_BUDGET),
        2,
        "the excess is refused"
    );
    assert!(proof.same_block(), "all three admissions in one block");
    assert!(
        proof.raced(),
        "every admission ran before the first settlement"
    );

    assert_eq!(accounting(&crew).await?, (90 * UNIT, 0));
    assert_eq!(remaining(&crew).await?, 10 * UNIT);
    assert_eq!(
        balance(&crew.merchant).await? - before,
        30 * UNIT,
        "only the winner was paid"
    );
    assert!(
        commitment(&crew, 3).await?.is_null(),
        "refusals consumed no commitment id"
    );
    Ok(())
}

/// Demo-faithful variant: three independent delegates dispatch with `transact_async` at once.
/// The cap holds on every attempt; the race itself must be observed within a bounded number of
/// attempts, or the test fails ("race not exercised") rather than passing on a serialized run.
#[tokio::test]
async fn case_2b_external_parallel_dispatch_races() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    for attempt in 1..=RACE_ATTEMPTS {
        let owner = w.dev_create_account().await?;
        let accts = [
            w.dev_create_account().await?,
            w.dev_create_account().await?,
            w.dev_create_account().await?,
        ];
        let ids: Vec<_> = accts.iter().map(|a| a.id()).collect();
        let crew = setup(w.clone(), prod_wasm().await, owner, 100, &ids).await?;
        for (i, who) in accts[..2].iter().enumerate() {
            assert!(propose(who, &crew, 30, &format!("pre-{i}"))
                .await?
                .is_success());
        }

        let (t0, t1, t2) = tokio::join!(
            propose_tx(&accts[0], &crew, 30, "race-0").transact_async(),
            propose_tx(&accts[1], &crew, 30, "race-1").transact_async(),
            propose_tx(&accts[2], &crew, 30, "race-2").transact_async(),
        );
        let (r0, r1, r2) = tokio::join!(settle(t0?), settle(t1?), settle(t2?));
        let (r0, r1, r2) = (r0?, r1?, r2?);
        let proof = race_proof(&crew.worker, crew.purser.id(), &[&r0, &r1, &r2]).await?;

        // Safety holds whether or not this attempt raced.
        assert_eq!(proof.reserved(), 1);
        assert_eq!(proof.refused(MSG_EXCEEDS_BUDGET), 2);
        assert_eq!(accounting(&crew).await?, (90 * UNIT, 0));
        if proof.raced() {
            println!("case 2b: race observed on attempt {attempt}/{RACE_ATTEMPTS}");
            return Ok(());
        }
    }
    panic!("race not exercised in {RACE_ATTEMPTS} attempts: the proposals serialized");
}

// ---- (3) retry after completion ----------------------------------------------------------------

/// Retrying a completed request returns the SAME commitment with no second transfer; retrying a
/// refused request is refused again (a refusal authorized nothing). Reusing a settled request_id
/// for a different request is covered next to its fix in `payments.rs`.
#[tokio::test]
async fn case_3_retry_after_completion_no_duplicate() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let accts = [
        w.dev_create_account().await?,
        w.dev_create_account().await?,
        w.dev_create_account().await?,
    ];
    let ids: Vec<_> = accts.iter().map(|a| a.id()).collect();
    let crew = setup(w, prod_wasm().await, owner, 100, &ids).await?;
    let scout = &accts[0];

    let first = propose(scout, &crew, 30, "r1").await?;
    assert!(first.is_success(), "{:?}", first.failures());
    let cid: u64 = first.json()?;
    let (paid, books) = (balance(&crew.merchant).await?, accounting(&crew).await?);

    let retry = propose(scout, &crew, 30, "r1").await?;
    assert!(retry.is_success(), "{:?}", retry.failures());
    assert!(
        retry.logs().iter().all(|l| !l.contains("EVENT_JSON")),
        "a replay emits nothing"
    );
    assert_eq!(retry.json::<u64>()?, cid, "same request -> same commitment");
    assert_eq!(balance(&crew.merchant).await?, paid, "no second transfer");
    assert_eq!(accounting(&crew).await?, books);
    assert!(
        commitment(&crew, cid + 1).await?.is_null(),
        "no new commitment"
    );

    // Spend down to 10, then a refused request stays refused on retry.
    assert!(propose(&accts[1], &crew, 30, "f1").await?.is_success());
    assert!(propose(&accts[2], &crew, 30, "b1").await?.is_success());
    let books = accounting(&crew).await?;
    for _ in 0..2 {
        let refused = propose(scout, &crew, 30, "too-much").await?;
        assert!(err_string(refused).contains(MSG_EXCEEDS_BUDGET));
        assert_eq!(accounting(&crew).await?, books);
    }
    assert!(
        idempotency(&crew, scout, "too-much").await?.is_null(),
        "a refusal records nothing"
    );
    assert_eq!(remaining(&crew).await?, 10 * UNIT);
    Ok(())
}

// ---- (4) retry while in flight -----------------------------------------------------------------

/// The first request and its retry land in one block, back to back, in creation order. When the
/// retry executes, the first one's transfer and callback have not run yet (proved by heights),
/// and it is refused "in-flight": exactly one reservation, one transfer.
#[tokio::test]
async fn case_4_retry_while_in_flight_returns_in_flight() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let scout = deploy_driver(&w, owner.id()).await?;
    let crew = setup(w, prod_wasm().await, owner, 100, &[scout.id()]).await?;
    let before = balance(&crew.merchant).await?;

    let call = driver_call(
        crew.purser.id(),
        "propose_payment",
        propose_args(crew.merchant.id(), 30, "r1"),
        120,
    );
    let res = fire(scout.as_account(), scout.id(), vec![call.clone(), call]).await?;

    let proof = race_proof(&crew.worker, crew.purser.id(), &[&res]).await?;
    assert_eq!(proof.reserved(), 1, "exactly one reservation");
    assert_eq!(
        proof.refused(MSG_IN_FLIGHT),
        1,
        "the retry is refused in-flight"
    );
    assert!(proof.same_block());
    assert!(
        proof.raced(),
        "the retry executed before the first request settled"
    );

    assert!(
        commitment(&crew, 1).await?.is_null(),
        "no second commitment"
    );
    assert_eq!(accounting(&crew).await?, (30 * UNIT, 0));
    assert_eq!(
        balance(&crew.merchant).await? - before,
        30 * UNIT,
        "one transfer"
    );
    assert_eq!(
        idempotency(&crew, scout.as_account(), "r1").await?,
        json!({ "Committed": { "commitment_id": 0 } })
    );
    Ok(())
}

/// External variant: the same signer sends a request and its retry back to back. Whichever way
/// they land, there is at most one reservation and one transfer; the in-flight window itself
/// must be observed within a bounded number of attempts.
#[tokio::test]
async fn case_4b_external_in_flight_retry() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let scout = w.dev_create_account().await?;
    let crew = setup(w, prod_wasm().await, owner, 100, &[scout.id()]).await?;
    // Warm the signer's nonce cache first: two concurrent FIRST transactions both fetch the same
    // nonce from RPC and become one byte-identical transaction.
    assert!(propose(&scout, &crew, 10, "warm-up").await?.is_success());

    for attempt in 1..=RACE_ATTEMPTS {
        let rid = format!("r{attempt}");
        let before = balance(&crew.merchant).await?;
        let (t0, t1) = tokio::join!(
            propose_tx(&scout, &crew, 10, &rid).transact_async(),
            propose_tx(&scout, &crew, 10, &rid).transact_async(),
        );
        let (r0, r1) = tokio::join!(settle(t0?), settle(t1?));
        let (r0, r1) = (r0?, r1?);
        assert_ne!(
            r0.outcome().transaction_hash,
            r1.outcome().transaction_hash,
            "the request and its retry must be two transactions"
        );
        let proof = race_proof(&crew.worker, crew.purser.id(), &[&r0, &r1]).await?;

        assert_eq!(proof.reserved(), 1, "never a second reservation");
        assert_eq!(
            balance(&crew.merchant).await? - before,
            10 * UNIT,
            "one transfer"
        );
        let cid = attempt as u64; // commitment 0 is the warm-up
        assert_eq!(
            idempotency(&crew, &scout, &rid).await?,
            json!({ "Committed": { "commitment_id": cid } })
        );
        if proof.refused(MSG_IN_FLIGHT) == 1 && proof.raced() {
            println!("case 4b: in-flight retry observed on attempt {attempt}/{RACE_ATTEMPTS}");
            return Ok(());
        }
    }
    panic!("in-flight window not exercised in {RACE_ATTEMPTS} attempts");
}

// ---- (5) tampered recipient --------------------------------------------------------------------

/// A delegate redirects a payment to an account the owner never allowlisted, or to a malformed
/// one: both are refused before any reservation, and nothing moves.
#[tokio::test]
async fn case_5_tampered_recipient_rejected() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let scout = w.dev_create_account().await?;
    let attacker = w.dev_create_account().await?;
    let crew = setup(w, prod_wasm().await, owner, 100, &[scout.id()]).await?;
    let loot = balance(&attacker).await?;

    for (recipient, msg) in [
        (json!(attacker.id()), MSG_RECIPIENT_NOT_ALLOWED),
        (json!("NOT AN ACCOUNT!"), MSG_INVALID_RECIPIENT),
    ] {
        let mut args = propose_args(crew.merchant.id(), 30, "swap");
        args["intent"]["recipient"] = recipient;
        let res = scout
            .call(crew.purser.id(), "propose_payment")
            .args_json(args)
            .max_gas()
            .transact()
            .await?;
        assert!(err_string(res).contains(msg));
    }
    assert_eq!(accounting(&crew).await?, (0, 0));
    assert!(
        commitment(&crew, 0).await?.is_null(),
        "no reservation was opened"
    );
    assert_eq!(
        balance(&attacker).await?,
        loot,
        "nothing reached the attacker"
    );
    Ok(())
}

// ---- (6) revocation ----------------------------------------------------------------------------

/// Revoking Buyer blocks its new proposals AND its retries; its past spend stands (revocation is
/// honest: it cannot un-issue a payment), and the rest of the crew keeps working.
#[tokio::test]
async fn case_6_revoked_delegate_blocked() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let scout = w.dev_create_account().await?;
    let buyer = w.dev_create_account().await?;
    let crew = setup(w, prod_wasm().await, owner, 100, &[scout.id(), buyer.id()]).await?;

    assert!(propose(&buyer, &crew, 30, "b1").await?.is_success());
    let revoked: bool = crew
        .owner
        .call(crew.purser.id(), "revoke_delegate")
        .args_json(json!({ "task_id": TASK, "account_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert!(revoked);

    let fresh = propose(&buyer, &crew, 30, "b2").await?;
    assert!(err_string(fresh).contains(MSG_DELEGATE_NOT_AUTHORIZED));
    let retry = propose(&buyer, &crew, 30, "b1").await?;
    assert!(err_string(retry).contains(MSG_DELEGATE_NOT_AUTHORIZED));
    let authorized = view(
        &crew,
        "is_delegate_authorized",
        json!({ "task_id": TASK, "account_id": buyer.id() }),
    )
    .await?;
    assert_eq!(authorized, json!(false));

    assert_eq!(
        commitment(&crew, 0).await?["state"],
        "Confirmed",
        "past spend stands"
    );
    assert_eq!(accounting(&crew).await?, (30 * UNIT, 0));
    assert!(
        propose(&scout, &crew, 30, "s1").await?.is_success(),
        "the crew still works"
    );
    Ok(())
}

// ---- (7) timeout on an issued payment ----------------------------------------------------------

/// Fault build: the transfer executes but the settlement callback dies (the documented
/// lost-callback residual, i.e. a timeout). The reservation is RETAINED through silence over
/// many blocks, a retry, and a revocation; it is released only by the owner's proof-carrying
/// reconcile, and only once the callback can no longer be in flight.
#[tokio::test]
async fn case_7_timeout_on_issued_payment_reservation_retained() -> anyhow::Result<()> {
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
    assert_eq!(
        balance(&crew.merchant).await? - before,
        30 * UNIT,
        "the transfer escaped"
    );

    let held = |c: &Value| c["state"] == "Reserved";
    let snapshot = (commitment(&crew, 0).await?, task(&crew).await?);
    assert!(held(&snapshot.0));
    assert_eq!(idempotency(&crew, &buyer, "b1").await?, json!("Pending"));
    assert_eq!(accounting(&crew).await?, (0, 30 * UNIT));

    // Proof, but too early: the callback might still be in flight, so the owner cannot release
    // or settle it yet.
    let reconcile = || {
        crew.owner
            .call(crew.purser.id(), "reconcile")
            .args_json(json!({ "commitment_id": 0, "confirmed": true }))
            .max_gas()
            .transact()
    };
    let early = reconcile().await?;
    assert!(err_string(early).contains(MSG_RECONCILE_TOO_EARLY));

    // Silence: many blocks pass (the sandbox may stop short of an epoch boundary, so assert the
    // state, not the height delta).
    crew.worker.fast_forward(1_000).await?;
    assert_eq!(
        (commitment(&crew, 0).await?, task(&crew).await?),
        snapshot,
        "silence released nothing"
    );

    let retry = propose(&buyer, &crew, 30, "b1").await?;
    assert!(
        err_string(retry).contains(MSG_IN_FLIGHT),
        "no second reservation"
    );
    let revoke = crew
        .owner
        .call(crew.purser.id(), "revoke_delegate")
        .args_json(json!({ "task_id": TASK, "account_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?;
    assert!(revoke.is_success());
    assert_eq!(
        accounting(&crew).await?,
        (0, 30 * UNIT),
        "revocation released nothing"
    );
    let over = propose(&scout, &crew, 71, "s1").await?;
    assert!(
        err_string(over).contains(MSG_EXCEEDS_BUDGET),
        "the held 30 still counts"
    );

    // Proof: the owner attests the (observed) landed transfer once the lock has passed. Retry the
    // reconcile itself (it lands in a later block than any timestamp we could read first), with
    // a bounded number of fast-forwards, and require that time really advanced past the lock.
    let created_at = snapshot.0["created_at"].as_u64().unwrap();
    let mut rounds = 0;
    loop {
        let res = reconcile().await?;
        if res.is_success() {
            break;
        }
        assert!(err_string(res).contains(MSG_RECONCILE_TOO_EARLY));
        rounds += 1;
        assert!(
            rounds <= MAX_FAST_FORWARDS,
            "the sandbox clock never passed the reconcile lock"
        );
        crew.worker.fast_forward(1_000).await?;
    }
    let now = crew.worker.view_block().await?.timestamp();
    assert!(
        now >= created_at + RECONCILE_MIN_AGE_NS,
        "reconciled before the lock elapsed"
    );
    assert_eq!(commitment(&crew, 0).await?["state"], "Confirmed");
    assert_eq!(accounting(&crew).await?, (30 * UNIT, 0));
    Ok(())
}

// ---- beyond the demo: owner/callback surfaces --------------------------------------------------

/// The owner releases a reservation in the same block its payment is proposed, racing the live
/// settlement callback. It must be refused: the transfer lands, and money that left the contract
/// must be counted as spent, never released back into headroom.
#[tokio::test]
async fn case_8_reconcile_cannot_race_live_callback() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let host = deploy_driver(&w, &"unused.test.near".parse()?).await?; // the owner hosts a driver
    let owner = host.as_account().clone();
    let crew = setup(w, prod_wasm().await, owner.clone(), 100, &[owner.id()]).await?;
    let before = balance(&crew.merchant).await?;

    let propose = driver_call(
        crew.purser.id(),
        "propose_payment",
        propose_args(crew.merchant.id(), 30, "r1"),
        120,
    );
    let release = driver_call(
        crew.purser.id(),
        "reconcile",
        json!({ "commitment_id": 0, "confirmed": false }),
        60,
    );
    let res = fire(&owner, owner.id(), vec![propose, release]).await?;

    let purser = crew.purser.id();
    let early = res
        .receipt_outcomes()
        .iter()
        .find(|o| &o.executor_id == purser && o.is_failure())
        .expect("the early reconcile failed");
    let settled = res
        .receipt_outcomes()
        .iter()
        .find(|o| has_event(o, "payment_confirmed"))
        .expect("the payment settled");
    assert!(format!("{:?}", early.clone().into_result()).contains(MSG_RECONCILE_TOO_EARLY));
    let (h_early, h_settled) = (
        height(&crew.worker, early).await?,
        height(&crew.worker, settled).await?,
    );
    println!("case 8: reconcile at height {h_early}, settlement at {h_settled}");
    assert!(h_early < h_settled, "the reconcile raced the live callback");

    let paid = balance(&crew.merchant).await? - before;
    assert_eq!(paid, 30 * UNIT);
    assert_eq!(
        accounting(&crew).await?,
        (paid, 0),
        "every unit that left is counted as spent"
    );
    assert_eq!(commitment(&crew, 0).await?["state"], "Confirmed");
    Ok(())
}

/// The evidence uses two different artifacts, and the one that ships is clean: the fault marker
/// is in the fault build and nowhere in the production build.
#[tokio::test]
async fn fault_hook_absent_from_production_wasm() -> anyhow::Result<()> {
    let marker = FAULT_MARKER.as_bytes();
    let contains = |wasm: &[u8]| wasm.windows(marker.len()).any(|w| w == marker);
    assert!(
        !contains(prod_wasm().await),
        "production wasm carries the fault hook"
    );
    assert!(contains(fault_wasm().await), "fault build lacks its hook");
    Ok(())
}
