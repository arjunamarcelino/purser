//! Refuse to compile the test-only `fault-injection` and `evm-spike` features unless the build explicitly opts in,
//! so `--all-features`, feature unification, or a stray manual build can never produce the
//! fault-injected wasm by accident. The attack suite opts in via `PURSER_ALLOW_FAULT_INJECTION=1`.

fn main() {
    println!("cargo:rerun-if-env-changed=PURSER_ALLOW_FAULT_INJECTION");
    println!("cargo:rerun-if-env-changed=PURSER_ALLOW_EVM_SPIKE");
    let spike = std::env::var_os("CARGO_FEATURE_EVM_SPIKE").is_some();
    let spike_allowed = std::env::var("PURSER_ALLOW_EVM_SPIKE").as_deref() == Ok("1");
    if spike && !spike_allowed {
        panic!(
            "the `evm-spike` feature is a MEASUREMENT-ONLY feasibility spike (it exports an EVM sighash \
             harness); set PURSER_ALLOW_EVM_SPIKE=1 to build it on purpose"
        );
    }
    if spike && std::env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some() {
        panic!("`evm-spike` and `fault-injection` are separate measurement builds; do not combine them");
    }
    let fault = std::env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some();
    let allowed = std::env::var("PURSER_ALLOW_FAULT_INJECTION").as_deref() == Ok("1");
    if fault && !allowed {
        panic!(
            "the `fault-injection` feature is TEST-ONLY (it kills the settlement callback); \
             set PURSER_ALLOW_FAULT_INJECTION=1 to build it on purpose"
        );
    }
}
