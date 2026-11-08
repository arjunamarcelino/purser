---
title: "ProptestConfig::with_cases(n) overrides PROPTEST_CASES, so the documented env override (and CI's 256 / 20000 runs) did nothing"
category: logic-errors
date: 2026-11-06
tags: [proptest, PROPTEST_CASES, ci, property-tests, metrics, observed-vs-configured, purser]
module: contract/tests/properties.rs, .github/workflows/ci.yml, scripts/metrics-report.mjs
symptom: "properties.rs said 'PROPTEST_CASES overrides' the case counts and CI ran it with PROPTEST_CASES=256 (PR) and 20000 (nightly). Reading the config showed both blocks hard-coded with_cases(10_000) and with_cases(2_000), and nothing read the variable."
root_cause: "ProptestConfig::default() reads PROPTEST_CASES, but with_cases(n) builds the config with an explicit cases field, which wins. The override never applied, so the PR run was not the quick run it claimed and the nightly 'deep' run was not deeper."
status: resolved
verified: true
---

# The env var was a silent no-op; the number printed was only the configured one

## Fix

```rust
fn cases(default: u32) -> u32 {
    match std::env::var("PROPTEST_CASES") {
        Err(_) => default,
        Ok(v) => v.parse::<u32>().ok().filter(|n| *n > 0)
            .unwrap_or_else(|| panic!("PROPTEST_CASES must be a positive integer, got {v:?}")),
    }
}
proptest! { #![proptest_config(ProptestConfig::with_cases(cases(10_000)))] /* ... */ }
```

A malformed or zero value now fails loudly instead of silently falling back to the default.

## Report what ran, not what was asked for

The first harness printed `METRIC proptest.cases` from `cases()` in a separate test, which makes "invariant held
over 10,000 sequences" circular: it is the configured number, whether or not the blocks ran. Each property block now
increments an `AtomicU64` in the test body, and the emit step asserts the observed count equals the configured count
**plus the replayed seeds** in `properties.proptest-regressions` before printing. With two saved seeds the published
numbers are **10,002 and 2,002**, which is the honest figure.

## A side find

A fresh seed at cap = `u128::MAX / 2` made the REFERENCE MODEL (not the contract) overflow: two contradicted spends
push `completed + outstanding` past `u128::MAX`. The contract's checked arithmetic refuses atomically
(`ArithmeticOverflow`); the model now predicts that refusal, the seed is pinned, and `used()` saturates because every
caller only compares it to the cap.

## Prevention

- Any "env var overrides the default" claim needs a test or a printed observed value that proves it.
- Count executions in the test body; never print the configuration as if it were the result.
