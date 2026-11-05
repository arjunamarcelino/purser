//! EVM sighash feasibility spike: sandbox gas measurements (docs/plans/2026-11-05-feat-evm-sighash-feasibility-spike-plan.md).
//! Only built with `--features evm-spike` (and `PURSER_ALLOW_EVM_SPIKE=1`); `make evm-spike` runs it.
//!
//! These tests establish MEASUREMENT VALIDITY (right digest out of the wasm, gas linear in the loop count,
//! the load tax measured on identical flows) and print the numbers. They deliberately do not encode the
//! GO / NO-GO thresholds: the verdict and its criteria live in docs/EVM-SPIKE.md.
#![cfg(feature = "evm-spike")]

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use serde_json::Value;
use sha3::{Digest, Keccak256};

/// Logged by the spike export; `contract/src/evm_spike.rs` keeps the canonical copy.
const EVM_SPIKE_MARKER: &str = "PURSER_EVM_SPIKE_MEASUREMENT_ONLY";

/// Length of the spike export input (mirrors `INPUT_LEN` in `contract/src/evm_spike.rs`, which is
/// `pub(crate)`; a wrong length makes the export panic, so a mismatch fails every call below).
const INPUT_LEN: usize = 96;

/// The binary input of the spike exports (see `contract/src/evm_spike.rs`).
fn input(tx: &Value, repeat: u32) -> Vec<u8> {
    let n = |k: &str| tx[k].as_str().unwrap().to_string();
    let mut b = Vec::with_capacity(INPUT_LEN);
    b.extend_from_slice(&n("chain_id").parse::<u64>().unwrap().to_be_bytes());
    b.extend_from_slice(&n("nonce").parse::<u64>().unwrap().to_be_bytes());
    b.extend_from_slice(
        &n("max_priority_fee_per_gas")
            .parse::<u128>()
            .unwrap()
            .to_be_bytes(),
    );
    b.extend_from_slice(&n("max_fee_per_gas").parse::<u128>().unwrap().to_be_bytes());
    b.extend_from_slice(&n("gas_limit").parse::<u64>().unwrap().to_be_bytes());
    b.extend_from_slice(&unhex(&n("to")));
    b.extend_from_slice(&n("value").parse::<u128>().unwrap().to_be_bytes());
    b.extend_from_slice(&repeat.to_be_bytes());
    assert_eq!(b.len(), INPUT_LEN, "test input layout");
    b
}

#[test]
fn the_marker_is_the_contracts_marker() {
    assert!(
        include_str!("../src/evm_spike.rs").contains(&format!(
            "pub const EVM_SPIKE_MARKER: &str = \"{EVM_SPIKE_MARKER}\";"
        )),
        "tests/evm_spike.rs marker differs from src/evm_spike.rs"
    );
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn vectors() -> Vec<Value> {
    let file: Value =
        serde_json::from_str(include_str!("fixtures/evm-spike-vectors.json")).unwrap();
    file["vectors"].as_array().unwrap().clone()
}

/// The reference loop, independent of the contract: parity `rlp` + `sha3`. This is the only copy of the
/// amortization fold rule (nonce + 1, value ^= digest[..16]) outside the contract's own `run`.
fn reference_digest(v: &Value, repeat: u32) -> Vec<u8> {
    let n = |k: &str| v[k].as_str().unwrap().to_string();
    let (chain_id, mut nonce) = (
        n("chain_id").parse::<u64>().unwrap(),
        n("nonce").parse::<u64>().unwrap(),
    );
    let (tip, cap, gas) = (
        n("max_priority_fee_per_gas").parse::<u128>().unwrap(),
        n("max_fee_per_gas").parse::<u128>().unwrap(),
        n("gas_limit").parse::<u64>().unwrap(),
    );
    let (to, mut value) = (unhex(&n("to")), n("value").parse::<u128>().unwrap());
    let mut digest = Vec::new();
    for _ in 0..repeat {
        let mut s = rlp::RlpStream::new_list(9);
        s.append(&chain_id)
            .append(&nonce)
            .append(&tip)
            .append(&cap)
            .append(&gas)
            .append(&to.as_slice())
            .append(&value)
            .append_empty_data()
            .begin_list(0);
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&s.out());
        digest = Keccak256::digest(&bytes).to_vec();
        nonce += 1;
        value ^= u128::from_be_bytes(digest[..16].try_into().unwrap());
    }
    digest
}

struct Measured {
    digest: Vec<u8>,
    /// gas burnt by the receipt that ran the export (identified by the spike marker log)
    receipt_gas: u64,
    /// the whole transaction, shown for comparison only (includes tx->receipt conversion and refunds)
    total_gas: u64,
}

async fn call_export(
    c: &near_workspaces::Contract,
    method: &str,
    input: Vec<u8>,
) -> anyhow::Result<Measured> {
    let res = c.call(method).args(input).max_gas().transact().await?;
    assert!(res.is_success(), "{method} failed: {:?}", res.failures());
    // The signer is the contract itself, so the refund receipt also executes on `c`. Identify the export's
    // receipt by the marker the export logs, and require exactly one.
    let marked: Vec<_> = res
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == *c.id() && o.logs.iter().any(|l| l == EVM_SPIKE_MARKER))
        .collect();
    assert_eq!(
        marked.len(),
        1,
        "exactly one receipt must carry the spike marker for {method}"
    );
    let receipt_gas = marked[0].gas_burnt.as_gas();
    let total_gas = res.total_gas_burnt.as_gas();
    Ok(Measured {
        digest: res.raw_bytes()?,
        receipt_gas,
        total_gas,
    })
}

#[tokio::test]
async fn spike_exports_return_the_reference_digest_and_gas_is_linear_in_the_loop_count(
) -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(evm_wasm().await).await?;
    let vs = vectors();
    let typical = &vs[0];

    // (1) Correctness of the wasm path itself: every viem/chainsig.js vector, and the looped rounds.
    for v in &vs {
        let m = call_export(&c, "evm_spike_sighash", input(v, 1)).await?;
        assert_eq!(
            m.digest,
            unhex(v["sighash"].as_str().unwrap()),
            "wasm digest != viem/chainsig.js for {}",
            v["name"]
        );
    }
    for n in [2u32, 3, 10, 100, 1000] {
        let m = call_export(&c, "evm_spike_sighash", input(typical, n)).await?;
        assert_eq!(
            m.digest,
            reference_digest(typical, n),
            "wasm digest != reference loop at repeat {n}"
        );
    }

    // (2) Gas: receipt gas for N in {1, 10, 100, 1000}; per-call = slope, fixed = intercept.
    let mut points: Vec<(u64, u64, u64)> = Vec::new(); // (N, sighash receipt gas, sighash total gas)
    for n in [1u32, 10, 100, 1000] {
        let m = call_export(&c, "evm_spike_sighash", input(typical, n)).await?;
        points.push((n as u64, m.receipt_gas, m.total_gas));
    }
    let slope = |a: usize, b: usize| {
        (points[b].1 as f64 - points[a].1 as f64) / (points[b].0 - points[a].0) as f64
    };
    let (s_10_100, s_100_1000, s_1_1000) = (slope(1, 2), slope(2, 3), slope(0, 3));
    let intercept = points[0].1 as f64 - s_1_1000;
    let tgas = |g: f64| g / 1e12;

    println!("\n== EVM sighash gas (sandbox, nearcore runtime config of the pinned sandbox) ==");
    println!("N      receipt gas (Tgas)   total tx gas (Tgas)");
    for (n, r, t) in &points {
        println!("{n:<6} {:>18.6} {:>20.6}", tgas(*r as f64), tgas(*t as f64));
    }
    println!(
        "per-sighash (slope 1..1000)   {:.9} Tgas = {:.0} gas",
        tgas(s_1_1000),
        s_1_1000
    );
    println!("per-sighash (slope 10..100)   {:.9} Tgas", tgas(s_10_100));
    println!("per-sighash (slope 100..1000) {:.9} Tgas", tgas(s_100_1000));
    println!("fixed intercept               {:.6} Tgas", tgas(intercept));

    // Measurement validity: the loop was not folded (gas grows with N) and is linear (slopes agree).
    assert!(
        points[3].1 > points[2].1 && points[2].1 > points[1].1 && points[1].1 > points[0].1,
        "receipt gas is not strictly increasing in N: {points:?}"
    );
    let rel = |a: f64, b: f64| ((a - b) / b).abs();
    assert!(
        rel(s_10_100, s_100_1000) < 0.05,
        "slopes 10..100 and 100..1000 differ by more than 5%: {s_10_100} vs {s_100_1000}"
    );
    Ok(())
}

/// What one `propose_payment` costs, split into its receipts, on a given wasm.
struct ProposeGas {
    total: u64,
    propose_receipt: u64,
    callback_receipt: u64,
}

fn split_propose(res: &ExecutionFinalResult, purser: &near_workspaces::AccountId) -> ProposeGas {
    assert!(
        res.is_success(),
        "propose_payment failed: {:?}",
        res.failures()
    );
    // Identify the contract's two receipts by the event each emits, not by order: propose_payment emits
    // payment_reserved, the settlement callback emits payment_confirmed.
    let has_event = |o: &near_workspaces::result::ExecutionOutcome, event: &str| {
        o.logs
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!("\"event\":\"{event}\"")))
    };
    let own: Vec<_> = res
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == *purser && o.gas_burnt.as_gas() > 0)
        .collect();
    assert_eq!(
        own.len(),
        2,
        "expected exactly the propose_payment and on_near_settled receipts on the contract, got {} with logs {:?}",
        own.len(),
        own.iter().map(|o| &o.logs).collect::<Vec<_>>()
    );
    let pick = |event: &str| {
        let hits: Vec<_> = own.iter().filter(|o| has_event(o, event)).collect();
        assert_eq!(
            hits.len(),
            1,
            "exactly one contract receipt must emit {event}"
        );
        hits[0].gas_burnt.as_gas()
    };
    ProposeGas {
        total: res.total_gas_burnt.as_gas(),
        propose_receipt: pick("payment_reserved"),
        callback_receipt: pick("payment_confirmed"),
    }
}

/// The same crew on `wasm`, under FIXED account names (`purser.test.near`, `owner.test.near`, ...). Events
/// embed account ids and logs are charged per byte, so random dev-account names would put name-length noise
/// into the very difference being measured. With identical names the two wasms differ in nothing else.
async fn measure_propose(wasm: &[u8], rounds: usize) -> anyhow::Result<Vec<ProposeGas>> {
    use near_workspaces::types::{Gas, NearToken};
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str| {
        let root = root.clone();
        async move {
            anyhow::Ok(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_near(50))
                    .transact()
                    .await?
                    .into_result()?,
            )
        }
    };
    let (owner, delegate, merchant, purser_acct) = (
        sub("owner").await?,
        sub("delegate").await?,
        sub("merchant").await?,
        sub("purser").await?,
    );
    let purser = purser_acct.deploy(wasm).await?.into_result()?;
    purser
        .call("new")
        .args_json(
            serde_json::json!({ "owner": owner.id(), "signer_id": "v1.signer-prod.testnet" }),
        )
        .transact()
        .await?
        .into_result()?;
    owner
        .batch(purser.id())
        .call(near_workspaces::operations::Function::new("create_task").args_json(serde_json::json!({ "task_id": TASK, "cap": units(100), "token": "NearNative", "crew_cap": CREW_CAP })).gas(Gas::from_tgas(20)))
        .call(near_workspaces::operations::Function::new("add_delegate").args_json(serde_json::json!({ "task_id": TASK, "account_id": delegate.id(), "derivation_path": "m/0" })).gas(Gas::from_tgas(20)))
        .call(near_workspaces::operations::Function::new("set_recipient_allowlist").args_json(serde_json::json!({ "task_id": TASK, "recipients": [merchant.id()] })).gas(Gas::from_tgas(20)))
        .transact()
        .await?
        .into_result()?;
    let crew = Crew {
        worker,
        purser,
        owner,
        merchant,
    };
    let mut out = Vec::new();
    for i in 0..rounds {
        let res = propose(&delegate, &crew, 1, &format!("load-tax-{i}")).await?;
        out.push(split_propose(&res, crew.purser.id()));
    }
    Ok(out)
}

#[tokio::test]
async fn load_tax_the_spike_wasm_adds_to_existing_methods_when_the_feature_is_unused(
) -> anyhow::Result<()> {
    let base = measure_propose(prod_wasm().await, 3).await?;
    let spike = measure_propose(evm_wasm().await, 3).await?;
    let sizes = (prod_wasm().await.len(), evm_wasm().await.len());

    // Round i on the baseline vs round i on the spike wasm is the same flow. Report every round.
    let d = |x: u64, y: u64| x as i64 - y as i64;
    println!("\n== Load tax on existing methods (same flow, feature unused) ==");
    println!(
        "wasm bytes   baseline {} / evm-spike {} (delta {})",
        sizes.0,
        sizes.1,
        sizes.1 as i64 - sizes.0 as i64
    );
    println!("round  propose_payment (base / spike / delta gas)     on_near_settled (base / spike / delta gas)");
    for (i, (b, s)) in base.iter().zip(&spike).enumerate() {
        println!(
            "{i:<6} {:>13} {:>13} {:>10}      {:>13} {:>13} {:>10}",
            b.propose_receipt,
            s.propose_receipt,
            d(s.propose_receipt, b.propose_receipt),
            b.callback_receipt,
            s.callback_receipt,
            d(s.callback_receipt, b.callback_receipt)
        );
    }
    let (b, s) = (&base[1], &spike[1]); // a steady-state round
    println!("steady state (round 1): propose_payment +{:.6} Tgas on {:.3} Tgas (budget 50); on_near_settled +{:.6} Tgas on {:.3} Tgas (budget 10); whole tx +{} gas", d(s.propose_receipt, b.propose_receipt) as f64 / 1e12, b.propose_receipt as f64 / 1e12, d(s.callback_receipt, b.callback_receipt) as f64 / 1e12, b.callback_receipt as f64 / 1e12, d(s.total, b.total));
    let taxes: Vec<(i64, i64)> = base
        .iter()
        .zip(&spike)
        .map(|(b, s)| {
            (
                d(s.propose_receipt, b.propose_receipt),
                d(s.callback_receipt, b.callback_receipt),
            )
        })
        .collect();
    // Same names, same flow: the only difference is the wasm, so the tax is exact and identical every round.
    assert!(
        taxes.iter().all(|t| *t == taxes[0]),
        "with identical account names the load tax must be identical every round: {taxes:?}"
    );
    println!(
        "load tax (exact, every round): propose_payment +{} gas, on_near_settled +{} gas",
        taxes[0].0, taxes[0].1
    );
    Ok(())
}
