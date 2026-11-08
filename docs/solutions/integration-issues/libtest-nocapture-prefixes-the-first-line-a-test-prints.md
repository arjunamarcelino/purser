---
title: "cargo test -- --nocapture glues 'test name ... ' onto the first line a test prints, so a line-anchored METRIC parser misses it"
category: integration-issues
date: 2026-11-06
tags: [libtest, nocapture, log-parsing, metrics, test-threads, harness, purser]
module: scripts/metrics-report.mjs, scripts/metrics.sh, contract/tests/metrics.rs
symptom: "The aggregator failed closed with 'required metric count.overrun absent in metrics-1.log' although the log contained the line. A second symptom: the racing cases showed 'no race.attempts emitted' in METRICS.md although the tests emit it."
root_cause: "libtest prints 'test <name> ... ' with no newline before a test starts, so with --nocapture the test's FIRST println lands on the same line: 'test overruns_and_duplicates ... METRIC count.overrun 0 runs=5'. A parser anchored on ^METRIC skips exactly the first metric of every test. Separately, the per-case attack runs did not pass --nocapture, so their METRIC lines were captured and discarded."
status: resolved
verified: true
---

# Strip exactly libtest's prefix, nothing looser

```js
// scripts/metrics-report.mjs
const line = raw.replace(/\r$/, "").replace(/^test \S+ \.\.\. (?=METRIC )/, "");
```

Keep the rest of the parser strict (`^METRIC ([a-z_.]+) (-?\d+) ?(.*)$`) so a lookalike such as
`test x ... not a METRIC count.overrun 7` is NOT accepted; there is a unit test for both directions.

## The other half

- Run each attack case with `-- --exact <name> --nocapture` and append its `METRIC` lines to that repeat's metrics
  log, or per-case values (race attempts) never reach the report.
- `--test-threads=1` for anything that samples wall-clock; with several test threads the first-line glue also
  interleaves output from different tests.
- `docs/METRICS.md` said 'no race.attempts emitted' and the run still passed: a missing OPTIONAL metric is silent.
  If a number is meant to be in the report, make its absence an error or a visible row, as done for the required ones.

## Prevention

- Feed the parser a captured real log in a fixture test, not only hand-written lines.
- Fail closed on a missing required metric (it did here; that is how this was found).
