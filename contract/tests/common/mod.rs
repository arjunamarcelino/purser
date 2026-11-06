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
/// Crew cap of every test task (the demo crew: Scout, Forge, Buyer).
pub const CREW_CAP: u8 = 3;
/// Gas for a forwarded `propose_payment` (or `reconcile`) leaf: ~8 Tgas of execution + the
/// 10 Tgas static settlement callback + receipt fees, with headroom (unused gas flows on).
pub const PROPOSE_TGAS: u64 = 75;
/// Gas for a driver's own `fire` receipt when a coordinator fans out to it: its one leaf plus a
/// little for scheduling it. Three of these fit a 300 Tgas transaction.
pub const FIRE_TGAS: u64 = 90;
/// One demo "unit" = 0.001 NEAR, so the round on-camera numbers (cap 100, 30 per purchase) are
/// real token movements that a sandbox dev account can fund.
pub const UNIT: u128 = 1_000_000_000_000_000_000_000;

pub fn units(n: u128) -> String {
    (n * UNIT).to_string()
}

// ---- artifacts ----------------------------------------------------------------------------------

/// One built artifact. A path in its env var (CI builds the wasms once and passes them in) wins;
/// otherwise it is built on first use. Builds never overlap: they share one lock.
struct Artifact {
    env: &'static str,
    manifest: &'static str,
    features: Option<&'static str>,
    target_subdir: Option<&'static str>,
    cell: OnceCell<Vec<u8>>,
}

static BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The production contract: default features, exactly what `make build` ships.
static PROD: Artifact = Artifact {
    env: "PURSER_WASM_PROD",
    manifest: "Cargo.toml",
    features: None,
    target_subdir: None,
    cell: OnceCell::const_new(),
};
/// The test-only `fault-injection` build (settlement callback always dies). Its own target dir
/// under `contract/target`, so it never thrashes the production build's fingerprints.
static FAULT: Artifact = Artifact {
    env: "PURSER_WASM_FAULT",
    manifest: "Cargo.toml",
    features: Some("fault-injection"),
    target_subdir: Some("fault-injection"),
    cell: OnceCell::const_new(),
};
/// The `evm-spike` measurement build (EVM sighash feasibility spike). Its own target dir, like the fault build,
/// so it never thrashes the production fingerprints, and `no_abi` (set in `build_wasm`) so it can never touch
/// the ABI that `packages/types` is generated from.
static EVM: Artifact = Artifact {
    env: "PURSER_WASM_EVM",
    manifest: "Cargo.toml",
    features: Some("evm-spike"),
    target_subdir: Some("evm-spike"),
    cell: OnceCell::const_new(),
};
/// The race-driver fan-out fixture.
static DRIVER: Artifact = Artifact {
    env: "PURSER_WASM_DRIVER",
    manifest: "tests/fixtures/race-driver/Cargo.toml",
    features: None,
    target_subdir: Some("race-driver"),
    cell: OnceCell::const_new(),
};

/// The mock MPC signer fixture (TEST-ONLY; see tests/fixtures/mock-signer/README.md). Own target dir, the same
/// one the README command uses (`CARGO_TARGET_DIR=$PWD/target/mock-signer`), built `--locked --no-abi`.
static MOCK_SIGNER: Artifact = Artifact {
    env: "PURSER_WASM_MOCK_SIGNER",
    manifest: "tests/fixtures/mock-signer/Cargo.toml",
    features: None,
    target_subdir: Some("mock-signer"),
    cell: OnceCell::const_new(),
};

pub async fn mock_signer_wasm() -> &'static [u8] {
    MOCK_SIGNER.get().await
}
pub async fn prod_wasm() -> &'static [u8] {
    PROD.get().await
}
pub async fn fault_wasm() -> &'static [u8] {
    FAULT.get().await
}
pub async fn evm_wasm() -> &'static [u8] {
    EVM.get().await
}
pub async fn driver_wasm() -> &'static [u8] {
    DRIVER.get().await
}

impl Artifact {
    async fn get(&'static self) -> &'static [u8] {
        self.cell
            .get_or_init(|| async {
                if let Some(path) = std::env::var_os(self.env) {
                    return std::fs::read(&path)
                        .unwrap_or_else(|e| panic!("{}={path:?}: {e}", self.env));
                }
                let _serial = BUILD_LOCK.lock().await;
                tokio::task::spawn_blocking(move || {
                    build_wasm(self.manifest, self.features, self.target_subdir)
                })
                .await
                .expect("artifact build task")
            })
            .await
    }
}

fn build_wasm(manifest: &str, features: Option<&str>, target_subdir: Option<&str>) -> Vec<u8> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = Utf8PathBuf::from_path_buf(root.join(manifest)).expect("utf-8 manifest path");
    let target_dir = target_subdir.map(|d| root.join("target").join(d).display().to_string());
    let opts = BuildOpts {
        manifest_path: Some(manifest),
        features: features.map(str::to_string),
        // build.rs refuses the test-only features without an explicit opt-in; set only the one matching the
        // requested feature (build.rs also refuses the two features together)
        env: match features {
            Some("fault-injection") => {
                vec![("PURSER_ALLOW_FAULT_INJECTION".to_string(), "1".to_string())]
            }
            Some("evm-spike") => vec![("PURSER_ALLOW_EVM_SPIKE".to_string(), "1".to_string())],
            Some(other) => panic!("no build.rs opt-in known for feature {other:?}"),
            None => Vec::new(),
        },
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
                "task_id": TASK, "cap": units(cap_units), "token": "NearNative", "crew_cap": CREW_CAP,
            }))
            .gas(Gas::from_tgas(20)),
    );
    for d in delegates {
        batch = batch.call(
            Function::new("add_delegate")
                .args_json(json!({ "task_id": TASK, "account_id": d, "derivation_path": format!("m/{d}") }))
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
    let driver = worker.dev_deploy(driver_wasm().await).await?;
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

/// A delegate's `propose_payment` to the crew's merchant, not yet sent (`transact` or
/// `transact_async` it).
pub fn propose_tx(
    delegate: &Account,
    crew: &Crew,
    amount_units: u128,
    request_id: &str,
) -> near_workspaces::operations::CallTransaction {
    delegate
        .call(crew.purser.id(), "propose_payment")
        .args_json(propose_args(crew.merchant.id(), amount_units, request_id))
        .max_gas()
}

pub async fn propose(
    delegate: &Account,
    crew: &Crew,
    amount_units: u128,
    request_id: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(propose_tx(delegate, crew, amount_units, request_id)
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

/// One machine-readable observation for `scripts/metrics.sh` (format: `METRIC <name> <int> k=v ...`).
/// The aggregator rejects anything else, so every number in `docs/METRICS.md` comes through here.
pub fn metric(name: &str, value: i128, tags: &[(&str, &str)]) {
    let mut line = format!("METRIC {name} {value}");
    for (k, v) in tags {
        line.push_str(&format!(" {k}={v}"));
    }
    println!("{line}");
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
            .filter(|(_, a)| matches!(a, Admission::Refused(m) if *m == msg))
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

/// The only refusals a raced `propose_payment` leaf may end in (over budget, or the in-flight
/// retry). Anything else (out of gas, a driver error, another refusal) fails the test instead of
/// being counted as a refusal.
pub const EXPECTED_REFUSALS: &[&str] = &[
    purser_contract::MSG_EXCEEDS_BUDGET,
    purser_contract::MSG_IN_FLIGHT,
];

/// The block height a receipt executed at.
pub async fn height(worker: &Worker<Sandbox>, o: &ExecutionOutcome) -> anyhow::Result<u64> {
    Ok(worker.view_block().block_hash(o.block_hash).await?.height())
}

pub fn has_event(o: &ExecutionOutcome, event: &str) -> bool {
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
            let height = height(worker, o).await?;
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

// ---- EVM path (mock signer) ---------------------------------------------------------------------

/// Sepolia (the only chain id the contract accepts).
pub const SEPOLIA: u64 = 11_155_111;
/// Fee ceilings the EVM tests configure (wei per gas): an original is priced AT these.
pub const MAX_FEE: u128 = 100_000_000_000;
pub const MAX_TIP: u128 = 2_000_000_000;
/// The EVM test task's cap, in wei (5e15), and the value of a typical payment (1e15).
pub const EVM_CAP: u128 = 5_000_000_000_000_000;
pub const EVM_VALUE: u128 = 1_000_000_000_000_000;
/// A recipient that is not the lane's own address.
pub const EVM_TO: &str = "0x1111111111111111111111111111111111111111";

/// How far `evm_setup` takes the lane.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    /// cfg, EVM task, delegate and relayer only: no cached key.
    Bare,
    /// ... plus the derived key cached (lane exists, unseeded).
    Cached,
    /// ... plus `seed_evm_nonce(path, 7)`.
    Seeded,
}

pub const SEED_NONCE: u64 = 7;

pub struct EvmCrew {
    pub worker: Worker<Sandbox>,
    pub purser: Contract,
    pub signer: Contract,
    pub owner: Account,
    pub relayer: Account,
    pub delegate: Account,
    pub path: String,
}

/// Deploy the mock signer (its own account is its owner) and Purser pointed at it, then configure one EVM
/// task `t1` (cap [`EVM_CAP`] wei) with one delegate on `path` and a relayer. All account names come from
/// the same `dev_create_account` sequence, so identical setups cost identical gas (A/B measurements).
pub async fn evm_setup(
    worker: Worker<Sandbox>,
    path: &str,
    min_unknown_age_ns: u64,
    stage: Stage,
) -> anyhow::Result<EvmCrew> {
    let signer = worker.dev_deploy(mock_signer_wasm().await).await?;
    signer.call("new").transact().await?.into_result()?;
    let purser = worker.dev_deploy(prod_wasm().await).await?;
    let owner = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    let delegate = worker.dev_create_account().await?;
    purser
        .call("new")
        .args_json(json!({ "owner": owner.id(), "signer_id": signer.id() }))
        .transact()
        .await?
        .into_result()?;
    let tgas = |n| Gas::from_tgas(n);
    owner
        .batch(purser.id())
        .call(
            Function::new("create_task")
                .args_json(json!({
                    "task_id": TASK, "cap": EVM_CAP.to_string(), "token": "NearNative", "crew_cap": CREW_CAP,
                }))
                .gas(tgas(20)),
        )
        .call(
            Function::new("set_evm_cfg")
                .args_json(json!({
                    "chain_id": SEPOLIA.to_string(),
                    "max_fee_ceiling": MAX_FEE.to_string(),
                    "max_priority_ceiling": MAX_TIP.to_string(),
                    "min_value": "1000000000",
                    "min_unknown_age_ns": min_unknown_age_ns.to_string(),
                }))
                .gas(tgas(20)),
        )
        .call(
            Function::new("enable_evm_task")
                .args_json(json!({ "task_id": TASK }))
                .gas(tgas(20)),
        )
        .call(
            Function::new("add_delegate")
                .args_json(json!({ "task_id": TASK, "account_id": delegate.id(), "derivation_path": path }))
                .gas(tgas(20)),
        )
        .call(
            Function::new("set_relayer")
                .args_json(json!({ "relayer": relayer.id() }))
                .gas(tgas(20)),
        )
        .transact()
        .await?
        .into_result()?;
    let crew = EvmCrew {
        worker,
        purser,
        signer,
        owner,
        relayer,
        delegate,
        path: path.to_string(),
    };
    if stage != Stage::Bare {
        let _ = crew.cache_key().await?;
    }
    if stage == Stage::Seeded {
        crew.owner
            .call(crew.purser.id(), "seed_evm_nonce")
            .args_json(json!({ "path": path, "nonce": SEED_NONCE.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(crew)
}

impl EvmCrew {
    /// Owner caches the derived key (a real promise to the mock signer's view).
    pub async fn cache_key(&self) -> anyhow::Result<ExecutionFinalResult> {
        let res = self.cache_key_raw().await?;
        assert!(res.is_success(), "cache_derived_key: {:?}", res.failures());
        Ok(res)
    }

    /// `cache_derived_key` without asserting success (for refusal tests).
    pub async fn cache_key_raw(&self) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .owner
            .call(self.purser.id(), "cache_derived_key")
            .args_json(json!({ "task_id": TASK, "account_id": self.delegate.id() }))
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn set_mode(&self, mode: &str) -> anyhow::Result<()> {
        self.signer
            .call("set_mode")
            .args_json(json!({ "mode": mode }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.purser.view(method).args_json(args).await?.json()?)
    }

    /// `invariant` view; `holds` must be true unless the task is frozen. Returns `(completed, outstanding, frozen)`.
    pub async fn inv(&self) -> anyhow::Result<(u128, u128, bool)> {
        let v = self.view("invariant", json!({ "task_id": TASK })).await?;
        let n = |k: &str| v[k].as_str().unwrap().parse::<u128>().unwrap();
        let frozen = v["frozen"].as_bool().unwrap();
        assert!(
            v["holds"].as_bool().unwrap() || frozen,
            "INVARIANT (I) VIOLATED without a freeze: {v}"
        );
        Ok((n("completed"), n("outstanding"), frozen))
    }

    pub fn intent(&self, value: u128) -> Value {
        json!({
            "chain": { "Evm": { "chain_id": SEPOLIA } },
            "recipient": EVM_TO,
            "amount": value.to_string(),
            "token": "NearNative",
            "memo": null,
        })
    }

    /// The delegate's `propose_payment` with `gas_tgas` prepaid (300 = max).
    pub async fn propose(
        &self,
        value: u128,
        request_id: &str,
        gas_tgas: u64,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .delegate
            .call(self.purser.id(), "propose_payment")
            .args_json(
                json!({ "task": TASK, "request_id": request_id, "intent": self.intent(value) }),
            )
            .gas(Gas::from_tgas(gas_tgas))
            .transact()
            .await?)
    }

    /// Propose with max gas and require the whole receipt tree to succeed; returns the commitment id.
    pub async fn propose_ok(
        &self,
        value: u128,
        request_id: &str,
    ) -> anyhow::Result<(u64, ExecutionFinalResult)> {
        let res = self.propose(value, request_id, 300).await?;
        assert!(res.is_success(), "propose failed: {:?}", res.failures());
        let cid: u64 = res.clone().json()?;
        Ok((cid, res))
    }

    pub async fn commitment(&self, cid: u64) -> anyhow::Result<Value> {
        self.view("get_commitment", json!({ "commitment_id": cid }))
            .await
    }

    pub async fn state(&self, cid: u64) -> anyhow::Result<String> {
        Ok(self.commitment(cid).await?["state"]
            .as_str()
            .unwrap()
            .to_string())
    }

    pub async fn signed_tx(&self, cid: u64) -> anyhow::Result<Value> {
        self.view("get_signed_tx", json!({ "commitment_id": cid }))
            .await
    }

    pub async fn lane(&self) -> anyhow::Result<Value> {
        self.view("evm_lane", json!({ "path": self.path })).await
    }

    /// A call from `who` (not yet awaited past `transact`).
    pub async fn call(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.purser.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    /// `attest_external` for `tx_hash` from `who`.
    pub async fn attest(
        &self,
        who: &Account,
        cid: u64,
        tx_hash: &str,
        success: bool,
        finality: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.call(
            who,
            "attest_external",
            json!({
                "commitment_id": cid,
                "tx_hash": tx_hash,
                "outcome": { "Landed": {
                    "success": success,
                    "finality": finality,
                    "block_number": "123",
                    "block_hash": format!("0x{}", "ab".repeat(32)),
                    "signature": null,
                }},
            }),
        )
        .await
    }

    /// Advance the sandbox by `blocks` blocks and return the new block timestamp (ns).
    pub async fn fast_forward(&self, blocks: u64) -> anyhow::Result<u64> {
        self.worker.fast_forward(blocks).await?;
        Ok(self.worker.view_block().await?.timestamp())
    }
}
