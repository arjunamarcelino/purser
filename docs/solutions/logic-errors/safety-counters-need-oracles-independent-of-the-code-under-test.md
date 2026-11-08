---
title: "Counting invariant violations through a view that asserts the invariant always reads zero; use independent oracles and refuse vacuous zeros"
category: logic-errors
date: 2026-11-06
tags: [metrics, oracle, tautology, overrun, duplicate, wrongly-blocked, fail-closed, denominator, purser]
module: contract/tests/metrics.rs, scripts/metrics-report.mjs
symptom: "Planning a metrics harness for 'budget overruns = 0', the natural implementation counted runs where completed + outstanding > cap using common::accounting(), which already asserts the invariant and panics on a violation. A review of the aggregator then found a counter of 0 over a denominator of 0 passed."
root_cause: "A check that can only pass proves nothing. Reading the contract's own counters to judge the contract is circular, and a zero over an empty sample is not evidence."
status: resolved
verified: true
---

# Each safety number needs a second, independent source

| Counter | Independent oracle | Not the oracle |
|---|---|---|
| Overruns | the merchant's actual **balance delta** vs the cap, cross-checked with the count of `payment_confirmed` events | `invariant`/`get_task` views |
| Duplicates | `payment_reserved` events per `(delegate, request_id)` and merchant transfers (`delta / amount`) vs distinct ids; expect exactly 1 each | the idempotency view |
| Wrongly blocked | valid/hostile tagged at generation time from a model outside the contract; count refusals of the valid class | whether the call succeeded |

Make "wrongly blocked" meaningful: keep valid requests **serial** and put only hostile ones in the race, otherwise a
legitimate over-budget refusal is miscounted. Interleave hostile requests (non-delegate caller, non-allowlisted
recipient) and assert they ARE refused, so a zero cannot be bought by loosening the gate. Fix the workload size and
print the totals ("0 of 400").

## Fail closed on vacuous passes (aggregator)

- A counter's denominator must be present, an integer and > 0; `0 over 0 runs` throws.
- `count.*` and `timeout.*` metrics must have exactly one sample per run, so a duplicated or dropped log line cannot
  hide a failure.
- `proptest.cases` must exist for both blocks and be > 0, and (see the proptest doc) be observed, not configured.
- Write the report and `docs/METRICS.json` atomically, and only if every check passed.

## Related

- `docs/solutions/performance-issues/sandbox-gas-measurement-pitfalls.md` for the gas and latency half of the harness
  (per-receipt `gas_burnt`, fixed account names, round >= 3, interleaved A/B for latency).
