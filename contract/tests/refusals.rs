//! Every refusal string in `error.rs` is asserted through a real entrypoint, or is explicitly listed as
//! covered only by a named unit test.
//!
//! Each test compares the failure against the spec constant `purser_contract::MSG_*` (never against a
//! string the function under test produced) and then proves the refusal changed nothing: task
//! accounting, the commitment ledger and the idempotency entry are identical before and after.
//!
//! `every_refusal_message_has_a_test` requires each constant to appear in an asserting statement
//! (`refused(..)`, `assert!`/`assert_eq!`, `.contains(..)`, `matches!`, `==`), not merely be imported or
//! mentioned; `coverage_rule_rejects_bare_imports_and_non_assertions` proves the rule. It derives the constant list by scanning `src/error.rs`, so a new
//! `pub const MSG_*` without a test (or a justified `UNIT_COVERED` entry) fails the build.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use purser_contract::{
    MSG_EVM_BAD_CFG, MSG_EVM_INVALID_FEE, MSG_EVM_NOT_CONFIGURED, MSG_INVALID_REQUEST_ID,
    MSG_MEMO_TOO_LONG, MSG_NOT_EVM_COMMITMENT, MSG_NOT_EVM_TASK, MSG_REQUEST_ID_REUSED,
};
use serde_json::{json, Value};

/// `cfg.min_unknown_age_ns`: the contract's 5 minute floor.
const AGE_NS: u64 = 300 * 1_000_000_000;

fn refused(res: ExecutionFinalResult, msg: &str) {
    assert!(res.is_failure(), "expected a refusal containing {msg:?}");
    let e = err_string(res);
    assert!(e.contains(msg), "expected {msg:?} in: {e}");
}

// ---- NEAR-native crew ---------------------------------------------------------------------------

struct Near {
    crew: Crew,
    delegate: near_workspaces::Account,
}

async fn near_crew() -> anyhow::Result<Near> {
    let w = near_workspaces::sandbox().await?;
    let owner = w.dev_create_account().await?;
    let delegate = w.dev_create_account().await?;
    let crew = setup(w, prod_wasm().await, owner, 100, &[delegate.id()]).await?;
    Ok(Near { crew, delegate })
}

impl Near {
    /// Everything a refusal must not change: both tasks, the whole commitment ledger, and the
    /// idempotency entries for `rids`.
    async fn snapshot(&self, rids: &[&str]) -> anyhow::Result<Value> {
        let mut idem = vec![];
        for r in rids {
            idem.push(
                view(
                    &self.crew,
                    "get_idempotency",
                    json!({ "account_id": self.delegate.id(), "request_id": r }),
                )
                .await?,
            );
        }
        let mut ledger = vec![];
        for t in [TASK, "t2"] {
            ledger.push(
                view(
                    &self.crew,
                    "list_commitments",
                    json!({ "task_id": t, "from_index": 0, "limit": 100 }),
                )
                .await?,
            );
        }
        Ok(json!({
            "t1": task(&self.crew).await?,
            "t2": view(&self.crew, "get_task", json!({ "task_id": "t2" })).await?,
            "ledger": ledger,
            "idem": idem,
        }))
    }

    async fn propose_intent(
        &self,
        task: &str,
        request_id: &str,
        intent: Value,
        gas_tgas: u64,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .delegate
            .call(self.crew.purser.id(), "propose_payment")
            .args_json(json!({ "task": task, "request_id": request_id, "intent": intent }))
            .gas(near_sdk::Gas::from_tgas(gas_tgas))
            .transact()
            .await?)
    }

    fn intent(&self, units_n: u128) -> Value {
        propose_args(self.crew.merchant.id(), units_n, "x")["intent"].clone()
    }

    async fn owner_call(&self, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .crew
            .owner
            .call(self.crew.purser.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    /// A second task `t2` with the same delegate (own path) and the merchant allowlisted.
    async fn add_second_task(&self) -> anyhow::Result<()> {
        for (m, a) in [
            (
                "create_task",
                json!({ "task_id": "t2", "cap": units(100), "token": "NearNative", "crew_cap": 3 }),
            ),
            (
                "add_delegate",
                json!({ "task_id": "t2", "account_id": self.delegate.id(), "derivation_path": "m/second" }),
            ),
            (
                "set_recipient_allowlist",
                json!({ "task_id": "t2", "recipients": [self.crew.merchant.id()] }),
            ),
        ] {
            let res = self.owner_call(m, a).await?;
            assert!(res.is_success(), "{m}: {:?}", res.failures());
        }
        Ok(())
    }
}

#[tokio::test]
async fn near_entrypoint_refusals_assert_the_spec_string_and_change_nothing() -> anyhow::Result<()>
{
    let n = Near::from_ready().await?;
    let rids = ["good-1", "memo-1"];

    // a first real payment on t1 so replays and unknown-chain checks have something to hit
    let ok = n.propose_intent(TASK, "good-1", n.intent(10), 300).await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    assert_eq!(accounting(&n.crew).await?, (10 * UNIT, 0));

    // request_id too short / too long: refused before any lookup
    let before = n.snapshot(&rids).await?;
    for bad in [String::new(), "r".repeat(65)] {
        refused(
            n.propose_intent(TASK, &bad, n.intent(1), 300).await?,
            MSG_INVALID_REQUEST_ID,
        );
    }
    assert_eq!(n.snapshot(&rids).await?, before);
    // the boundary itself is accepted (64 chars)
    let edge = "e".repeat(64);
    let res = n.propose_intent(TASK, &edge, n.intent(1), 300).await?;
    assert!(res.is_success(), "{:?}", res.failures());

    // memo one byte over the 256 limit
    let before = n.snapshot(&rids).await?;
    let mut intent = n.intent(1);
    intent["memo"] = json!("m".repeat(257));
    refused(
        n.propose_intent(TASK, "memo-1", intent, 300).await?,
        MSG_MEMO_TOO_LONG,
    );
    assert_eq!(n.snapshot(&rids).await?, before);

    // the same request_id replayed against a DIFFERENT task is never reported as success
    let before = n.snapshot(&rids).await?;
    refused(
        n.propose_intent("t2", "good-1", n.intent(10), 300).await?,
        MSG_REQUEST_ID_REUSED,
    );
    assert_eq!(n.snapshot(&rids).await?, before);
    // ...and neither is a replay on the right task with a different amount
    refused(
        n.propose_intent(TASK, "good-1", n.intent(11), 300).await?,
        MSG_REQUEST_ID_REUSED,
    );
    assert_eq!(n.snapshot(&rids).await?, before);
    // the genuine replay still returns the original commitment (the refusals did not disturb it)
    let replay = n.propose_intent(TASK, "good-1", n.intent(10), 300).await?;
    assert!(replay.is_success(), "{:?}", replay.failures());
    assert_eq!(replay.json::<u64>()?, 0);
    assert_eq!(n.snapshot(&rids).await?, before);

    // an EVM-only entrypoint pointed at a NEAR commitment
    let before = n.snapshot(&rids).await?;
    refused(
        n.owner_call("mark_unknown", json!({ "commitment_id": 0 }))
            .await?,
        MSG_NOT_EVM_COMMITMENT,
    );
    refused(
        n.owner_call(
            "attest_external",
            json!({
                "commitment_id": 0,
                "tx_hash": format!("0x{}", "cd".repeat(32)),
                "outcome": { "Landed": {
                    "success": true, "finality": "Finalized", "block_number": "1",
                    "block_hash": format!("0x{}", "ab".repeat(32)), "signature": null,
                }},
            }),
        )
        .await?,
        MSG_NOT_EVM_COMMITMENT,
    );
    assert_eq!(n.snapshot(&rids).await?, before);

    // EVM setup on a contract that was never configured
    refused(
        n.owner_call(
            "cache_derived_key",
            json!({ "task_id": TASK, "account_id": n.delegate.id() }),
        )
        .await?,
        MSG_EVM_NOT_CONFIGURED,
    );
    assert!(n
        .crew
        .purser
        .view("get_evm_cfg")
        .await?
        .json::<Value>()?
        .is_null());
    assert_eq!(n.snapshot(&rids).await?, before);
    Ok(())
}

impl Near {
    /// `near_crew` plus the second task.
    async fn from_ready() -> anyhow::Result<Near> {
        let n = near_crew().await?;
        n.add_second_task().await?;
        Ok(n)
    }
}

/// Too little prepaid gas for the reserve plus its settlement callback: the call fails and nothing
/// stays reserved, so the same request id is still usable afterwards.
#[tokio::test]
async fn a_near_proposal_with_too_little_gas_fails_and_reserves_nothing() -> anyhow::Result<()> {
    let n = near_crew().await?;
    let rids = ["gas-1"];
    let before = n.snapshot(&rids).await?;
    for tgas in [5, 12] {
        let res = n.propose_intent(TASK, "gas-1", n.intent(10), tgas).await?;
        assert!(res.is_failure(), "{tgas} Tgas must not be enough");
    }
    // give any stray receipt time to land, then compare
    n.crew.worker.fast_forward(5).await?;
    assert_eq!(n.snapshot(&rids).await?, before);
    assert_eq!(accounting(&n.crew).await?, (0, 0));

    let res = n.propose_intent(TASK, "gas-1", n.intent(10), 300).await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(accounting(&n.crew).await?, (10 * UNIT, 0));
    Ok(())
}

/// `on_near_settled` is `#[private]`: only the contract's own promise can reach it, and the one
/// `IllegalTransition` arm in it (a state other than Reserved/Confirmed/Failed) cannot be produced
/// for a NEAR-native commitment. A direct call is refused and moves nothing.
#[tokio::test]
async fn on_near_settled_cannot_be_called_directly() -> anyhow::Result<()> {
    let n = near_crew().await?;
    let ok = n.propose_intent(TASK, "good-1", n.intent(10), 300).await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    let before = n.snapshot(&["good-1"]).await?;
    for caller in [&n.crew.owner, &n.delegate] {
        let res = caller
            .call(n.crew.purser.id(), "on_near_settled")
            .args_json(json!({ "cid": 0, "request_id": "good-1" }))
            .max_gas()
            .transact()
            .await?;
        refused(res, "Method on_near_settled is private");
    }
    assert_eq!(n.snapshot(&["good-1"]).await?, before);
    Ok(())
}

// ---- EVM crew -----------------------------------------------------------------------------------

async fn evm_cfg_json(c: &EvmCrew) -> anyhow::Result<Value> {
    c.view("get_evm_cfg", json!({})).await
}

#[tokio::test]
async fn evm_setup_and_fee_refusals_assert_the_spec_string_and_change_nothing() -> anyhow::Result<()>
{
    let c = evm_setup(
        near_workspaces::sandbox().await?,
        "evm/refusals",
        AGE_NS,
        Stage::Seeded,
    )
    .await?;

    // set_evm_cfg: each bad config is refused and the stored config is untouched
    let cfg_before = evm_cfg_json(&c).await?;
    assert!(!cfg_before.is_null());
    let good = json!({
        "chain_id": SEPOLIA.to_string(),
        "max_fee_ceiling": MAX_FEE.to_string(),
        "max_priority_ceiling": MAX_TIP.to_string(),
        "min_value": "1000000000",
        "min_unknown_age_ns": AGE_NS.to_string(),
    });
    let mut mainnet = good.clone();
    mainnet["chain_id"] = json!("1");
    let mut zero_tip = good.clone();
    zero_tip["max_priority_ceiling"] = json!("0");
    let mut tip_over_fee = good.clone();
    tip_over_fee["max_priority_ceiling"] = json!((MAX_FEE + 1).to_string());
    let mut zero_min = good.clone();
    zero_min["min_value"] = json!("0");
    let mut short_age = good.clone();
    short_age["min_unknown_age_ns"] = json!((AGE_NS - 1).to_string());
    for bad in [mainnet, zero_tip, tip_over_fee, zero_min, short_age] {
        refused(
            c.call(&c.owner, "set_evm_cfg", bad.clone()).await?,
            MSG_EVM_BAD_CFG,
        );
        assert_eq!(evm_cfg_json(&c).await?, cfg_before, "after {bad}");
    }

    // cache_derived_key for a task that is not an EVM task: no lane appears
    for (m, a) in [
        (
            "create_task",
            json!({ "task_id": "near-t", "cap": units(100), "token": "NearNative", "crew_cap": 3 }),
        ),
        (
            "add_delegate",
            json!({ "task_id": "near-t", "account_id": c.delegate.id(), "derivation_path": "evm/near-t" }),
        ),
    ] {
        let res = c.call(&c.owner, m, a).await?;
        assert!(res.is_success(), "{m}: {:?}", res.failures());
    }
    refused(
        c.call(
            &c.owner,
            "cache_derived_key",
            json!({ "task_id": "near-t", "account_id": c.delegate.id() }),
        )
        .await?,
        MSG_NOT_EVM_TASK,
    );
    assert!(c
        .view("evm_lane", json!({ "path": "evm/near-t" }))
        .await?
        .is_null());

    // a pending payment that ages into Unknown (the only state a cancel can start from)
    let (cid, _) = c.propose_ok(EVM_VALUE, "fee-1").await?;
    let signed_at: u64 = c.signed_tx(cid).await?["signed_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    let mut now = c.worker.view_block().await?.timestamp();
    while now < signed_at + AGE_NS + 1_000_000_000 {
        now = c.fast_forward(400).await?;
    }
    let res = c
        .call(&c.relayer, "mark_unknown", json!({ "commitment_id": cid }))
        .await?;
    assert!(res.is_success(), "{:?}", res.failures());
    assert_eq!(c.state(cid).await?, "Unknown");

    // a cancel priced at the original's fee does not carry the required +12.5% bump
    let commitment_before = c.commitment(cid).await?;
    let tx_before = c.signed_tx(cid).await?;
    refused(
        c.call(
            &c.relayer,
            "request_cancel",
            json!({
                "commitment_id": cid, "max_fee": MAX_FEE.to_string(), "tip": MAX_TIP.to_string(),
            }),
        )
        .await?,
        MSG_EVM_INVALID_FEE,
    );
    assert_eq!(c.commitment(cid).await?, commitment_before);
    assert_eq!(c.signed_tx(cid).await?, tx_before);
    assert!(tx_before["cancel"].is_null(), "no cancel was recorded");
    assert_eq!(c.inv().await?, (0, EVM_VALUE, false));
    Ok(())
}

// ---- meta-test ----------------------------------------------------------------------------------

// UNIT_COVERED-BEGIN
/// Refusals no entrypoint can produce, each with the unit test in `src/` that asserts it. The meta-test
/// checks that the named test function exists. Everything NOT listed here must be referenced by a
/// sandbox test.
const UNIT_COVERED: &[(&str, &str)] = &[
    (
        "MSG_SPENT_EXCEEDS",
        "src/budget.rs::settle_rejects_spent_over_reserved: both settle paths pass the commitment's own reserved amount as `spent`, so spent > reserved needs a corrupted ledger",
    ),
    (
        "MSG_ILLEGAL",
        "src/budget.rs::settle_rejects_illegal_sources: the only reachable-looking site is the final arm of on_near_settled, which is #[private] and sees only Reserved/Confirmed/Failed for a NEAR commitment (the other states exist only on the EVM path, which has its own callbacks)",
    ),
    (
        "MSG_EVM_SIGHASH_RANGE",
        "src/evm_tx.rs::sighash_must_be_a_secp256k1_scalar: needs a keccak output of zero or >= the curve order (probability about 2^-128), so no chosen input reaches it",
    ),
];
// UNIT_COVERED-END

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// True when `name` appears in `text` as a whole identifier.
fn mentions(text: &str, name: &str) -> bool {
    let t = text.as_bytes();
    text.match_indices(name).any(|(i, _)| {
        let before = i == 0 || !is_ident(t[i - 1]);
        let after = i + name.len() >= t.len() || !is_ident(t[i + name.len()]);
        before && after
    })
}

/// Strip `//` comments, honouring string literals (a `//` inside "..." is not a comment), so a
/// constant named only in prose does not count as covered and a URL in a string does not truncate.
fn code_only(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let (mut in_str, mut esc) = (false, false);
        let b = line.as_bytes();
        let mut end = b.len();
        for (i, &c) in b.iter().enumerate() {
            if in_str {
                if esc {
                    esc = false;
                } else if c == b'\\' {
                    esc = true;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
                end = i;
                break;
            }
        }
        out.push_str(&line[..end]);
        out.push('\n');
    }
    out
}

/// Index just past the delimiter that closes the one opened at `code[open]`.
fn close_of(code: &str, open: usize) -> Option<usize> {
    let b = code.as_bytes();
    let (o, c) = match b[open] {
        b'[' => (b'[', b']'),
        b'{' => (b'{', b'}'),
        _ => return None,
    };
    let mut depth = 0usize;
    for (i, &x) in b.iter().enumerate().skip(open) {
        if x == o {
            depth += 1;
        } else if x == c {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
    }
    None
}

const MARKERS: &[&str] = &[
    "assert!",
    "assert_eq!",
    "refused(",
    ".contains(",
    "matches!",
    "==",
];

/// True when `name` is used in an ASSERTING position somewhere in `code` (comments already stripped).
///
/// Rule, fail-closed. Either:
///  1. a `;`-terminated statement mentions the identifier, is not a `use` item, and contains an
///     assertion marker: `assert!`, `assert_eq!`, `refused(`, `.contains(`, `matches!` or `==`; or
///  2. a table loop `for .. in [ .. NAME .. ] { body }` lists it and the loop body contains a marker.
///
/// `assert_ne!`, a bare import, and a `let` binding alone satisfy neither.
fn asserts_on(code: &str, name: &str) -> bool {
    let stmt_rule = code.split(';').any(|stmt| {
        let t = stmt.trim_start();
        let is_use = t.starts_with("use ") || t.starts_with("pub use ") || t.contains("\nuse ");
        !is_use && mentions(stmt, name) && MARKERS.iter().any(|m| stmt.contains(m))
    });
    stmt_rule
        || code.match_indices("for ").any(|(i, _)| {
            let rest = &code[i..];
            let Some(br) = rest.find(" in [").map(|k| i + k + 4) else {
                return false;
            };
            let Some(arr_end) = close_of(code, br) else {
                return false;
            };
            let Some(body) = code[arr_end..].find('{').map(|k| arr_end + k) else {
                return false;
            };
            let Some(body_end) = close_of(code, body) else {
                return false;
            };
            // the header must be only `for <pattern> in [..]`: nothing but whitespace between `]` and `{`
            code[arr_end..body].trim().is_empty()
                && mentions(&code[br..arr_end], name)
                && MARKERS.iter().any(|m| code[body..body_end].contains(m))
        })
}

fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            // fixtures are separate crates, not tests of the contract's refusals
            if p.file_name().is_some_and(|n| n != "fixtures") {
                rs_files(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn every_refusal_message_has_a_test() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let error_rs = std::fs::read_to_string(root.join("src/error.rs")).unwrap();
    let consts: Vec<String> = error_rs
        .lines()
        .filter_map(|l| l.trim().strip_prefix("pub const MSG_"))
        .map(const_name)
        .collect();
    assert!(
        consts.len() > 40,
        "scan of src/error.rs found only {} constants: {consts:?}",
        consts.len()
    );

    let mut files = vec![];
    rs_files(&root.join("tests"), &mut files);
    let mut corpus = String::new();
    for f in &files {
        let mut text = std::fs::read_to_string(f).unwrap();
        if f.file_name().is_some_and(|n| n == "refusals.rs") {
            // this file's own tests count; its UNIT_COVERED table does not
            let (a, b) = (
                text.find("// UNIT_COVERED-BEGIN").unwrap(),
                text.find("// UNIT_COVERED-END").unwrap(),
            );
            text.replace_range(a..b, "");
        }
        corpus.push_str(&code_only(&text));
        corpus.push('\n');
    }

    let table: Vec<&str> = UNIT_COVERED.iter().map(|(c, _)| *c).collect();
    let mut uncovered = vec![];
    for c in &consts {
        if !asserts_on(&corpus, c) && !table.contains(&c.as_str()) {
            uncovered.push(c.clone());
        }
    }
    assert!(
        uncovered.is_empty(),
        "refusal messages with no test and no UNIT_COVERED entry: {uncovered:?}"
    );

    // the table may only name real constants, and each justification must name a unit test that exists
    for (name, why) in UNIT_COVERED {
        assert!(
            consts.iter().any(|c| c == name),
            "UNIT_COVERED names unknown {name}"
        );
        let spec = why
            .split(": ")
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let (file, func) = spec
            .split_once("::")
            .unwrap_or_else(|| panic!("{name}: justification must start with `path.rs::test_fn`"));
        let src = std::fs::read_to_string(root.join(file))
            .unwrap_or_else(|e| panic!("{name}: cannot read {file}: {e}"));
        assert!(
            src.contains(&format!("fn {func}()")),
            "{name}: unit test `{func}` not found in {file}"
        );
        assert!(
            mentions(&error_rs, name) && error_rs.matches(name).count() >= 2,
            "{name} must be wired into PurserError's Display or an entrypoint"
        );
    }
}

/// The identifier after `pub const MSG_` (the `MSG_` prefix is re-added by the caller's slice).
fn const_name(rest: &str) -> String {
    let end = rest
        .find(|c: char| !is_ident(c as u8))
        .unwrap_or(rest.len());
    format!("MSG_{}", &rest[..end])
}

/// The coverage rule must not be satisfiable by an import or a non-assertion mention.
#[test]
fn coverage_rule_rejects_bare_imports_and_non_assertions() {
    let synthetic = code_only(
        r#"
use purser_contract::{MSG_IMPORTED, MSG_BOUND, MSG_NEQ, MSG_PROSE};
// refused(res, MSG_PROSE);
fn t() {
    let url = "http://x"; let _unused = MSG_BOUND;
    assert_ne!(e, MSG_NEQ);
    refused(res, MSG_REAL);
    assert!(e.contains(MSG_SECOND));
    for (a, m) in [(1, MSG_LOOPED)] { assert!(e.contains(m)); }
    for (a, m) in [(1, MSG_LOOP_NOASSERT)] { let _ = m; }
}
"#,
    );
    for c in [
        "MSG_IMPORTED",
        "MSG_BOUND",
        "MSG_NEQ",
        "MSG_PROSE",
        "MSG_LOOP_NOASSERT",
    ] {
        assert!(!asserts_on(&synthetic, c), "{c} must not count as covered");
    }
    for c in ["MSG_REAL", "MSG_SECOND", "MSG_LOOPED"] {
        assert!(asserts_on(&synthetic, c), "{c} must count as covered");
    }
}
