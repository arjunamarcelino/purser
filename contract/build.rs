//! Refuse to compile the test-only `fault-injection` feature unless the build explicitly opts in,
//! so `--all-features`, feature unification, or a stray manual build can never produce the
//! fault-injected wasm by accident. The attack suite opts in via `PURSER_ALLOW_FAULT_INJECTION=1`.

fn main() {
    println!("cargo:rerun-if-env-changed=PURSER_ALLOW_FAULT_INJECTION");
    let fault = std::env::var_os("CARGO_FEATURE_FAULT_INJECTION").is_some();
    let allowed = std::env::var("PURSER_ALLOW_FAULT_INJECTION").as_deref() == Ok("1");
    if fault && !allowed {
        panic!(
            "the `fault-injection` feature is TEST-ONLY (it kills the settlement callback); \
             set PURSER_ALLOW_FAULT_INJECTION=1 to build it on purpose"
        );
    }
}
