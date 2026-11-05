//! Shared sandbox harness for the attack suite: artifact builds, crew setup, proposals, the
//! receipt-height race proof, and strict leaf classification.
#![allow(dead_code)] // each test binary uses a subset

use std::path::Path;

use near_sdk::json_types::Base64VecU8;
use near_sdk::Gas;
use near_workspaces::cargo_near_build::{build_with_cli, camino::Utf8PathBuf, BuildOpts};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

pub const TASK: &str = "t1";
/// One demo "unit" = 0.001 NEAR, so the round on-camera numbers (cap 100, 30 per purchase) are
/// real token movements that a sandbox dev account can fund.
pub const UNIT: u128 = 1_000_000_000_000_000_000_000;

pub fn units(n: u128) -> String {
    (n * UNIT).to_string()
}

// ---- artifacts ----------------------------------------------------------------------------------

pub struct Wasms {
    /// The production contract: default features, exactly what `make build` ships.
    pub prod: Vec<u8>,
    /// The test-only `fault-injection` build (settlement callback always dies).
    pub fault: Vec<u8>,
    /// The race-driver fan-out fixture.
    pub driver: Vec<u8>,
}

static WASMS: OnceCell<Wasms> = OnceCell::const_new();

/// Build all three artifacts once per test binary, one after another (never concurrently), with
/// absolute paths and `--locked`. The fault and driver builds use their own target dirs under
/// `contract/target`, so they never thrash the production build's fingerprints.
pub async fn wasms() -> &'static Wasms {
    WASMS
        .get_or_init(|| async {
            tokio::task::spawn_blocking(|| Wasms {
                prod: build_wasm("Cargo.toml", None, None),
                fault: build_wasm(
                    "Cargo.toml",
                    Some("fault-injection"),
                    Some("fault-injection"),
                ),
                driver: build_wasm(
                    "tests/fixtures/race-driver/Cargo.toml",
                    None,
                    Some("race-driver"),
                ),
            })
            .await
            .expect("artifact build task")
        })
        .await
}

fn build_wasm(manifest: &str, features: Option<&str>, target_subdir: Option<&str>) -> Vec<u8> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = Utf8PathBuf::from_path_buf(root.join(manifest)).expect("utf-8 manifest path");
    let target_dir = target_subdir.map(|d| root.join("target").join(d).display().to_string());
    let opts = BuildOpts {
        manifest_path: Some(manifest),
        features: features.map(str::to_string),
        // build.rs refuses the test-only fault feature without this explicit opt-in
        env: features
            .map(|_| vec![("PURSER_ALLOW_FAULT_INJECTION".to_string(), "1".to_string())])
            .unwrap_or_default(),
        override_cargo_target_dir: target_dir,
        no_abi: true,
        skip_rust_version_check: true,
        ..Default::default()
    };
    let path = build_with_cli(opts).expect("cargo near build");
    std::fs::read(path).expect("read built wasm")
}

// ---- crew ---------------------------------------------------------------------------------------

pub struct Crew {
    pub worker: Worker<Sandbox>,
    pub purser: Contract,
    pub owner: Account,
    pub merchant: Account,
}

/// Deploy + init `contract_wasm`, create task `t1` (cap in units, crew_cap 3), register
/// `delegates`, and allowlist the merchant. All owner setup is one batched transaction.
pub async fn setup(
    worker: Worker<Sandbox>,
    contract_wasm: &[u8],
    owner: Account,
    cap_units: u128,
    delegates: &[&AccountId],
) -> anyhow::Result<Crew> {
    let purser = worker.dev_deploy(contract_wasm).await?;
    let merchant = worker.dev_create_account().await?;
    purser
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer_id": "v1.signer-prod.testnet" }))
        .transact()
        .await?
        .into_result()?;
    let mut batch = owner.batch(purser.id()).call(
        Function::new("create_task")
            .args_json(json!({
                "task_id": TASK, "cap": units(cap_units), "token": "NearNative", "crew_cap": 3,
            }))
            .gas(Gas::from_tgas(20)),
    );
    for d in delegates {
        batch = batch.call(
            Function::new("add_delegate")
                .args_json(json!({ "task_id": TASK, "account_id": d, "derivation_path": "m/0" }))
                .gas(Gas::from_tgas(20)),
        );
    }
    batch
        .call(
            Function::new("set_recipient_allowlist")
                .args_json(json!({ "task_id": TASK, "recipients": [merchant.id()] }))
                .gas(Gas::from_tgas(20)),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(Crew {
        worker,
        purser,
        owner,
        merchant,
    })
}

/// Deploy the race driver on a fresh dev account, letting `coordinator` (and itself) fire it.
pub async fn deploy_driver(
    worker: &Worker<Sandbox>,
    coordinator: &AccountId,
) -> anyhow::Result<Contract> {
    let driver = worker.dev_deploy(&wasms().await.driver).await?;
    driver
        .call("new")
        .args_json(json!({ "coordinator": coordinator }))
        .transact()
        .await?
        .into_result()?;
    Ok(driver)
}

// ---- calls --------------------------------------------------------------------------------------

pub fn propose_args(recipient: &AccountId, amount_units: u128, request_id: &str) -> Value {
    json!({
        "task": TASK,
        "request_id": request_id,
        "intent": {
            "chain": "NearNative",
            "recipient": recipient,
            "amount": units(amount_units),
            "token": "NearNative",
            "memo": null,
        }
    })
}

pub async fn propose(
    delegate: &Account,
    crew: &Crew,
    amount_units: u128,
    request_id: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(delegate
        .call(crew.purser.id(), "propose_payment")
        .args_json(propose_args(crew.merchant.id(), amount_units, request_id))
        .max_gas()
        .transact()
        .await?)
}

/// One driver `Call` (the fixture's JSON shape).
pub fn driver_call(receiver: &AccountId, method: &str, args: Value, tgas: u64) -> Value {
    json!({
        "receiver": receiver,
        "method": method,
        "args": Base64VecU8::from(serde_json::to_vec(&args).unwrap()),
        "gas": Gas::from_tgas(tgas),
    })
}

/// Have `signer` fire `driver` with `calls` (one joined batch).
pub async fn fire(
    signer: &Account,
    driver: &AccountId,
    calls: Vec<Value>,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(driver, "fire")
        .args_json(json!({ "calls": calls }))
        .max_gas()
        .transact()
        .await?)
}

pub async fn view(crew: &Crew, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(crew.purser.view(method).args_json(args).await?.json()?)
}

pub async fn task(crew: &Crew) -> anyhow::Result<Value> {
    view(crew, "get_task", json!({ "task_id": TASK })).await
}

/// `(completed, outstanding)` in yocto, asserting invariant (I) on the way.
pub async fn accounting(crew: &Crew) -> anyhow::Result<(u128, u128)> {
    let t = task(crew).await?;
    let n = |k: &str| t[k].as_str().unwrap().parse::<u128>().unwrap();
    let (completed, outstanding, cap) = (n("completed"), n("outstanding"), n("cap"));
    assert!(
        completed + outstanding <= cap,
        "INVARIANT (I) VIOLATED: {completed} + {outstanding} > {cap}"
    );
    Ok((completed, outstanding))
}

pub async fn balance(a: &Account) -> anyhow::Result<u128> {
    Ok(a.view_account().await?.balance.as_yoctonear())
}

pub fn err_string(res: ExecutionFinalResult) -> String {
    format!("{:?}", res.into_result().unwrap_err())
}

// ---- race proof ---------------------------------------------------------------------------------

/// What one `propose_payment` receipt at Purser did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Reserved,
    Refused(&'static str),
}

#[derive(Debug)]
pub struct RaceProof {
    /// `(block height, outcome)` of every `propose_payment` execution, sorted by height.
    pub admissions: Vec<(u64, Admission)>,
    /// Heights of every settlement callback (`payment_confirmed` / `payment_failed`).
    pub settlements: Vec<u64>,
}

impl RaceProof {
    pub fn reserved(&self) -> usize {
        self.admissions
            .iter()
            .filter(|(_, a)| *a == Admission::Reserved)
            .count()
    }
    pub fn refused(&self, msg: &str) -> usize {
        self.admissions
            .iter()
            .filter(|(_, a)| *a == Admission::Refused(msg_static(msg)))
            .count()
    }
    /// Every admission ran before the first settlement: inside the async gap. Requires one
    /// observed settlement per reservation, so a drifted event name or a misclassified receipt
    /// cannot make the proof pass vacuously.
    pub fn raced(&self) -> bool {
        let last_admission = self.admissions.iter().map(|(h, _)| *h).max();
        let first_settlement = self.settlements.iter().copied().min();
        match (last_admission, first_settlement) {
            (Some(a), Some(s)) => self.settlements.len() == self.reserved() && a < s,
            _ => false,
        }
    }
    pub fn same_block(&self) -> bool {
        let mut hs = self.admissions.iter().map(|(h, _)| *h);
        hs.next().is_some_and(|first| hs.all(|h| h == first))
    }
}

fn msg_static(msg: &str) -> &'static str {
    EXPECTED_REFUSALS
        .iter()
        .copied()
        .find(|m| *m == msg)
        .expect("a known refusal message")
}

/// The only refusals a `propose_payment` leaf may end in. Anything else (out of gas, a driver
/// error, a missing method) fails the test instead of being counted as a refusal.
pub const EXPECTED_REFUSALS: &[&str] = &[
    purser_contract::MSG_EXCEEDS_BUDGET,
    purser_contract::MSG_IN_FLIGHT,
    purser_contract::MSG_ALREADY_FAILED,
    purser_contract::MSG_REQUEST_ID_REUSED,
    purser_contract::MSG_DELEGATE_NOT_AUTHORIZED,
    purser_contract::MSG_RECIPIENT_NOT_ALLOWED,
];

fn has_event(o: &ExecutionOutcome, event: &str) -> bool {
    let needle = format!("\"event\":\"{event}\"");
    o.logs.iter().any(|l| l.contains(&needle))
}

/// Classify every Purser receipt in `results` and resolve block heights. Panics on any failure
/// that is not an expected refusal (strict leaf classification).
pub async fn race_proof(
    worker: &Worker<Sandbox>,
    purser: &AccountId,
    results: &[&ExecutionFinalResult],
) -> anyhow::Result<RaceProof> {
    let mut admissions = Vec::new();
    let mut settlements = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for res in results {
        for o in res.receipt_outcomes() {
            // `transaction_hash` is the receipt id here; never count one receipt twice.
            if !seen.insert(o.transaction_hash) {
                continue;
            }
            if o.is_failure() && &o.executor_id != purser {
                panic!("unexpected failure outside Purser: {o:?}");
            }
            if &o.executor_id != purser {
                continue;
            }
            let height = worker.view_block().block_hash(o.block_hash).await?.height();
            if has_event(o, "payment_confirmed") || has_event(o, "payment_failed") {
                settlements.push(height);
            } else if has_event(o, "payment_reserved") {
                admissions.push((height, Admission::Reserved));
            } else if o.is_failure() {
                let err = format!("{:?}", o.clone().into_result().unwrap_err());
                let msg = EXPECTED_REFUSALS
                    .iter()
                    .copied()
                    .find(|m| err.contains(m))
                    .unwrap_or_else(|| panic!("unexpected Purser failure: {err}"));
                admissions.push((height, Admission::Refused(msg)));
            }
            // other successful Purser receipts (e.g. a replay returning Value) are not admissions
        }
    }
    admissions.sort_by_key(|(h, _)| *h);
    settlements.sort_unstable();
    let proof = RaceProof {
        admissions,
        settlements,
    };
    println!(
        "race proof: admission heights {:?} | settlement heights {:?} | raced = {}",
        proof
            .admissions
            .iter()
            .map(|(h, a)| format!("{h}:{a:?}"))
            .collect::<Vec<_>>(),
        proof.settlements,
        proof.raced()
    );
    Ok(proof)
}
