# Purser metrics

Everything below is **measured on our harness**: a local near-workspaces sandbox, not testnet or mainnet. Block times, gas and latency on a live network will differ. Nothing here is an audit or a proof; it is the observed behavior of the shipped wasm under the listed workload.

Reproduce: `make metrics` (from a clean checkout; `QUICK=1 make metrics` for a short run).

## Run header

| Field | Value |
|---|---|
| git sha | `62c406c866e120282458a28fe20bdea585bdfcde (dirty tree)` |
| wasm sha256 | `55d40b073e6b5a0f2bae878bf35fe4f68fd85d22213b6395ef59b466f6281fe4` |
| nearcore / workspaces | `nearcore 2.14.0 sandbox (near-workspaces 0.24.0)` |
| toolchain | `rustc 1.95.0 (59807616e 2026-04-14); cargo-near-near 0.22.0; node v26.9.0` |
| date | `2026-11-06T09:43:10.839Z` |
| repeats (N) | `10` |
| mode | `full` |

## Safety counters (must all be zero)

| Counter | Total | Over | What it counts |
|---|---|---|---|
| `count.overrun` | 0 | 50 runs across 10 run(s) | merchant balance deltas vs cap, cross-checked against payment_confirmed receipts |
| `count.duplicate` | 0 | 150 pairs across 10 run(s) | (delegate, request_id) pairs: payment_reserved events and merchant transfers vs distinct ids |
| `count.wrongly_blocked` | 0 | 400 valid across 10 run(s) | valid serial requests refused (valid/hostile tagged at generation) |

Not counted: anything outside the generated workload, other chains, or a hostile owner. Oracles are independent of the contract's own accounting view, so a bug there cannot hide itself.

## Timeout behavior

| Metric | Total | Samples | Meaning |
|---|---|---|---|
| `timeout.release_on_silence` | 0 | 10 | reservations released although no outcome was known (expected 0) |
| `timeout.duplicate_on_retry` | 0 | 10 | duplicate payments after retry past the timeout (expected 0) |
| `timeout.reservation_retained` | 10 | 10 | 1 = reservation kept on an unknown outcome (expected 1 each run) |

## Attack suite (each case run alone, N times)

Core cases must pass N/N. Racing cases (2b/4b) depend on real scheduling; their attempt counts are shown and any failure is disclosed here, not hidden.

| Case | Passed | Kind |
|---|---|---|
| `case_1_three_delegates_legit_purchases_succeed` | 10/10 | core |
| `case_2_concurrent_overbudget_exactly_floor_r_over_a_admitted` | 10/10 | core |
| `case_3_retry_after_completion_no_duplicate` | 10/10 | core |
| `case_4_retry_while_in_flight_returns_in_flight` | 10/10 | core |
| `case_5_tampered_recipient_rejected` | 10/10 | core |
| `case_6_revoked_delegate_blocked` | 10/10 | core |
| `case_7_timeout_on_issued_payment_reservation_retained` | 10/10 | core |
| `case_8_reconcile_cannot_race_live_callback` | 10/10 | core |
| `fault_hook_absent_from_production_wasm` | 10/10 | guard |

| Racing case | Passed | Attempts needed (n, min / median / p95 / max) |
|---|---|---|
| `case_2b_external_parallel_dispatch_races` | 10/10 | no race.attempts emitted |
| `case_4b_external_in_flight_retry` | 10/10 | no race.attempts emitted |

## Gas (NEAR path)

Rounds before 3 are dropped as warm-up. Units are gas burnt.

| Receipt | n | min | median | p95 | max |
|---|---|---|---|---|---|
| propose_payment receipt (NEAR) | 30 | 3,512,109,812,776 | 3,513,398,250,487 | 3,513,398,250,487 | 3,513,398,250,487 |
| on_near_settled receipt (NEAR) | 30 | 2,220,187,027,607 | 2,222,467,027,607 | 2,224,747,027,607 | 2,224,747,027,607 |
| sum of the two (per-run medians) | 10 | 5,735,865,278,094 | 5,735,865,278,094 | 5,735,865,278,094 | 5,735,865,278,094 |

Counts: gas burnt by the propose receipt and the `on_near_settled` receipt. Does not count: the transfer receipt itself, tx-to-receipt conversion, or attached-gas prepay.

## Latency (sandbox, not testnet)

Blocks from admission to settlement (from receipt heights): median 2, p95 2, range 2 to 2 (n=50).

| Arm | n | min ms | median ms | p95 ms | max ms |
|---|---|---|---|---|---|
| propose_payment | 300 | 602 | 624 | 645 | 662 |
| baseline transfer | 300 | 348 | 370 | 385 | 407 |

Added wall time = median(propose) - median(baseline) = **254 ms** (sandbox). Sandbox wall-clock is dominated by block time and polling, so read the block count above as the honest figure. No means are reported.

## Storage

Bytes per admitted commitment: median 375, range 375 to 375 (n=50). Counts the commitment record; the idempotency entry and the owner-paid stake are described in the README limits.

## Property tests (run once)

| Test | Cases run (emitted by the test) |
|---|---|
| `core` | 10,000 |
| `contract` | 2,000 |

libtest: `test result: ok. 3 passed; 0 failed`

## What this does not show

- Testnet or mainnet behavior, real block times, or real signer latency.
- Behavior of a deployed contract other than the wasm hashed above.
- Absence of bugs outside the generated workload.
